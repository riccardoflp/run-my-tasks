import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { createGroupStorage, migrateLegacyGroups } from './groupStorage';
import { mergeGroup, parseGroups, serializeGroups } from './groupTransfer';
import {
  getLaunchConfigs,
  isLaunchRunning,
  runningLaunchNames,
  startLaunch,
  stopLaunch,
  trackDebugSessions,
} from './launchConfigs';
import {
  computeScopes,
  describeRef,
  entryRefFor,
  GroupScope,
  scopeAccepts,
  taskOrigin,
  workspaceFileLabel,
} from './projects';
import { ScmSelection } from './scmSelection';
import { createStatusBarItem } from './statusBar';
import { runningTaskKeys, taskKey, terminateTask, trackTaskStarts } from './taskIdentity';
import { showTaskPicker } from './taskPicker';
import { findTaskTerminal, runTask, TerminalLocation, trackTaskTerminals } from './taskTerminals';
import {
  createSharedState,
  dropCachedTasks,
  EntryKind,
  EntryTreeItem,
  groupEntries,
  groupLaunches,
  groupsOf,
  GroupScopeItem,
  groupTasks,
  loadTasks,
  pickGroup,
  resolveLaunch,
  resolveTask,
  scopeById,
  SharedState,
  GroupsDragController,
  GroupsTreeProvider,
  LaunchDragController,
  LaunchTreeItem,
  LaunchTreeProvider,
  setGroups,
  showsProjects,
  TasksDragController,
  TasksTreeProvider,
  TaskTreeItem,
  VirtualGroup,
  VirtualGroupItem,
} from './taskTreeProvider';

// Tells launch configurations from tasks in the pickers listing both
const LAUNCH_LABEL = 'Launch Configuration';

// An entry to add to a group: its kind, name and folder
interface NewEntry { kind: EntryKind; name: string; folder: vscode.WorkspaceFolder | undefined; }
// An entry of a group: its kind and the ref the group stores
interface GroupEntry { kind: EntryKind; ref: string; }

interface EntryQuickPickItem<T> extends vscode.QuickPickItem {
  entry: T;
}

// What Import Groups does with an imported group named as an existing one
const IMPORT_CONFLICT_CHOICES: vscode.QuickPickItem[] = [
  { label: 'Merge', description: 'Add the tasks and launch configurations it lacks' },
  { label: 'Replace', description: 'Replace it with the imported group' },
  { label: 'Skip', description: 'Keep it as it is' },
];

