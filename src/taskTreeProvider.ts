import * as vscode from 'vscode';
import { getLaunchConfigs, isLaunchRunning, LaunchConfig, runningLaunches, runningLaunchNames } from './launchConfigs';
import {
  compareOrigins,
  computeScopes,
  isMultiRoot,
  entryRefFor,
  GroupScope,
  groupsKey,
  parseEntryRef,
  refMatches,
  scopeAccepts,
  TaskOrigin,
  taskFolder,
  taskOrigin,
  workspaceFileLabel,
} from './projects';
import { runningTaskKeys, taskKey } from './taskIdentity';

export interface VirtualGroup {
  name: string;
  // Entry refs (see projects.ts): the task name, prefixed by its folder in the workspace scope
  tasks: string[];
  // Launch configuration refs; absent on groups saved before launch.json support
  launches?: string[];
}

// The VirtualGroup list an entry of a group is stored in
export type EntryKind = 'tasks' | 'launches';

export function groupEntries(group: VirtualGroup, kind: EntryKind): string[] {
  return group[kind] ?? [];
}

// The task a ref of a group of `scope` stands for. Among the tasks with that name the scope
// accepts, the one of tasks.json wins, then the first one found
export function resolveTask(tasks: readonly vscode.Task[], ref: string, scope?: GroupScope): vscode.Task | undefined {
  const parsed = parseEntryRef(ref);
  const named = tasks.filter(t => t.name === parsed.name && refMatches(scope, parsed, taskFolder(t)));
  return named.find(t => t.source === 'Workspace') ?? named[0];
}

export function resolveLaunch(configs: readonly LaunchConfig[], ref: string, scope?: GroupScope): LaunchConfig | undefined {
  const parsed = parseEntryRef(ref);
  return configs.find(c => c.name === parsed.name && refMatches(scope, parsed, c.folder));
}

// The tasks of the group in its order; refs with no task in this workspace are skipped
export function groupTasks(group: VirtualGroup, tasks: readonly vscode.Task[], scope?: GroupScope): vscode.Task[] {
  return group.tasks
    .map(ref => resolveTask(tasks, ref, scope))
    .filter((t): t is vscode.Task => t !== undefined);
}

// The launch configurations of the group in its order; unknown refs are skipped
export function groupLaunches(group: VirtualGroup, configs: readonly LaunchConfig[], scope?: GroupScope): LaunchConfig[] {
  return groupEntries(group, 'launches')
    .map(ref => resolveLaunch(configs, ref, scope))
    .filter((c): c is LaunchConfig => c !== undefined);
}

// Which projects the views show: those chosen, or the repositories selected in Source Control (ProjectChoice)
export interface ProjectVisibility {
  isFolderShown(folder: vscode.WorkspaceFolder): boolean;
  isScopeShown(scope: GroupScope): boolean;
}

const SHOW_ALL: ProjectVisibility = { isFolderShown: () => true, isScopeShown: () => true };

export interface SharedState {
  cachedTasks: vscode.Task[] | null;
  // The fetch filling cachedTasks, shared by the views asking for the tasks at the same time
  loadingTasks: Promise<vscode.Task[]> | null;
  // Keys (taskKey) of the tasks being stopped, shown idle until they end
  readonly pendingStop: Set<string>;
  // Where groups live: one scope in a single-folder window, one per project and the workspace
  // scope in a multi-root workspace
  scopes: GroupScope[];
  // The groups of each scope, by groupsKey: the projects of the worktrees of a repository share them
  readonly groups: Map<string, VirtualGroup[]>;
  // Search text narrowing all the views; empty when not searching
  filter: string;
  visibility: ProjectVisibility;
}

export function createSharedState(): SharedState {
  return {
    cachedTasks: null,
    loadingTasks: null,
    pendingStop: new Set(),
    scopes: computeScopes(),
    groups: new Map(),
    filter: '',
    visibility: SHOW_ALL,
  };
}

// The views show the projects (and the origin of each task) only in a multi-root workspace
export function showsProjects(shared: SharedState): boolean {
  return shared.scopes.length > 1;
}

