import * as vscode from 'vscode';
import { getLaunchConfigs, isLaunchRunning, LaunchConfig, runningLaunchNames } from './launchConfigs';

export interface VirtualGroup {
  name: string;
  tasks: string[];
  // Launch configuration names; absent on groups saved before launch.json support
  launches?: string[];
}

// The VirtualGroup list an entry of a group is stored in
export type EntryKind = 'tasks' | 'launches';

export function groupEntries(group: VirtualGroup, kind: EntryKind): string[] {
  return group[kind] ?? [];
}

export interface SharedState {
  cachedTasks: vscode.Task[] | null;
  readonly pendingStop: Set<string>;
  virtualGroups: VirtualGroup[];
  // Search text narrowing all the views; empty when not searching
  filter: string;
}

export function createSharedState(): SharedState {
  return { cachedTasks: null, pendingStop: new Set(), virtualGroups: [], filter: '' };
}

// True when every search term appears in one of the texts, ignoring case
function matchesFilter(filter: string, ...texts: string[]): boolean {
  const haystack = texts.join(' ').toLowerCase();
  return filter.toLowerCase().split(/\s+/).every(term => haystack.includes(term));
}

export class VirtualGroupItem extends vscode.TreeItem {
  constructor(
    public readonly group: VirtualGroup,
    runningCount: number,
  ) {
    super(group.name, vscode.TreeItemCollapsibleState.Expanded);
    this.iconPath = new vscode.ThemeIcon('layers');
    this.description = runningCount > 0 ? `${runningCount} running` : undefined;
    this.contextValue = 'virtualGroup';
  }
}

export class TaskGroupItem extends vscode.TreeItem {
  constructor(
    public readonly source: string,
    runningCount: number,
  ) {
    super(source, vscode.TreeItemCollapsibleState.Expanded);
    this.iconPath = new vscode.ThemeIcon(
      source === 'Workspace' ? 'file-code' : 'package',
    );
    if (runningCount > 0) {
      this.description = `${runningCount} running`;
    }
    this.contextValue = 'taskGroup';
  }
}

export class TaskTreeItem extends vscode.TreeItem {
  readonly kind = 'tasks';
  readonly name: string;

