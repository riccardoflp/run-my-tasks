import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { createGroupStorage } from './groupStorage';
import { mergeGroup, parseGroups, serializeGroups } from './groupTransfer';
import {
  getLaunchConfigs,
  isLaunchRunning,
  runningLaunchNames,
  startLaunch,
  stopLaunch,
  trackDebugSessions,
} from './launchConfigs';
import { createStatusBarItem } from './statusBar';
import { showTaskPicker } from './taskPicker';
import { findTaskTerminal, runTask, TerminalLocation, trackTaskTerminals } from './taskTerminals';
import {
  createSharedState,
  EntryKind,
  EntryTreeItem,
  groupEntries,
  SharedState,
  GroupsDragController,
  GroupsTreeProvider,
  LaunchDragController,
  LaunchTreeItem,
  LaunchTreeProvider,
  TasksDragController,
  TasksTreeProvider,
  TaskTreeItem,
  VirtualGroup,
  VirtualGroupItem,
} from './taskTreeProvider';

// Tells launch configurations from tasks in the pickers listing both
const LAUNCH_LABEL = 'Launch Configuration';

interface GroupEntry { kind: EntryKind; name: string; }

interface EntryQuickPickItem extends vscode.QuickPickItem {
  entry: GroupEntry;
}

function entryPickItem(kind: EntryKind, name: string, description?: string): EntryQuickPickItem {
  return { label: name, description, entry: { kind, name } };
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
  saveGroups(groups: VirtualGroup[]): Promise<void>;
}