// The scope of that id; the first one (the only one of a single-folder window) when absent or unknown
export function scopeById(shared: SharedState, id?: string): GroupScope {
  return shared.scopes.find(s => s.id === id) ?? shared.scopes[0];
}

export function groupsOf(shared: SharedState, scope: GroupScope = shared.scopes[0]): VirtualGroup[] {
  return shared.groups.get(groupsKey(scope)) ?? [];
}

export function setGroups(shared: SharedState, groups: VirtualGroup[], scope: GroupScope = shared.scopes[0]): void {
  shared.groups.set(groupsKey(scope), groups);
}

export interface PickedGroup { scope: GroupScope; group: VirtualGroup; }

/**
 * Asks for a group among those `accept` takes. A single-folder window offers the bare names; a
 * multi-root workspace tells the project of each group.
 */
export async function pickGroup(
  shared: SharedState,
  placeHolder: string,
  accept: (scope: GroupScope, group: VirtualGroup) => boolean = () => true,
): Promise<PickedGroup | undefined> {
  const candidates = shared.scopes.flatMap(scope =>
    groupsOf(shared, scope).filter(group => accept(scope, group)).map(group => ({ scope, group })));
  if (!showsProjects(shared)) {
    const name = await vscode.window.showQuickPick(candidates.map(c => c.group.name), { placeHolder });
    return candidates.find(c => c.group.name === name);
  }
  const picked = await vscode.window.showQuickPick(
    candidates.map(c => ({ label: c.group.name, description: c.scope.label, candidate: c })),
    { placeHolder },
  );
  return picked?.candidate;
}

// The tasks of the workspace, fetched once until dropCachedTasks()
export async function loadTasks(shared: SharedState): Promise<vscode.Task[]> {
  if (shared.cachedTasks) { return shared.cachedTasks; }
  const loading = shared.loadingTasks ?? (shared.loadingTasks = Promise.resolve(vscode.tasks.fetchTasks()));
  try {
    const tasks = await loading;
    // Unless the cache was dropped meanwhile: the tasks may have changed after the fetch started
    if (shared.loadingTasks === loading) { shared.cachedTasks = tasks; }
    return tasks;
  } finally {
    if (shared.loadingTasks === loading) { shared.loadingTasks = null; }
  }
}

export function dropCachedTasks(shared: SharedState): void {
  shared.cachedTasks = null;
  shared.loadingTasks = null;
}

// True when every search term appears in one of the texts, ignoring case
function matchesFilter(filter: string, ...texts: string[]): boolean {
  const haystack = texts.join(' ').toLowerCase();
  return filter.toLowerCase().split(/\s+/).every(term => haystack.includes(term));
}

// Expand state forced on every collapsible node of a view by Expand All / Collapse All.
// VS Code keeps the expand state of the nodes it already knows, keyed by their id, and only
// honors collapsibleState on new nodes: each forced change gives the nodes a new id
export class ExpandState {
  private generation = 0;
  private state = vscode.TreeItemCollapsibleState.Expanded;

  setAll(expanded: boolean): void {
    this.state = expanded ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed;
    this.generation++;
  }

  apply(item: vscode.TreeItem, key: string): void {
    item.id = `${this.generation}:${key}`;
    item.collapsibleState = this.state;
  }
}

const runningDescription = (count: number): string | undefined => (count > 0 ? `${count} running` : undefined);

// A project of a multi-root workspace in the Groups view, or the workspace scope
export class GroupScopeItem extends vscode.TreeItem {
  constructor(
    public readonly scope: GroupScope,
    groupCount: number,
    runningCount: number,
    expandState?: ExpandState,
  ) {
    super(scope.label, vscode.TreeItemCollapsibleState.Expanded);
    expandState?.apply(this, `scope:${scope.id}`);
    if (groupCount === 0) { this.collapsibleState = vscode.TreeItemCollapsibleState.None; }
    this.iconPath = new vscode.ThemeIcon(scope.mixed ? 'multiple-windows' : scope.repo ? 'repo' : 'root-folder');
    this.description = runningDescription(runningCount) ?? (scope.mixed ? 'all projects' : undefined);
    this.tooltip = scope.mixed
      ? 'Groups mixing the projects of the workspace'
      : scope.folders.map(f => f.uri.scheme === 'file' ? f.uri.fsPath : f.uri.toString()).join('\n');
    this.contextValue = 'groupScope';
  }
}