  constructor(
    public readonly task: vscode.Task,
    public readonly running: boolean,
    public readonly groupName?: string,
  ) {
    super(task.name, vscode.TreeItemCollapsibleState.None);
    this.name = task.name;
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

  constructor(
    public readonly launch: LaunchConfig,
    public readonly running: boolean,
    public readonly groupName?: string,
  ) {
    super(launch.name, vscode.TreeItemCollapsibleState.None);
    this.name = launch.name;
    const multiRoot = (vscode.workspace.workspaceFolders?.length ?? 0) > 1;
    this.description = [launch.compound ? 'compound' : launch.type, multiRoot && launch.folder?.name]
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

function getRunningNames(pendingStop: Set<string>): Set<string> {
  return new Set(
    vscode.tasks.taskExecutions
      .filter(e => !pendingStop.has(e.task.name))
      .map(e => e.task.name),
  );
}

function buildGroups(tasks: vscode.Task[], runningNames: Set<string>): TaskGroupItem[] {
  const groups = new Map<string, number>();
  for (const t of tasks) {
    const prev = groups.get(t.source) ?? 0;
    groups.set(t.source, runningNames.has(t.name) ? prev + 1 : prev);
  }

  const sorted = [...groups.keys()].sort((a, b) => {
    if (a === 'Workspace') { return -1; }
    if (b === 'Workspace') { return 1; }
    return a.localeCompare(b);
  });

  return sorted.map(source => new TaskGroupItem(source, groups.get(source) ?? 0));
}

function buildTaskItems(tasks: vscode.Task[], runningNames: Set<string>, groupName?: string): TaskTreeItem[] {
  return tasks.map(t => new TaskTreeItem(t, runningNames.has(t.name), groupName));
}

// Mime types for drop-cursor matching (data travels via module-level variable, not DataTransfer)
// Tasks and launch configurations share one: they drop on the same targets
const TASK_DRAG_MIME = 'application/run-my-tasks.task-drag';
const GROUP_DRAG_MIME = 'application/run-my-tasks.group-drag';

interface EntryDragItem { kind: EntryKind; name: string; fromGroup?: string; }
interface GroupDragItem { groupName: string; }

// VS Code does not reliably propagate custom DataTransfer values across tree views,
// so we keep the active drag payload in memory instead.
let activeDrag: { entries?: EntryDragItem[]; groups?: GroupDragItem[] } | null = null;

type GroupsNode = VirtualGroupItem | EntryTreeItem;

function draggedEntries(source: readonly vscode.TreeItem[]): EntryDragItem[] {
  return source
    .filter((i): i is EntryTreeItem => i instanceof TaskTreeItem || i instanceof LaunchTreeItem)
    .map(i => ({ kind: i.kind, name: i.name, fromGroup: i.groupName }));
}

// Drag from the Tasks or Launch Configurations view, to be dropped on the Groups view
function handleEntryDrag(source: readonly vscode.TreeItem[], dataTransfer: vscode.DataTransfer): void {
  const entries = draggedEntries(source);
  if (entries.length === 0) { return; }
  activeDrag = { entries };
  dataTransfer.set(TASK_DRAG_MIME, new vscode.DataTransferItem('1'));
}

export class TasksDragController implements vscode.TreeDragAndDropController<TaskGroupItem | TaskTreeItem> {
  readonly dragMimeTypes = [TASK_DRAG_MIME];
  readonly dropMimeTypes: string[] = [];

  handleDrag(source: readonly (TaskGroupItem | TaskTreeItem)[], dataTransfer: vscode.DataTransfer): void {
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
    private readonly onDrop: (groups: VirtualGroup[]) => Promise<void>,
  ) {}

  handleDrag(source: readonly GroupsNode[], dataTransfer: vscode.DataTransfer): void {
    const entries = draggedEntries(source);
    const groups: GroupDragItem[] = source
      .filter((i): i is VirtualGroupItem => i instanceof VirtualGroupItem)
      .map(i => ({ groupName: i.group.name }));
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

    let groups = [...this.shared.virtualGroups];

    // Case A: group reorder — drag a group header onto another group header
    if (drag.groups && target instanceof VirtualGroupItem) {
      const targetName = target.group.name;
      for (const gi of drag.groups) {
        if (gi.groupName === targetName) { continue; }
        const fromIdx = groups.findIndex(g => g.name === gi.groupName);
        if (fromIdx === -1) { continue; }
        const [moved] = groups.splice(fromIdx, 1);
        const toIdx = groups.findIndex(g => g.name === targetName);
        groups.splice(toIdx, 0, moved);
      }
      await this.onDrop(groups);
      return;
    }

    // Cases B and C: task and launch configuration moves
    if (!drag.entries || drag.entries.length === 0) { return; }

    let targetGroupName: string | undefined;
    let targetEntry: EntryTreeItem | undefined;
    if (target instanceof VirtualGroupItem) {
      targetGroupName = target.group.name;
    } else if (target?.groupName) {
      targetGroupName = target.groupName;
      targetEntry = target;
    } else {
      // target is undefined: VS Code may pass undefined when dropping on an expanded
      // group header — fall back to a quick-pick so the user can choose the group
      const names = groups.map(g => g.name);
      if (names.length === 0) { return; }
      targetGroupName = await vscode.window.showQuickPick(names, { placeHolder: 'Add to group…' });
    }
    if (!targetGroupName) { return; }

    for (const { kind, name, fromGroup } of drag.entries) {
      if (fromGroup === targetGroupName && targetEntry?.kind === kind && name !== targetEntry.name) {
        // Case B: reorder within same group — insert before the target entry of the same kind
        const before = targetEntry.name;
        groups = groups.map(g => {
          if (g.name !== targetGroupName) { return g; }
          const reordered = groupEntries(g, kind).filter(e => e !== name);
          const insertAt = reordered.indexOf(before);
          if (insertAt === -1) { return { ...g, [kind]: [...reordered, name] }; }
          reordered.splice(insertAt, 0, name);
          return { ...g, [kind]: reordered };
        });
      } else if (fromGroup !== targetGroupName) {
        // Case C: cross-group or Tasks/Launch Configurations→Groups move
        if (fromGroup) {
          groups = groups.map(g =>
            g.name === fromGroup ? { ...g, [kind]: groupEntries(g, kind).filter(e => e !== name) } : g,
          );
        }
        groups = groups.map(g =>
          g.name === targetGroupName && !groupEntries(g, kind).includes(name)
            ? { ...g, [kind]: [...groupEntries(g, kind), name] }
            : g,
        );
      }
    }

    await this.onDrop(groups);
  }
}

export class GroupsTreeProvider implements vscode.TreeDataProvider<GroupsNode> {
  private _onDidChangeTreeData = new vscode.EventEmitter<GroupsNode | undefined | null | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private readonly shared: SharedState) {}

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: GroupsNode): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: GroupsNode): Promise<GroupsNode[]> {
    if (!this.shared.cachedTasks) {
      try {
        this.shared.cachedTasks = await vscode.tasks.fetchTasks();
      } catch {
        return [];
      }
    }

    const filter = this.shared.filter;

    if (!element) {
      return this.shared.virtualGroups
        .map(g => ({ group: g, entries: this.entryItems(g) }))
        .filter(({ group, entries }) => !filter || entries.some(e => matchesFilter(filter, group.name, e.name)))
        .map(({ group, entries }) => new VirtualGroupItem(group, entries.filter(e => e.running).length));
    }

    if (element instanceof VirtualGroupItem) {
      const { group } = element;
      return this.entryItems(group).filter(e => matchesFilter(filter, group.name, e.name));
    }

    return [];
  }