export function activate(context: vscode.ExtensionContext): ExtensionApi {
  // Status bar picker command
  context.subscriptions.push(
    vscode.commands.registerCommand('run-my-tasks.showTaskPicker', () => showTaskPicker()),
  );

  createStatusBarItem(context);

  // Side panel tree views
  const shared = createSharedState();
  const groupsProvider = new GroupsTreeProvider(shared);
  const tasksProvider = new TasksTreeProvider(shared);
  const launchProvider = new LaunchTreeProvider(shared);

  const groupStorage = createGroupStorage(context);
  const loadGroups = (): VirtualGroup[] => groupStorage.load();

  const saveGroups = async (groups: VirtualGroup[]): Promise<void> => {
    await groupStorage.save(groups);
    shared.virtualGroups = groups;
    groupsProvider.refresh();
  };

  const views: vscode.TreeView<unknown>[] = [
    vscode.window.createTreeView('run-my-tasks.groupsView', {
      treeDataProvider: groupsProvider,
      showCollapseAll: false,
      dragAndDropController: new GroupsDragController(shared, saveGroups),
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
  context.subscriptions.push(...views);

  const refreshAll = (): void => {
    shared.cachedTasks = null;
    groupsProvider.refresh();
    tasksProvider.refresh();
    launchProvider.refresh();
  };

  const refreshLaunches = (): void => {
    groupsProvider.refresh();
    launchProvider.refresh();
  };

  // Narrow all the views to the items matching the search text; an empty text shows everything again
  const setFilter = (filter: string): void => {
    shared.filter = filter;
    for (const view of views) {
      view.message = filter ? `Search results for "${filter}"` : undefined;
    }
    vscode.commands.executeCommand('setContext', 'runMyTasks.filterActive', filter !== '');
    groupsProvider.refresh();
    tasksProvider.refresh();
    launchProvider.refresh();
  };

  const markStopped = (name: string): void => {
    shared.pendingStop.add(name);
    groupsProvider.refresh();
    tasksProvider.refresh();
  };

  const clearStopped = (name: string): void => {
    shared.pendingStop.delete(name);
  };

  // Load persisted groups on startup, and again when the window gets the focus:
  // the other windows on the same repository (worktrees included) may have changed them
  const reloadGroups = (): void => {
    shared.virtualGroups = loadGroups();
    groupsProvider.refresh();
  };
  reloadGroups();
  context.subscriptions.push(
    vscode.window.onDidChangeWindowState(state => {
      if (state.focused) { reloadGroups(); }
    }),
  );

  // Refresh both views on task lifecycle events
  context.subscriptions.push(
    trackTaskTerminals(),
    vscode.tasks.onDidStartTask(e => {
      shared.pendingStop.delete(e.execution.task.name);
      refreshAll();
    }),
    vscode.tasks.onDidEndTask(e => {
      clearStopped(e.execution.task.name);
      refreshAll();
    }),
  );

  // Refresh the launch configurations when a debug session starts or ends, or launch.json changes
  context.subscriptions.push(
    trackDebugSessions(refreshLaunches),
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('launch')) { refreshLaunches(); }
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

  const openVscodeFile = async (fileName: string): Promise<void> => {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders?.length) {
      vscode.window.showErrorMessage('No workspace folder open.');
      return;
    }
    const uri = vscode.Uri.joinPath(folders[0].uri, '.vscode', fileName);
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
      const execution = vscode.tasks.taskExecutions.find(e => e.task.name === item.task.name);
      if (execution) {
        markStopped(item.task.name);
        execution.terminate();
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

  // Create virtual group
  context.subscriptions.push(
    vscode.commands.registerCommand('run-my-tasks.createGroup', async () => {
      const name = await vscode.window.showInputBox({
        prompt: 'Group name',
        placeHolder: 'e.g. Dev, Build, Test',
      });
      if (!name?.trim()) { return; }
      const groups = loadGroups();
      if (groups.some(g => g.name === name.trim())) {
        vscode.window.showWarningMessage(`Group "${name.trim()}" already exists.`);
        return;
      }
      await saveGroups([...groups, { name: name.trim(), tasks: [] }]);
    }),
  );

  // Delete virtual group
  context.subscriptions.push(
    vscode.commands.registerCommand('run-my-tasks.deleteGroup', async (item?: VirtualGroupItem) => {
      const groups = loadGroups();
      let groupName: string | undefined;

      if (item) {
        groupName = item.group.name;
      } else {
        if (groups.length === 0) {
          vscode.window.showInformationMessage('No groups to delete.');
          return;
        }
        groupName = await vscode.window.showQuickPick(
          groups.map(g => g.name),
          { placeHolder: 'Select group to delete' },
        );
      }

      if (!groupName) { return; }
      await saveGroups(groups.filter(g => g.name !== groupName));
    }),
  );

  // Rename virtual group
  context.subscriptions.push(
    vscode.commands.registerCommand('run-my-tasks.renameGroup', async (item?: VirtualGroupItem) => {
      const groups = loadGroups();
      let groupName: string | undefined;

      if (item) {
        groupName = item.group.name;
      } else {
        if (groups.length === 0) {
          vscode.window.showInformationMessage('No groups to rename.');
          return;
        }
        groupName = await vscode.window.showQuickPick(
          groups.map(g => g.name),
          { placeHolder: 'Select group to rename' },
        );
      }

      if (!groupName) { return; }

      const newName = await vscode.window.showInputBox({
        prompt: 'New group name',
        value: groupName,
        validateInput: v => {
          if (!v.trim()) { return 'Name cannot be empty'; }
          if (v !== groupName && groups.some(g => g.name === v)) {
            return 'A group with this name already exists';
          }
        },
      });
      if (!newName || newName === groupName) { return; }

      await saveGroups(groups.map(g =>
        g.name === groupName ? { ...g, name: newName.trim() } : g,
      ));
    }),
  );

  // Add task or launch configuration to group (palette or context menu on the item)
  context.subscriptions.push(
    vscode.commands.registerCommand('run-my-tasks.addTaskToGroup', async (item?: EntryTreeItem) => {
      const groups = loadGroups();
      if (groups.length === 0) {
        const action = await vscode.window.showInformationMessage(
          'No groups yet. Create one first.',
          'Create Group',
        );
        if (action) {
          await vscode.commands.executeCommand('run-my-tasks.createGroup');
        }
        return;
      }

      let entry: GroupEntry | undefined;
      if (item) {
        entry = item;
      } else {
        const allTasks = await vscode.tasks.fetchTasks();
        const pick = await vscode.window.showQuickPick(
          [
            ...allTasks.map(t => entryPickItem('tasks', t.name, t.source)),
            ...getLaunchConfigs().map(c => entryPickItem('launches', c.name, LAUNCH_LABEL)),
          ],
          { placeHolder: 'Select task or launch configuration to add' },
        );
        entry = pick?.entry;
      }
      if (!entry) { return; }

      const groupPick = await vscode.window.showQuickPick(
        groups.map(g => g.name),
        { placeHolder: `Add "${entry.name}" to group` },
      );
      if (!groupPick) { return; }

      const { kind, name } = entry;
      await saveGroups(groups.map(g =>
        g.name === groupPick && !groupEntries(g, kind).includes(name)
          ? { ...g, [kind]: [...groupEntries(g, kind), name] }
          : g,
      ));
    }),
  );

  // Remove task or launch configuration from group (palette or context menu on the item inside group)
  context.subscriptions.push(
    vscode.commands.registerCommand('run-my-tasks.removeTaskFromGroup', async (item?: EntryTreeItem) => {
      const groups = loadGroups();
      const remove = (groupName: string, { kind, name }: GroupEntry): Promise<void> =>
        saveGroups(groups.map(g =>
          g.name === groupName
            ? { ...g, [kind]: groupEntries(g, kind).filter(e => e !== name) }
            : g,
        ));

      if (item?.groupName) {
        await remove(item.groupName, item);
        return;
      }

      const groupsWithTasks = groups.filter(g => g.tasks.length + groupEntries(g, 'launches').length > 0);
      if (groupsWithTasks.length === 0) {
        vscode.window.showInformationMessage('No tasks in any group.');
        return;
      }

      const groupPick = await vscode.window.showQuickPick(
        groupsWithTasks.map(g => g.name),
        { placeHolder: 'Select group' },
      );
      if (!groupPick) { return; }

      const group = groups.find(g => g.name === groupPick)!;
      const entryPick = await vscode.window.showQuickPick(
        [
          ...group.tasks.map(name => entryPickItem('tasks', name)),
          ...groupEntries(group, 'launches').map(name => entryPickItem('launches', name, LAUNCH_LABEL)),
        ],
        { placeHolder: 'Select task or launch configuration to remove' },
      );
      if (!entryPick) { return; }

      await remove(groupPick, entryPick.entry);
    }),
  );

  // Move task or launch configuration up/down within its group, among the entries of its kind
  context.subscriptions.push(
    vscode.commands.registerCommand('run-my-tasks.moveTaskUp', async (item: EntryTreeItem) => {
      if (!item.groupName) { return; }
      const groups = loadGroups();
      const group = groups.find(g => g.name === item.groupName);
      if (!group) { return; }
      const entries = [...groupEntries(group, item.kind)];
      const idx = entries.indexOf(item.name);
      if (idx <= 0) { return; }
      [entries[idx - 1], entries[idx]] = [entries[idx], entries[idx - 1]];
      await saveGroups(groups.map(g => g.name === item.groupName ? { ...g, [item.kind]: entries } : g));
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('run-my-tasks.moveTaskDown', async (item: EntryTreeItem) => {
      if (!item.groupName) { return; }
      const groups = loadGroups();
      const group = groups.find(g => g.name === item.groupName);
      if (!group) { return; }
      const entries = [...groupEntries(group, item.kind)];
      const idx = entries.indexOf(item.name);
      if (idx < 0 || idx >= entries.length - 1) { return; }
      [entries[idx], entries[idx + 1]] = [entries[idx + 1], entries[idx]];
      await saveGroups(groups.map(g => g.name === item.groupName ? { ...g, [item.kind]: entries } : g));
    }),
  );

  // Move group up/down
  context.subscriptions.push(
    vscode.commands.registerCommand('run-my-tasks.moveGroupUp', async (item: VirtualGroupItem) => {
      const groups = loadGroups();
      const idx = groups.findIndex(g => g.name === item.group.name);
      if (idx <= 0) { return; }
      const newGroups = [...groups];
      [newGroups[idx - 1], newGroups[idx]] = [newGroups[idx], newGroups[idx - 1]];
      await saveGroups(newGroups);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('run-my-tasks.moveGroupDown', async (item: VirtualGroupItem) => {
      const groups = loadGroups();
      const idx = groups.findIndex(g => g.name === item.group.name);
      if (idx < 0 || idx >= groups.length - 1) { return; }
      const newGroups = [...groups];
      [newGroups[idx], newGroups[idx + 1]] = [newGroups[idx + 1], newGroups[idx]];
      await saveGroups(newGroups);
    }),
  );

  // Export the picked groups to a JSON file
  context.subscriptions.push(
    vscode.commands.registerCommand('run-my-tasks.exportGroups', async () => {
      const groups = loadGroups();
      if (groups.length === 0) {
        vscode.window.showInformationMessage('No groups to export.');
        return;
      }
      const picked = await vscode.window.showQuickPick(
        groups.map(g => ({ label: g.name, picked: true })),
        { placeHolder: 'Select groups to export', canPickMany: true },
      );
      if (!picked?.length) { return; }

      const folder = vscode.workspace.workspaceFolders?.[0]?.uri ?? vscode.Uri.file(os.homedir());
      const uri = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.joinPath(folder, `${vscode.workspace.name ?? 'run-my-tasks'}-groups.json`),
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

  // Import the groups of a JSON file made by Export Groups, adding them to the existing ones
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

      // New groups go last; for a group named as an existing one, ask what to do.
      // Cancelling the question cancels the whole import
      let groups = loadGroups();
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
      await saveGroups(groups);

      // Groups refer to tasks and launch configurations by name: tell which ones this workspace lacks
      const taskNames = new Set((await vscode.tasks.fetchTasks()).map(t => t.name));
      const launchNames = new Set(getLaunchConfigs().map(c => c.name));
      const missing = new Set([
        ...added.flatMap(g => g.tasks.filter(name => !taskNames.has(name))),
        ...added.flatMap(g => groupEntries(g, 'launches').filter(name => !launchNames.has(name))),
      ]);
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
      let group: VirtualGroup | undefined;

      if (item) {
        group = item.group;
      } else {
        const groups = loadGroups();
        if (groups.length === 0) {
          vscode.window.showInformationMessage('No groups defined.');
          return;
        }
        const pick = await vscode.window.showQuickPick(
          groups.map(g => g.name),
          { placeHolder: 'Select group to run' },
        );
        group = groups.find(g => g.name === pick);
      }

      if (!group) { return; }

      const allTasks = await vscode.tasks.fetchTasks();
      const runningNames = new Set(
        vscode.tasks.taskExecutions
          .filter(e => !shared.pendingStop.has(e.task.name))
          .map(e => e.task.name),
      );
      const toRun = allTasks.filter(t =>
        group!.tasks.includes(t.name) && !runningNames.has(t.name),
      );
      for (const task of toRun) {
        await runTask(task);
      }

      const launches = groupEntries(group, 'launches');
      const runningLaunches = runningLaunchNames();
      for (const config of getLaunchConfigs()) {
        if (launches.includes(config.name) && !isLaunchRunning(config, runningLaunches)) {
          await startLaunch(config);
        }
      }
    }),
  );

  // Stop all running tasks and launch configurations in group
  context.subscriptions.push(
    vscode.commands.registerCommand('run-my-tasks.stopGroup', async (item?: VirtualGroupItem) => {
      let group: VirtualGroup | undefined;

      if (item) {
        group = item.group;
      } else {
        const groups = loadGroups();
        if (groups.length === 0) {
          vscode.window.showInformationMessage('No groups defined.');
          return;
        }
        const pick = await vscode.window.showQuickPick(
          groups.map(g => g.name),
          { placeHolder: 'Select group to stop' },
        );
        group = groups.find(g => g.name === pick);
      }

      if (!group) { return; }

      for (const execution of vscode.tasks.taskExecutions) {
        if (group.tasks.includes(execution.task.name)) {
          markStopped(execution.task.name);
          execution.terminate();
        }
      }

      const launches = groupEntries(group, 'launches');
      await Promise.all(getLaunchConfigs().filter(c => launches.includes(c.name)).map(stopLaunch));
    }),
  );

  return { shared, saveGroups };
}

export function deactivate(): void {}