export class VirtualGroupItem extends vscode.TreeItem {
  constructor(
    public readonly group: VirtualGroup,
    runningCount: number,
    expandState?: ExpandState,
    // The scope the group belongs to; the first one when absent
    public readonly scopeId?: string,
  ) {
    super(group.name, vscode.TreeItemCollapsibleState.Expanded);
    expandState?.apply(this, `${scopeId ?? ''}/${group.name}`);
    this.iconPath = new vscode.ThemeIcon('layers');
    this.description = runningDescription(runningCount);
    this.contextValue = 'virtualGroup';
  }
}

// Where tasks come from in the Tasks view of a multi-root workspace: a folder, the workspace or the user
export class TaskOriginItem extends vscode.TreeItem {
  constructor(
    public readonly origin: TaskOrigin,
    runningCount: number,
    expandState?: ExpandState,
  ) {
    super(origin.label, vscode.TreeItemCollapsibleState.Expanded);
    expandState?.apply(this, `origin:${origin.key}`);
    this.iconPath = new vscode.ThemeIcon(
      origin.folder ? 'root-folder' : origin.key === 'user' ? 'account' : 'multiple-windows',
    );
    this.description = runningDescription(runningCount);
    this.tooltip = origin.folder
      ? (origin.folder.uri.scheme === 'file' ? origin.folder.uri.fsPath : origin.folder.uri.toString())
      : origin.key === 'user' ? 'User tasks' : 'Tasks of the workspace file';
    this.contextValue = 'taskOrigin';
  }
}

export class TaskGroupItem extends vscode.TreeItem {
  constructor(
    public readonly source: string,
    runningCount: number,
    expandState?: ExpandState,
    // The origin the source is listed under, in a multi-root workspace
    public readonly origin?: TaskOrigin,
  ) {
    super(source, vscode.TreeItemCollapsibleState.Expanded);
    expandState?.apply(this, `${origin?.key ?? ''}/${source}`);
    this.iconPath = new vscode.ThemeIcon(
      source === 'Workspace' ? 'file-code' : 'package',
    );
    this.description = runningDescription(runningCount);
    this.contextValue = 'taskGroup';
  }
}

export class TaskTreeItem extends vscode.TreeItem {
  readonly kind = 'tasks';
  readonly name: string;
  readonly folder: vscode.WorkspaceFolder | undefined;
  // What the group stores for the task; its name outside a group
  readonly ref: string;

  constructor(
    public readonly task: vscode.Task,
    public readonly running: boolean,
    public readonly groupName?: string,
    public readonly scopeId?: string,
    ref?: string,
  ) {
    super(task.name, vscode.TreeItemCollapsibleState.None);
    this.name = task.name;
    this.folder = taskFolder(task);
    this.ref = ref ?? task.name;
    this.tooltip = running ? `${task.name} (running)` : task.name;
    this.iconPath = new vscode.ThemeIcon(
      running ? 'loading~spin' : 'circle-outline',
      running ? new vscode.ThemeColor('charts.green') : undefined,
    );
    const base = running ? 'runningTask' : 'idleTask';
    this.contextValue = groupName ? `${base}InGroup` : base;
    if (running) {
      this.command = {
        command: 'run-my-tasks.focusTaskTerminal',
        title: 'Show Terminal',
        arguments: [this],
      };
    }
  }
}

export class LaunchTreeItem extends vscode.TreeItem {
  readonly kind = 'launches';
  readonly name: string;
  readonly folder: vscode.WorkspaceFolder | undefined;
  readonly ref: string;