const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? '' : 's'}`;
const fileName = (uri: vscode.Uri): string => path.posix.basename(uri.path);
const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

// Returned from activate() so the integration tests can inspect and reset the state
export interface ExtensionApi {
  readonly shared: SharedState;
  // Saves the groups of the scope; the first one (the only one of a single-folder window) by default
  saveGroups(groups: VirtualGroup[], scope?: GroupScope): Promise<void>;
  // The groups of the scope as saved, which other windows may have changed
  loadGroups(scope: GroupScope): VirtualGroup[];
  // The Groups, Tasks and Launch Configurations views, whose messages the tests read
  readonly views: { readonly groups: vscode.TreeView<unknown>; readonly tasks: vscode.TreeView<unknown>; readonly launch: vscode.TreeView<unknown> };
}

export function activate(context: vscode.ExtensionContext): ExtensionApi {
  // Status bar picker command
  context.subscriptions.push(
    vscode.commands.registerCommand('run-my-tasks.showTaskPicker', () => showTaskPicker()),
  );

  createStatusBarItem(context);

  // Side panel tree views
  const shared = createSharedState();
  const scmSelection = new ScmSelection();
  shared.visibility = scmSelection;
  context.subscriptions.push(
    scmSelection,
    // On the context menu of the repositories in Source Control: VS Code hands the row clicked, then
    // the other selected ones
    vscode.commands.registerCommand('run-my-tasks.showScmRepositories', (...repositories: unknown[]) => {
      const roots = repositories
        .map(r => (r as { rootUri?: unknown } | undefined)?.rootUri)
        .filter((uri): uri is vscode.Uri => uri instanceof vscode.Uri);
      scmSelection.choose(roots);
    }),
  );

  const groupsProvider = new GroupsTreeProvider(shared);
  const tasksProvider = new TasksTreeProvider(shared);
  const launchProvider = new LaunchTreeProvider(shared);

  const groupStorage = createGroupStorage(context);
  void migrateLegacyGroups(context, groupStorage, shared.scopes);

  // Reads the groups of every scope again: the other windows on the same repository
  // (worktrees and multi-root workspaces including it) may have changed them
  const syncGroups = (): void => {
    for (const scope of shared.scopes) { setGroups(shared, groupStorage.load(scope), scope); }
  };

  const saveGroups = async (groups: VirtualGroup[], scope: GroupScope = shared.scopes[0]): Promise<void> => {
    await groupStorage.save(scope, groups);
    setGroups(shared, groups, scope);
    groupsProvider.refresh();
  };

  const views: vscode.TreeView<unknown>[] = [
    vscode.window.createTreeView('run-my-tasks.groupsView', {
      treeDataProvider: groupsProvider,
      showCollapseAll: false,
      dragAndDropController: new GroupsDragController(shared, (scopeId, groups) =>
        saveGroups(groups, scopeById(shared, scopeId))),
    }),
    vscode.window.createTreeView('run-my-tasks.tasksView', {
      treeDataProvider: tasksProvider,
      showCollapseAll: false,
      dragAndDropController: new TasksDragController(),
    }),
    vscode.window.createTreeView('run-my-tasks.launchView', {
      treeDataProvider: launchProvider,
      showCollapseAll: false,
      dragAndDropController: new LaunchDragController(),
    }),
  ];
  const [groupsView, tasksView, launchView] = views;
  context.subscriptions.push(...views);

  // Redraws the views with the cached tasks: their running state changed, not the tasks themselves
  const refreshViews = (): void => {
    groupsProvider.refresh();
    tasksProvider.refresh();
    launchProvider.refresh();
  };

  // Fetches the tasks again, then redraws the views
  const refreshAll = (): void => {
    dropCachedTasks(shared);
    refreshViews();
  };

  const refreshLaunches = (): void => {
    groupsProvider.refresh();
    launchProvider.refresh();
  };

  // The messages on top of the views: the search, and in the Groups and Tasks views whether
  // projects are hidden because their repository is not selected in Source Control
  const updateViewMessages = (): void => {
    const search = shared.filter ? `Search results for "${shared.filter}"` : undefined;
    const hiding = showsProjects(shared)
      && shared.scopes.some(scope => !shared.visibility.isScopeShown(scope));
    const scm = hiding ? 'Showing the repositories selected in Source Control' : undefined;
    for (const view of views) {
      const followsScm = view === groupsView || view === tasksView;
      view.message = [search, followsScm ? scm : undefined].filter(Boolean).join(' · ') || undefined;
    }
  };

  // Narrow all the views to the items matching the search text; an empty text shows everything again
  const setFilter = (filter: string): void => {
    shared.filter = filter;
    updateViewMessages();
    vscode.commands.executeCommand('setContext', 'runMyTasks.filterActive', filter !== '');
    groupsProvider.refresh();
    tasksProvider.refresh();
    launchProvider.refresh();
  };

  // Shows the task idle right away, before it ends
  const markStopped = (task: vscode.Task): void => {
    shared.pendingStop.add(taskKey(task));
    groupsProvider.refresh();
    tasksProvider.refresh();
  };

  // Load persisted groups on startup, and again when the window gets the focus:
  // the other windows on the same repository (worktrees included) may have changed them
  const reloadGroups = (): void => {
    syncGroups();
    groupsProvider.refresh();
  };
  reloadGroups();
  updateViewMessages();
  context.subscriptions.push(
    vscode.window.onDidChangeWindowState(state => {
      if (state.focused) { reloadGroups(); }
    }),
    // Folders added or removed: the projects change
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      shared.scopes = computeScopes();
      shared.groups.clear();
      syncGroups();
      updateViewMessages();
      refreshAll();
    }),
    // A repository selected or unselected in Source Control
    scmSelection.onDidChange(() => {
      updateViewMessages();
      groupsProvider.refresh();
      tasksProvider.refresh();
    }),
  );

  // Redraw the views on task lifecycle events
  context.subscriptions.push(
    trackTaskStarts(),
    trackTaskTerminals(),
    vscode.tasks.onDidStartTask(e => {
      shared.pendingStop.delete(taskKey(e.execution.task));
      refreshViews();
    }),
    vscode.tasks.onDidEndTask(e => {
      shared.pendingStop.delete(taskKey(e.execution.task));
      refreshViews();
    }),
  );

  // Refresh the launch configurations when a debug session starts or ends, or launch.json changes,
  // and the tasks when tasks.json changes
  context.subscriptions.push(
    trackDebugSessions(refreshLaunches),
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('tasks')) {
        refreshAll();
      } else if (e.affectsConfiguration('launch')) {
        refreshLaunches();
      }
    }),
  );

  // Search button in view title: filters the views while typing
  context.subscriptions.push(
    vscode.commands.registerCommand('run-my-tasks.search', () => {
      const input = vscode.window.createInputBox();
      input.placeholder = 'Search tasks, launch configurations and groups';
      input.value = shared.filter;
      input.onDidChangeValue(value => setFilter(value.trim()));
      input.onDidAccept(() => input.hide());
      input.onDidHide(() => input.dispose());
      input.show();
    }),
    vscode.commands.registerCommand('run-my-tasks.clearSearch', () => setFilter('')),
  );

  // Refresh button in view title
  context.subscriptions.push(
    vscode.commands.registerCommand('run-my-tasks.refreshTasksView', () => refreshAll()),
  );

  // Collapse All / Expand All buttons in the title of the Groups and Tasks views
  context.subscriptions.push(
    vscode.commands.registerCommand('run-my-tasks.collapseAllGroups', () => groupsProvider.setAllExpanded(false)),
    vscode.commands.registerCommand('run-my-tasks.expandAllGroups', () => groupsProvider.setAllExpanded(true)),
    vscode.commands.registerCommand('run-my-tasks.collapseAllTasks', () => tasksProvider.setAllExpanded(false)),
    vscode.commands.registerCommand('run-my-tasks.expandAllTasks', () => tasksProvider.setAllExpanded(true)),
  );

  // In a multi-root workspace, asks which folder's file to open
  const openVscodeFile = async (fileName: string): Promise<void> => {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders?.length) {
      vscode.window.showErrorMessage('No workspace folder open.');
      return;
    }
    let folder = folders[0];
    if (folders.length > 1) {
      const picked = await vscode.window.showQuickPick(
        folders.map(f => ({ label: f.name, description: f.uri.scheme === 'file' ? f.uri.fsPath : undefined, folder: f })),
        { placeHolder: `Open ${fileName} of` },
      );
      if (!picked) { return; }
      folder = picked.folder;
    }
    const uri = vscode.Uri.joinPath(folder.uri, '.vscode', fileName);
    try {
      const doc = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(doc);
    } catch {
      vscode.window.showErrorMessage(`${fileName} not found in .vscode/`);
    }
  };

  // Open tasks.json / launch.json buttons in view title
  context.subscriptions.push(
    vscode.commands.registerCommand('run-my-tasks.openTasksJson', () => openVscodeFile('tasks.json')),
    vscode.commands.registerCommand('run-my-tasks.openLaunchJson', () => openVscodeFile('launch.json')),
  );

  const runTaskItem = (item: TaskTreeItem, location?: TerminalLocation): void => {
    runTask(item.task, location).catch((err: unknown) =>
      vscode.window.showErrorMessage(`Failed to run task "${item.task.name}": ${err}`),
    );
  };

  // Run inline button, and Run in Editor / Run in Panel in the context menu of a task
  context.subscriptions.push(
    vscode.commands.registerCommand('run-my-tasks.runTaskFromTree', (item: TaskTreeItem) => runTaskItem(item)),
    vscode.commands.registerCommand('run-my-tasks.runTaskInEditor', (item: TaskTreeItem) => runTaskItem(item, 'editor')),
    vscode.commands.registerCommand('run-my-tasks.runTaskInPanel', (item: TaskTreeItem) => runTaskItem(item, 'panel')),
  );

  // Stop inline button on running task
  context.subscriptions.push(
    vscode.commands.registerCommand('run-my-tasks.stopTaskFromTree', (item: TaskTreeItem) => {
      const key = taskKey(item.task);
      const execution = vscode.tasks.taskExecutions.find(e => taskKey(e.task) === key);
      if (execution) {
        markStopped(execution.task);
        terminateTask(execution);
      }
    }),
  );

  // Click on a running task: focus the terminal it runs in
  context.subscriptions.push(
    vscode.commands.registerCommand('run-my-tasks.focusTaskTerminal', (item: TaskTreeItem) => {
      const name = item.task.name;
      const terminal = findTaskTerminal(name);
      if (terminal) {
        terminal.show();
      } else {
        vscode.window.showInformationMessage(`No terminal found for task "${name}".`);
      }
    }),
  );

  // Start / stop inline buttons on a launch configuration, and Run Without Debugging in its context menu
  context.subscriptions.push(
    vscode.commands.registerCommand('run-my-tasks.debugLaunchFromTree', (item: LaunchTreeItem) =>
      startLaunch(item.launch),
    ),
    vscode.commands.registerCommand('run-my-tasks.runLaunchFromTree', (item: LaunchTreeItem) =>
      startLaunch(item.launch, true),
    ),
    vscode.commands.registerCommand('run-my-tasks.stopLaunchFromTree', (item: LaunchTreeItem) =>
      stopLaunch(item.launch),
    ),
  );

  // The scope to work in: the only one of a single-folder window, else the one the user picks
  const pickScope = async (placeHolder: string, scopes = shared.scopes): Promise<GroupScope | undefined> => {
    if (shared.scopes.length === 1) { return shared.scopes[0]; }
    const picked = await vscode.window.showQuickPick(
      scopes.map(scope => ({
        label: scope.label,
        description: scope.mixed ? 'groups mixing the projects' : undefined,
        scope,
      })),
      { placeHolder },
    );
    return picked?.scope;
  };

  const allGroups = (): VirtualGroup[] => shared.scopes.flatMap(scope => groupsOf(shared, scope));

  // The group of the clicked item, or the one picked from the palette
  const targetGroup = async (
    item: VirtualGroupItem | undefined,
    placeHolder: string,
    noneMessage: string,
  ): Promise<{ scope: GroupScope; group: VirtualGroup } | undefined> => {
    syncGroups();
    if (item) {
      const scope = scopeById(shared, item.scopeId);
      return { scope, group: groupsOf(shared, scope).find(g => g.name === item.group.name) ?? item.group };
    }
    if (allGroups().length === 0) {
      vscode.window.showInformationMessage(noneMessage);
      return undefined;
    }
    return pickGroup(shared, placeHolder);
  };

  // Create virtual group, in the project clicked (inline button) or picked
  context.subscriptions.push(
    vscode.commands.registerCommand('run-my-tasks.createGroup', async (item?: unknown) => {
      syncGroups();
      const scope = item instanceof GroupScopeItem ? item.scope : await pickScope('Create the group in');
      if (!scope) { return; }
      const name = await vscode.window.showInputBox({
        prompt: showsProjects(shared) ? `Group name in ${scope.label}` : 'Group name',
        placeHolder: 'e.g. Dev, Build, Test',
      });
      if (!name?.trim()) { return; }
      const groups = groupStorage.load(scope);
      if (groups.some(g => g.name === name.trim())) {
        vscode.window.showWarningMessage(`Group "${name.trim()}" already exists.`);
        return;
      }
      await saveGroups([...groups, { name: name.trim(), tasks: [] }], scope);
    }),
  );

  // Delete virtual group
  context.subscriptions.push(
    vscode.commands.registerCommand('run-my-tasks.deleteGroup', async (item?: VirtualGroupItem) => {
      const target = await targetGroup(item, 'Select group to delete', 'No groups to delete.');
      if (!target) { return; }
      const { scope, group } = target;
      await saveGroups(groupStorage.load(scope).filter(g => g.name !== group.name), scope);
    }),
  );

  // Rename virtual group
  context.subscriptions.push(
    vscode.commands.registerCommand('run-my-tasks.renameGroup', async (item?: VirtualGroupItem) => {
      const target = await targetGroup(item, 'Select group to rename', 'No groups to rename.');
      if (!target) { return; }
      const { scope } = target;
      const groupName = target.group.name;
      const groups = groupStorage.load(scope);

      const newName = await vscode.window.showInputBox({
        prompt: 'New group name',
        value: groupName,
        // The name is saved trimmed: check it trimmed, or " Dev" would pass next to "Dev"
        validateInput: v => {
          const name = v.trim();
          if (!name) { return 'Name cannot be empty'; }
          if (name !== groupName && groups.some(g => g.name === name)) {
            return 'A group with this name already exists';
          }
        },
      });
      const trimmed = newName?.trim();
      if (!trimmed || trimmed === groupName || groups.some(g => g.name === trimmed)) { return; }

      await saveGroups(groups.map(g =>
        g.name === groupName ? { ...g, name: trimmed } : g,
      ), scope);
    }),
  );

  // Add task or launch configuration to group (palette or context menu on the item). A group
  // of a project takes only the entries of that project; one of the workspace scope takes all
  context.subscriptions.push(
    vscode.commands.registerCommand('run-my-tasks.addTaskToGroup', async (item?: EntryTreeItem) => {
      syncGroups();
      if (allGroups().length === 0) {
        const action = await vscode.window.showInformationMessage(
          'No groups yet. Create one first.',
          'Create Group',
        );
        if (action) {
          await vscode.commands.executeCommand('run-my-tasks.createGroup');
        }
        return;
      }

      const multiRoot = showsProjects(shared);
      let entry: NewEntry | undefined;
      if (item) {
        entry = { kind: item.kind, name: item.name, folder: item.folder };
      } else {
        const allTasks = await vscode.tasks.fetchTasks();
        const pick = await vscode.window.showQuickPick<EntryQuickPickItem<NewEntry>>(
          [
            ...allTasks.map(t => ({
              label: t.name,
              description: multiRoot ? `${taskOrigin(t).label} · ${t.source}` : t.source,
              entry: { kind: 'tasks' as const, name: t.name, folder: taskOrigin(t).folder },
            })),
            ...getLaunchConfigs().map(c => ({
              label: c.name,
              description: multiRoot ? `${LAUNCH_LABEL} · ${c.folder?.name ?? workspaceFileLabel()}` : LAUNCH_LABEL,
              entry: { kind: 'launches' as const, name: c.name, folder: c.folder },
            })),
          ],
          { placeHolder: 'Select task or launch configuration to add' },
        );
        entry = pick?.entry;
      }
      if (!entry) { return; }
      const { kind, name, folder } = entry;

      if (!shared.scopes.some(scope => scopeAccepts(scope, folder) && groupsOf(shared, scope).length > 0)) {
        vscode.window.showInformationMessage(
          `No groups can take "${name}" yet: create one in ${folder?.name ?? 'its project'} or in the Workspace.`,
        );
        return;
      }
      const picked = await pickGroup(shared, `Add "${name}" to group`, scope => scopeAccepts(scope, folder));
      if (!picked) { return; }

      const { scope } = picked;
      const ref = entryRefFor(scope, name, folder);
      await saveGroups(groupStorage.load(scope).map(g =>
        g.name === picked.group.name && !groupEntries(g, kind).includes(ref)
          ? { ...g, [kind]: [...groupEntries(g, kind), ref] }
          : g,
      ), scope);
    }),
  );

  // Remove task or launch configuration from group (palette or context menu on the item inside group)
  context.subscriptions.push(
    vscode.commands.registerCommand('run-my-tasks.removeTaskFromGroup', async (item?: EntryTreeItem) => {
      syncGroups();
      const remove = (scope: GroupScope, groupName: string, { kind, ref }: GroupEntry): Promise<void> =>
        saveGroups(groupStorage.load(scope).map(g =>
          g.name === groupName
            ? { ...g, [kind]: groupEntries(g, kind).filter(e => e !== ref) }
            : g,
        ), scope);

      if (item?.groupName) {
        await remove(scopeById(shared, item.scopeId), item.groupName, item);
        return;
      }

      const hasEntries = (g: VirtualGroup): boolean => g.tasks.length + groupEntries(g, 'launches').length > 0;
      if (!allGroups().some(hasEntries)) {
        vscode.window.showInformationMessage('No tasks in any group.');
        return;
      }

      const picked = await pickGroup(shared, 'Select group', (_, g) => hasEntries(g));
      if (!picked) { return; }

      const { group } = picked;
      const entryPick = await vscode.window.showQuickPick<EntryQuickPickItem<GroupEntry>>(
        [
          ...group.tasks.map(ref => ({ ...describeRef(ref), entry: { kind: 'tasks' as const, ref } })),
          ...groupEntries(group, 'launches').map(ref => {
            const { label, description } = describeRef(ref);
            return {
              label,
              description: [LAUNCH_LABEL, description].filter(Boolean).join(' · '),
              entry: { kind: 'launches' as const, ref },
            };
          }),
        ],
        { placeHolder: 'Select task or launch configuration to remove' },
      );
      if (!entryPick) { return; }

      await remove(picked.scope, group.name, entryPick.entry);
    }),
  );

  // Whether the ref of a group of the scope stands for a task or launch configuration of this
  // workspace: the groups view shows only those
  const knownRef = async (scope: GroupScope, kind: EntryKind): Promise<(ref: string) => boolean> => {
    if (kind === 'tasks') {
      const tasks = await loadTasks(shared);
      return ref => resolveTask(tasks, ref, scope) !== undefined;
    }
    const configs = getLaunchConfigs();
    return ref => resolveLaunch(configs, ref, scope) !== undefined;
  };

  // Moves the entry past its neighbour shown in the group, among the entries of its kind.
  // Entries this workspace lacks are hidden from the view: they are skipped, keeping their place
  const moveEntry = async (item: EntryTreeItem, step: -1 | 1): Promise<void> => {
    if (!item.groupName) { return; }
    const scope = scopeById(shared, item.scopeId);
    const groups = groupStorage.load(scope);
    const group = groups.find(g => g.name === item.groupName);
    if (!group) { return; }
    const entries = [...groupEntries(group, item.kind)];
    const from = entries.indexOf(item.ref);
    if (from < 0) { return; }
    const known = await knownRef(scope, item.kind);
    let to = from + step;
    while (to >= 0 && to < entries.length && !known(entries[to])) { to += step; }
    if (to < 0 || to >= entries.length) { return; }
    entries.splice(from, 1);
    entries.splice(to, 0, item.ref);
    await saveGroups(groups.map(g => g.name === item.groupName ? { ...g, [item.kind]: entries } : g), scope);
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('run-my-tasks.moveTaskUp', (item: EntryTreeItem) => moveEntry(item, -1)),
    vscode.commands.registerCommand('run-my-tasks.moveTaskDown', (item: EntryTreeItem) => moveEntry(item, 1)),
  );

  // Move group up/down, among the groups of its project
  const moveGroup = async (item: VirtualGroupItem, step: -1 | 1): Promise<void> => {
    const scope = scopeById(shared, item.scopeId);
    const groups = [...groupStorage.load(scope)];
    const idx = groups.findIndex(g => g.name === item.group.name);
    const to = idx + step;
    if (idx < 0 || to < 0 || to >= groups.length) { return; }
    [groups[idx], groups[to]] = [groups[to], groups[idx]];
    await saveGroups(groups, scope);
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('run-my-tasks.moveGroupUp', (item: VirtualGroupItem) => moveGroup(item, -1)),
    vscode.commands.registerCommand('run-my-tasks.moveGroupDown', (item: VirtualGroupItem) => moveGroup(item, 1)),
  );

  // Export the picked groups of a project to a JSON file
  context.subscriptions.push(
    vscode.commands.registerCommand('run-my-tasks.exportGroups', async () => {
      syncGroups();
      const withGroups = shared.scopes.filter(scope => groupsOf(shared, scope).length > 0);
      if (withGroups.length === 0) {
        vscode.window.showInformationMessage('No groups to export.');
        return;
      }
      // Group names are unique in a project only: export one project at a time
      const scope = withGroups.length === 1 ? withGroups[0] : await pickScope('Export the groups of', withGroups);
      if (!scope) { return; }
      const groups = groupsOf(shared, scope);

      const picked = await vscode.window.showQuickPick(
        groups.map(g => ({ label: g.name, picked: true })),
        { placeHolder: 'Select groups to export', canPickMany: true },
      );
      if (!picked?.length) { return; }

      const folder = scope.folders[0]?.uri ?? vscode.workspace.workspaceFolders?.[0]?.uri ?? vscode.Uri.file(os.homedir());
      const baseName = showsProjects(shared) && !scope.mixed ? scope.folders[0].name : vscode.workspace.name ?? 'run-my-tasks';
      const uri = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.joinPath(folder, `${baseName}-groups.json`),
        filters: { JSON: ['json'] },
        saveLabel: 'Export',
      });
      if (!uri) { return; }

      const names = new Set(picked.map(p => p.label));
      const exported = groups.filter(g => names.has(g.name));
      try {
        await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(serializeGroups(exported)));
      } catch (err) {
        vscode.window.showErrorMessage(`Cannot export groups to ${fileName(uri)}: ${errorMessage(err)}`);
        return;
      }
      vscode.window.showInformationMessage(`Exported ${plural(exported.length, 'group')} to ${fileName(uri)}.`);
    }),
  );

  // Import the groups of a JSON file made by Export Groups, adding them to the existing ones of a project
  context.subscriptions.push(
    vscode.commands.registerCommand('run-my-tasks.importGroups', async () => {
      const [uri] = await vscode.window.showOpenDialog({
        canSelectMany: false,
        filters: { JSON: ['json'] },
        openLabel: 'Import',
      }) ?? [];
      if (!uri) { return; }

      let imported: VirtualGroup[];
      try {
        imported = parseGroups(new TextDecoder().decode(await vscode.workspace.fs.readFile(uri)));
      } catch (err) {
        vscode.window.showErrorMessage(`Cannot import groups from ${fileName(uri)}: ${errorMessage(err)}`);
        return;
      }
      if (imported.length === 0) {
        vscode.window.showInformationMessage(`No groups in ${fileName(uri)}.`);
        return;
      }

      const scope = await pickScope('Import the groups into');
      if (!scope) { return; }

      // New groups go last; for a group named as an existing one, ask what to do.
      // Cancelling the question cancels the whole import
      let groups = groupStorage.load(scope);
      const added: VirtualGroup[] = [];
      for (const group of imported) {
        const existing = groups.find(g => g.name === group.name);
        if (!existing) {
          groups = [...groups, group];
          added.push(group);
          continue;
        }
        const choice = await vscode.window.showQuickPick(IMPORT_CONFLICT_CHOICES, {
          placeHolder: `Group "${group.name}" already exists`,
        });
        if (!choice) { return; }
        if (choice.label === 'Skip') { continue; }
        const replacement = choice.label === 'Merge' ? mergeGroup(existing, group) : group;
        groups = groups.map(g => (g === existing ? replacement : g));
        added.push(group);
      }
      if (added.length === 0) {
        vscode.window.showInformationMessage('No groups imported.');
        return;
      }
      await saveGroups(groups, scope);

      // Groups refer to tasks and launch configurations by name: tell which ones this workspace lacks
      const tasks = await vscode.tasks.fetchTasks();
      const configs = getLaunchConfigs();
      const missing = new Set([
        ...added.flatMap(g => g.tasks.filter(ref => !resolveTask(tasks, ref, scope))),
        ...added.flatMap(g => groupEntries(g, 'launches').filter(ref => !resolveLaunch(configs, ref, scope))),
      ].map(ref => describeRef(ref).label));
      const summary = `Imported ${plural(added.length, 'group')} from ${fileName(uri)}.`;
      if (missing.size > 0) {
        vscode.window.showWarningMessage(`${summary} Not found in this workspace: ${[...missing].join(', ')}.`);
      } else {
        vscode.window.showInformationMessage(summary);
      }
    }),
  );

  // Run all idle tasks and launch configurations in group
  context.subscriptions.push(
    vscode.commands.registerCommand('run-my-tasks.runGroup', async (item?: VirtualGroupItem) => {
      const target = await targetGroup(item, 'Select group to run', 'No groups defined.');
      if (!target) { return; }
      const { scope, group } = target;

      // In the order of the group; a task that fails to start does not stop the others
      const running = runningTaskKeys(shared.pendingStop);
      for (const task of groupTasks(group, await vscode.tasks.fetchTasks(), scope)) {
        if (running.has(taskKey(task))) { continue; }
        try {
          await runTask(task);
        } catch (err) {
          vscode.window.showErrorMessage(`Failed to run task "${task.name}": ${errorMessage(err)}`);
        }
      }

      const runningLaunches = runningLaunchNames();
      for (const config of groupLaunches(group, getLaunchConfigs(), scope)) {
        if (!isLaunchRunning(config, runningLaunches)) {
          await startLaunch(config);
        }
      }
    }),
  );

  // Stop all running tasks and launch configurations in group
  context.subscriptions.push(
    vscode.commands.registerCommand('run-my-tasks.stopGroup', async (item?: VirtualGroupItem) => {
      const target = await targetGroup(item, 'Select group to stop', 'No groups defined.');
      if (!target) { return; }
      const { scope, group } = target;

      const keys = new Set(groupTasks(group, await vscode.tasks.fetchTasks(), scope).map(taskKey));
      for (const execution of vscode.tasks.taskExecutions) {
        if (keys.has(taskKey(execution.task))) {
          markStopped(execution.task);
          terminateTask(execution);
        }
      }

      await Promise.all(groupLaunches(group, getLaunchConfigs(), scope).map(config => stopLaunch(config)));
    }),
  );

  return { shared, saveGroups, loadGroups: scope => groupStorage.load(scope), views: { groups: groupsView, tasks: tasksView, launch: launchView } };
}

export function deactivate(): void {}