  // Tasks then launch configurations of the group, each in the user-defined order; unknown names are skipped
  private entryItems(group: VirtualGroup): EntryTreeItem[] {
    const groupTasks = group.tasks
      .map(name => this.shared.cachedTasks!.find(t => t.name === name))
      .filter((t): t is vscode.Task => t !== undefined);

    const launchConfigs = getLaunchConfigs();
    const runningLaunches = runningLaunchNames();
    const groupLaunches = groupEntries(group, 'launches')
      .map(name => launchConfigs.find(c => c.name === name))
      .filter((c): c is LaunchConfig => c !== undefined);

    return [
      ...buildTaskItems(groupTasks, getRunningNames(this.shared.pendingStop), group.name),
      ...groupLaunches.map(c => new LaunchTreeItem(c, isLaunchRunning(c, runningLaunches), group.name)),
    ];
  }
}

type TasksNode = TaskGroupItem | TaskTreeItem;

export class TasksTreeProvider implements vscode.TreeDataProvider<TasksNode> {
  private _onDidChangeTreeData = new vscode.EventEmitter<TasksNode | undefined | null | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private readonly shared: SharedState) {}

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: TasksNode): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: TasksNode): Promise<TasksNode[]> {
    if (!this.shared.cachedTasks) {
      try {
        this.shared.cachedTasks = await vscode.tasks.fetchTasks();
      } catch {
        return [];
      }
    }

    const runningNames = getRunningNames(this.shared.pendingStop);
    const tasks = this.shared.cachedTasks.filter(t => matchesFilter(this.shared.filter, t.source, t.name));

    if (!element) {
      return buildGroups(tasks, runningNames);
    }

    if (element instanceof TaskGroupItem) {
      return buildTaskItems(
        tasks.filter(t => t.source === element.source),
        runningNames,
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
      .filter(c => matchesFilter(this.shared.filter, c.name))
      .map(c => new LaunchTreeItem(c, isLaunchRunning(c, running)));
  }
}