  constructor(
    public readonly launch: LaunchConfig,
    public readonly running: boolean,
    public readonly groupName?: string,
    public readonly scopeId?: string,
    ref?: string,
  ) {
    super(launch.name, vscode.TreeItemCollapsibleState.None);
    this.name = launch.name;
    this.folder = launch.folder;
    this.ref = ref ?? launch.name;
    const multiRoot = isMultiRoot();
    this.description = [launch.compound ? 'compound' : launch.type, multiRoot && (launch.folder?.name ?? workspaceFileLabel())]
      .filter(Boolean)
      .join(' · ');
    this.tooltip = running ? `${launch.name} (running)` : launch.name;
    this.iconPath = new vscode.ThemeIcon(
      running ? 'loading~spin' : 'debug-alt',
      running ? new vscode.ThemeColor('charts.green') : undefined,
    );
    const base = running ? 'runningLaunch' : 'idleLaunch';
    this.contextValue = groupName ? `${base}InGroup` : base;
    if (running) {
      this.command = { command: 'workbench.panel.repl.view.focus', title: 'Show Debug Console' };
    }
  }
}

export type EntryTreeItem = TaskTreeItem | LaunchTreeItem;

function countRunning(tasks: readonly vscode.Task[], runningKeys: Set<string>): number {
  return tasks.filter(t => runningKeys.has(taskKey(t))).length;
}

function buildGroups(
  tasks: vscode.Task[],
  runningKeys: Set<string>,
  expandState: ExpandState,
  origin?: TaskOrigin,
): TaskGroupItem[] {
  const sources = [...new Set(tasks.map(t => t.source))].sort((a, b) => {
    if (a === 'Workspace') { return -1; }
    if (b === 'Workspace') { return 1; }
    return a.localeCompare(b);
  });

  return sources.map(source => new TaskGroupItem(
    source,
    countRunning(tasks.filter(t => t.source === source), runningKeys),
    expandState,
    origin,
  ));
}

function buildTaskItems(tasks: vscode.Task[], runningKeys: Set<string>): TaskTreeItem[] {
  return tasks.map(t => new TaskTreeItem(t, runningKeys.has(taskKey(t))));
}

// Mime types for drop-cursor matching (data travels via module-level variable, not DataTransfer)
// Tasks and launch configurations share one: they drop on the same targets
const TASK_DRAG_MIME = 'application/run-my-tasks.task-drag';
const GROUP_DRAG_MIME = 'application/run-my-tasks.group-drag';

interface EntryDragItem {
  kind: EntryKind;
  name: string;
  folder: vscode.WorkspaceFolder | undefined;
  // The group the entry is dragged from, and its ref there
  from?: { scopeId?: string; groupName: string; ref: string };
}
interface GroupDragItem { scopeId?: string; groupName: string; }

// VS Code does not reliably propagate custom DataTransfer values across tree views,
// so we keep the active drag payload in memory instead.
let activeDrag: { entries?: EntryDragItem[]; groups?: GroupDragItem[] } | null = null;

type GroupsNode = GroupScopeItem | VirtualGroupItem | EntryTreeItem;

function draggedEntries(source: readonly vscode.TreeItem[]): EntryDragItem[] {
  return source
    .filter((i): i is EntryTreeItem => i instanceof TaskTreeItem || i instanceof LaunchTreeItem)
    .map(i => ({
      kind: i.kind,
      name: i.name,
      folder: i.folder,
      from: i.groupName ? { scopeId: i.scopeId, groupName: i.groupName, ref: i.ref } : undefined,
    }));
}

// Drag from the Tasks or Launch Configurations view, to be dropped on the Groups view
function handleEntryDrag(source: readonly vscode.TreeItem[], dataTransfer: vscode.DataTransfer): void {
  const entries = draggedEntries(source);
  if (entries.length === 0) { return; }
  activeDrag = { entries };
  dataTransfer.set(TASK_DRAG_MIME, new vscode.DataTransferItem('1'));
}

export class TasksDragController implements vscode.TreeDragAndDropController<vscode.TreeItem> {
  readonly dragMimeTypes = [TASK_DRAG_MIME];
  readonly dropMimeTypes: string[] = [];

  handleDrag(source: readonly vscode.TreeItem[], dataTransfer: vscode.DataTransfer): void {
    handleEntryDrag(source, dataTransfer);
  }
}

export class LaunchDragController implements vscode.TreeDragAndDropController<LaunchTreeItem> {
  readonly dragMimeTypes = [TASK_DRAG_MIME];
  readonly dropMimeTypes: string[] = [];

  handleDrag(source: readonly LaunchTreeItem[], dataTransfer: vscode.DataTransfer): void {
    handleEntryDrag(source, dataTransfer);
  }
}

export class GroupsDragController implements vscode.TreeDragAndDropController<GroupsNode> {
  readonly dragMimeTypes = [TASK_DRAG_MIME, GROUP_DRAG_MIME];
  readonly dropMimeTypes = [TASK_DRAG_MIME, GROUP_DRAG_MIME];

  constructor(
    private readonly shared: SharedState,
    // Saves the groups of a scope the drop changed
    private readonly onDrop: (scopeId: string, groups: VirtualGroup[]) => Promise<void>,
  ) {}

  handleDrag(source: readonly GroupsNode[], dataTransfer: vscode.DataTransfer): void {
    const entries = draggedEntries(source);
    const groups: GroupDragItem[] = source
      .filter((i): i is VirtualGroupItem => i instanceof VirtualGroupItem)
      .map(i => ({ scopeId: i.scopeId, groupName: i.group.name }));
    if (entries.length === 0 && groups.length === 0) { return; }
    activeDrag = {
      entries: entries.length > 0 ? entries : undefined,
      groups: groups.length > 0 ? groups : undefined,
    };
    if (entries.length > 0) { dataTransfer.set(TASK_DRAG_MIME, new vscode.DataTransferItem('1')); }
    if (groups.length > 0) { dataTransfer.set(GROUP_DRAG_MIME, new vscode.DataTransferItem('1')); }
  }

  async handleDrop(target: GroupsNode | undefined, _dataTransfer: vscode.DataTransfer): Promise<void> {
    const drag = activeDrag;
    activeDrag = null;
    if (!drag) { return; }

    // The groups the drop changes, by groupsKey: the projects of two worktrees of a repository
    // share their groups, a move from one to the other changes them once
    const changed = new Map<string, { scope: GroupScope; groups: VirtualGroup[] }>();
    const scopeOf = (id?: string): GroupScope => scopeById(this.shared, id);
    const sameGroups = (a: GroupScope, b: GroupScope): boolean => groupsKey(a) === groupsKey(b);
    const groupsIn = (scope: GroupScope): VirtualGroup[] =>
      changed.get(groupsKey(scope))?.groups ?? [...groupsOf(this.shared, scope)];
    const update = (scope: GroupScope, groups: VirtualGroup[]): void => { changed.set(groupsKey(scope), { scope, groups }); };
    const save = async (): Promise<void> => {
      for (const { scope, groups } of changed.values()) { await this.onDrop(scope.id, groups); }
    };

    // Case A: group reorder — drag a group header onto another group header of the same project
    if (drag.groups && target instanceof VirtualGroupItem) {
      const scope = scopeOf(target.scopeId);
      const targetName = target.group.name;
      let groups = groupsIn(scope);
      for (const gi of drag.groups) {
        if (gi.groupName === targetName || !sameGroups(scopeOf(gi.scopeId), scope)) { continue; }
        const fromIdx = groups.findIndex(g => g.name === gi.groupName);
        if (fromIdx === -1) { continue; }
        groups = [...groups];
        const [moved] = groups.splice(fromIdx, 1);
        const toIdx = groups.findIndex(g => g.name === targetName);
        groups.splice(toIdx, 0, moved);
      }
      update(scope, groups);
      await save();
      return;
    }

    // Cases B and C: task and launch configuration moves
    if (!drag.entries || drag.entries.length === 0) { return; }
    const entries = drag.entries;
    const acceptsAny = (scope: GroupScope): boolean => entries.some(e => scopeAccepts(scope, e.folder));

    let targetScope: GroupScope | undefined;
    let targetGroupName: string | undefined;
    let targetEntry: EntryTreeItem | undefined;
    if (target instanceof VirtualGroupItem) {
      targetScope = scopeOf(target.scopeId);
      targetGroupName = target.group.name;
    } else if (target instanceof GroupScopeItem) {
      // Dropped on a project: ask which of its groups
      const picked = await pickGroup(this.shared, `Add to a group of ${target.scope.label}…`, scope =>
        scope.id === target.scope.id);
      targetScope = picked?.scope;
      targetGroupName = picked?.group.name;
    } else if (target?.groupName) {
      targetScope = scopeOf(target.scopeId);
      targetGroupName = target.groupName;
      targetEntry = target;
    } else {
      // target is undefined: VS Code may pass undefined when dropping on an expanded
      // group header — fall back to a quick-pick so the user can choose the group
      if (!this.shared.scopes.some(s => groupsOf(this.shared, s).length > 0)) { return; }
      const picked = await pickGroup(this.shared, 'Add to group…', scope => acceptsAny(scope));
      targetScope = picked?.scope;
      targetGroupName = picked?.group.name;
    }
    if (!targetScope || !targetGroupName) { return; }
    const scope = targetScope;
    // The target scope is saved even when the drop changes nothing in it
    update(scope, groupsIn(scope));

    const rejected: EntryDragItem[] = [];
    for (const entry of entries) {
      const { kind, name, folder, from } = entry;
      const fromScope = from && scopeOf(from.scopeId);
      // An entry moved between the projects of two worktrees stays in the groups they share
      const sharedGroups = fromScope !== undefined && sameGroups(fromScope, scope);
      if (!scopeAccepts(scope, folder) && !sharedGroups) {
        rejected.push(entry);
        continue;
      }
      const ref = sharedGroups ? from!.ref : entryRefFor(scope, name, folder);
      const sameGroup = sharedGroups && from?.groupName === targetGroupName;

      if (sameGroup && targetEntry?.kind === kind && from!.ref !== targetEntry.ref) {
        // Case B: reorder within same group — insert before the target entry of the same kind
        const before = targetEntry.ref;
        update(scope, groupsIn(scope).map(g => {
          if (g.name !== targetGroupName) { return g; }
          const reordered = groupEntries(g, kind).filter(e => e !== from!.ref);
          const insertAt = reordered.indexOf(before);
          if (insertAt === -1) { return { ...g, [kind]: [...reordered, from!.ref] }; }
          reordered.splice(insertAt, 0, from!.ref);
          return { ...g, [kind]: reordered };
        }));
      } else if (!sameGroup) {
        // Case C: cross-group or Tasks/Launch Configurations→Groups move
        if (from && fromScope) {
          update(fromScope, groupsIn(fromScope).map(g =>
            g.name === from.groupName ? { ...g, [kind]: groupEntries(g, kind).filter(e => e !== from.ref) } : g,
          ));
        }
        update(scope, groupsIn(scope).map(g =>
          g.name === targetGroupName && !groupEntries(g, kind).includes(ref)
            ? { ...g, [kind]: [...groupEntries(g, kind), ref] }
            : g,
        ));
      }
    }

    if (rejected.length > 0) {
      const names = rejected.map(e => `"${e.name}"${e.folder ? ` (${e.folder.name})` : ''}`).join(', ');
      vscode.window.showWarningMessage(
        `${names} cannot be added to a group of ${scope.label}: put it in a group of its own project, or of the Workspace.`,
      );
    }
    await save();
  }
}

interface GroupRow { group: VirtualGroup; entries: EntryTreeItem[]; }

export class GroupsTreeProvider implements vscode.TreeDataProvider<GroupsNode> {
  readonly expandState = new ExpandState();
  private _onDidChangeTreeData = new vscode.EventEmitter<GroupsNode | undefined | null | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private readonly shared: SharedState) {}

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  // Expand All / Collapse All buttons
  setAllExpanded(expanded: boolean): void {
    this.expandState.setAll(expanded);
    this.refresh();
  }

  getTreeItem(element: GroupsNode): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: GroupsNode): Promise<GroupsNode[]> {
    let tasks: vscode.Task[];
    try {
      tasks = await loadTasks(this.shared);
    } catch {
      return [];
    }

    if (!element) {
      if (!showsProjects(this.shared)) {
        return this.groupItems(this.shared.scopes[0], this.rows(this.shared.scopes[0], tasks));
      }
      // The projects shown (see ScmSelection); with a search, those with a match, or named as searched
      const filter = this.shared.filter;
      return this.shared.scopes
        .filter(scope => this.shared.visibility.isScopeShown(scope))
        .map(scope => ({ scope, rows: this.rows(scope, tasks) }))
        .filter(({ scope, rows }) => !filter || rows.length > 0 || matchesFilter(filter, scope.label))
        .map(({ scope, rows }) => new GroupScopeItem(
          scope,
          rows.length,
          rows.reduce((sum, r) => sum + r.entries.filter(e => e.running).length, 0),
          this.expandState,
        ));
    }

    if (element instanceof GroupScopeItem) {
      return this.groupItems(element.scope, this.rows(element.scope, tasks));
    }

    if (element instanceof VirtualGroupItem) {
      const scope = scopeById(this.shared, element.scopeId);
      const { group } = element;
      return this.entryItems(scope, group, tasks)
        .filter(e => matchesFilter(this.shared.filter, ...this.scopeTexts(scope), group.name, e.name));
    }

    return [];
  }

  // In a multi-root workspace the search matches the project names too
  private scopeTexts(scope: GroupScope): string[] {
    return showsProjects(this.shared) ? [scope.label] : [];
  }

  // The groups of the scope the search lets through. A group matching the search by its own name
  // is shown even with no entry, so it can be found
  private rows(scope: GroupScope, tasks: vscode.Task[]): GroupRow[] {
    const filter = this.shared.filter;
    const texts = this.scopeTexts(scope);
    return groupsOf(this.shared, scope)
      .map(group => ({ group, entries: this.entryItems(scope, group, tasks) }))
      .filter(({ group, entries }) =>
        !filter || matchesFilter(filter, ...texts, group.name) || entries.some(e => matchesFilter(filter, ...texts, group.name, e.name)));
  }

  private groupItems(scope: GroupScope, rows: GroupRow[]): VirtualGroupItem[] {
    return rows.map(({ group, entries }) =>
      new VirtualGroupItem(group, entries.filter(e => e.running).length, this.expandState, scope.id));
  }

  // Tasks then launch configurations of the group, each in the user-defined order; unknown refs are skipped
  private entryItems(scope: GroupScope, group: VirtualGroup, tasks: vscode.Task[]): EntryTreeItem[] {
    const runningKeys = runningTaskKeys(this.shared.pendingStop);
    const runningLaunches = runningLaunchNames();
    const configs = getLaunchConfigs();
    // Tell the folder of each task when the project does not: in the workspace scope, or in a
    // project made of several folders of one repository
    const showFolder = showsProjects(this.shared) && (scope.mixed || scope.folders.length > 1);

    const taskItems = group.tasks.flatMap(ref => {
      const task = resolveTask(tasks, ref, scope);
      if (!task) { return []; }
      const item = new TaskTreeItem(task, runningKeys.has(taskKey(task)), group.name, scope.id, ref);
      if (showFolder) { item.description = taskOrigin(task).label; }
      return [item];
    });
    const launchItems = groupEntries(group, 'launches').flatMap(ref => {
      const config = resolveLaunch(configs, ref, scope);
      return config ? [new LaunchTreeItem(config, isLaunchRunning(config, runningLaunches), group.name, scope.id, ref)] : [];
    });
    return [...taskItems, ...launchItems];
  }
}

type TasksNode = TaskOriginItem | TaskGroupItem | TaskTreeItem;

export class TasksTreeProvider implements vscode.TreeDataProvider<TasksNode> {
  readonly expandState = new ExpandState();
  private _onDidChangeTreeData = new vscode.EventEmitter<TasksNode | undefined | null | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private readonly shared: SharedState) {}

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  // Expand All / Collapse All buttons
  setAllExpanded(expanded: boolean): void {
    this.expandState.setAll(expanded);
    this.refresh();
  }

  getTreeItem(element: TasksNode): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: TasksNode): Promise<TasksNode[]> {
    let allTasks: vscode.Task[];
    try {
      allTasks = await loadTasks(this.shared);
    } catch {
      return [];
    }

    const runningKeys = runningTaskKeys(this.shared.pendingStop);
    const multiRoot = showsProjects(this.shared);
    // In a multi-root workspace the tasks are listed by origin, then by source; the search
    // matches the origin too, and the folders of the repositories not selected in Source Control are hidden
    const tasks = allTasks.filter(t => {
      const origin = taskOrigin(t);
      if (multiRoot && origin.folder && !this.shared.visibility.isFolderShown(origin.folder)) { return false; }
      return matchesFilter(this.shared.filter, ...(multiRoot ? [origin.label] : []), t.source, t.name);
    });

    if (!element) {
      if (!multiRoot) { return buildGroups(tasks, runningKeys, this.expandState); }
      const origins = new Map<string, TaskOrigin>();
      for (const t of tasks) {
        const origin = taskOrigin(t);
        if (!origins.has(origin.key)) { origins.set(origin.key, origin); }
      }
      return [...origins.values()]
        .sort(compareOrigins)
        .map(origin => new TaskOriginItem(
          origin,
          countRunning(tasks.filter(t => taskOrigin(t).key === origin.key), runningKeys),
          this.expandState,
        ));
    }

    if (element instanceof TaskOriginItem) {
      const key = element.origin.key;
      return buildGroups(tasks.filter(t => taskOrigin(t).key === key), runningKeys, this.expandState, element.origin);
    }

    if (element instanceof TaskGroupItem) {
      const key = element.origin?.key;
      return buildTaskItems(
        tasks.filter(t => t.source === element.source && (key === undefined || taskOrigin(t).key === key)),
        runningKeys,
      );
    }

    return [];
  }
}

export class LaunchTreeProvider implements vscode.TreeDataProvider<LaunchTreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<LaunchTreeItem | undefined | null | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private readonly shared: SharedState) {}

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: LaunchTreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: LaunchTreeItem): LaunchTreeItem[] {
    if (element) { return []; }

    const running = runningLaunchNames();
    return getLaunchConfigs()
      .filter(c => matchesFilter(this.shared.filter, c.name, ...(showsProjects(this.shared) ? [c.folder?.name ?? ''] : [])))
      .map(c => new LaunchTreeItem(c, isLaunchRunning(c, running)));
  }
}

type RunningNode = TaskTreeItem | LaunchTreeItem;

/**
 * The Running view: the tasks running, whoever started them, then the launch configurations
 * being debugged, in the order they started. It shows those of every project, chosen or not
 */
export class RunningTreeProvider implements vscode.TreeDataProvider<RunningNode> {
  private _onDidChangeTreeData = new vscode.EventEmitter<RunningNode | undefined | null | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private readonly shared: SharedState) {}

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: RunningNode): vscode.TreeItem {
    return element;
  }

  // The running tasks, but those being stopped, each once
  runningTasks(): vscode.Task[] {
    const seen = new Set<string>();
    return vscode.tasks.taskExecutions.map(e => e.task).filter(task => {
      const key = taskKey(task);
      if (seen.has(key) || this.shared.pendingStop.has(key)) { return false; }
      seen.add(key);
      return true;
    });
  }

  // How many tasks and launch configurations are running, search or not
  count(): number {
    return this.runningTasks().length + runningLaunches().length;
  }

  getChildren(element?: RunningNode): RunningNode[] {
    if (element) { return []; }
    const multiRoot = showsProjects(this.shared);
    const filter = this.shared.filter;

    const taskItems = this.runningTasks()
      .filter(t => matchesFilter(filter, ...(multiRoot ? [taskOrigin(t).label] : []), t.source, t.name))
      .map(t => {
        const item = new TaskTreeItem(t, true);
        // Where it comes from: its folder, and its source but for tasks.json
        item.description = [multiRoot && taskOrigin(t).label, t.source !== 'Workspace' && t.source]
          .filter(Boolean).join(' · ') || undefined;
        return item;
      });
    const launchItems = runningLaunches()
      .filter(c => matchesFilter(filter, c.name, ...(multiRoot ? [c.folder?.name ?? workspaceFileLabel()] : [])))
      .map(c => new LaunchTreeItem(c, true));
    return [...taskItems, ...launchItems];
  }
}
