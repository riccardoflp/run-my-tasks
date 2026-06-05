import * as vscode from 'vscode';

export interface VirtualGroup {
  name: string;
  tasks: string[];
}

export interface SharedState {
  cachedTasks: vscode.Task[] | null;
  readonly pendingStop: Set<string>;
  virtualGroups: VirtualGroup[];
}

export function createSharedState(): SharedState {
  return { cachedTasks: null, pendingStop: new Set(), virtualGroups: [] };
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
  constructor(
    public readonly task: vscode.Task,
    public readonly running: boolean,
    public readonly groupName?: string,
  ) {
    super(task.name, vscode.TreeItemCollapsibleState.None);
    this.tooltip = running ? `${task.name} (running)` : task.name;
    this.iconPath = new vscode.ThemeIcon(
      running ? 'loading~spin' : 'circle-outline',
      running ? new vscode.ThemeColor('charts.green') : undefined,
    );
    const base = running ? 'runningTask' : 'idleTask';
    this.contextValue = groupName ? `${base}InGroup` : base;
  }
}

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
const TASK_DRAG_MIME = 'application/run-my-tasks.task-drag';
const GROUP_DRAG_MIME = 'application/run-my-tasks.group-drag';

interface TaskDragItem { taskName: string; fromGroup?: string; }
interface GroupDragItem { groupName: string; }

// VS Code does not reliably propagate custom DataTransfer values across tree views,
// so we keep the active drag payload in memory instead.
let activeDrag: { tasks?: TaskDragItem[]; groups?: GroupDragItem[] } | null = null;

type GroupsNode = VirtualGroupItem | TaskTreeItem;

export class TasksDragController implements vscode.TreeDragAndDropController<TaskGroupItem | TaskTreeItem> {
  readonly dragMimeTypes = [TASK_DRAG_MIME];
  readonly dropMimeTypes: string[] = [];

  handleDrag(source: readonly (TaskGroupItem | TaskTreeItem)[], dataTransfer: vscode.DataTransfer): void {
    const tasks: TaskDragItem[] = source
      .filter((i): i is TaskTreeItem => i instanceof TaskTreeItem)
      .map(i => ({ taskName: i.task.name }));
    if (tasks.length === 0) { return; }
    activeDrag = { tasks };
    dataTransfer.set(TASK_DRAG_MIME, new vscode.DataTransferItem('1'));
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
    const tasks: TaskDragItem[] = source
      .filter((i): i is TaskTreeItem => i instanceof TaskTreeItem)
      .map(i => ({ taskName: i.task.name, fromGroup: i.groupName }));
    const groups: GroupDragItem[] = source
      .filter((i): i is VirtualGroupItem => i instanceof VirtualGroupItem)
      .map(i => ({ groupName: i.group.name }));
    if (tasks.length === 0 && groups.length === 0) { return; }
    activeDrag = {
      tasks: tasks.length > 0 ? tasks : undefined,
      groups: groups.length > 0 ? groups : undefined,
    };
    if (tasks.length > 0) { dataTransfer.set(TASK_DRAG_MIME, new vscode.DataTransferItem('1')); }
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

    // Cases B and C: task moves
    if (!drag.tasks || drag.tasks.length === 0) { return; }

    let targetGroupName: string | undefined;
    let targetTaskName: string | undefined;
    if (target instanceof VirtualGroupItem) {
      targetGroupName = target.group.name;
    } else if (target instanceof TaskTreeItem && target.groupName) {
      targetGroupName = target.groupName;
      targetTaskName = target.task.name;
    } else {
      // target is undefined: VS Code may pass undefined when dropping on an expanded
      // group header — fall back to a quick-pick so the user can choose the group
      const names = groups.map(g => g.name);
      if (names.length === 0) { return; }
      targetGroupName = await vscode.window.showQuickPick(names, { placeHolder: 'Add to group…' });
    }
    if (!targetGroupName) { return; }

    for (const { taskName, fromGroup } of drag.tasks) {
      if (fromGroup === targetGroupName && targetTaskName && taskName !== targetTaskName) {
        // Case B: reorder within same group — insert before the target task
        groups = groups.map(g => {
          if (g.name !== targetGroupName) { return g; }
          const reordered = g.tasks.filter(t => t !== taskName);
          const insertAt = reordered.indexOf(targetTaskName!);
          if (insertAt === -1) { return { ...g, tasks: [...reordered, taskName] }; }
          reordered.splice(insertAt, 0, taskName);
          return { ...g, tasks: reordered };
        });
      } else if (fromGroup !== targetGroupName) {
        // Case C: cross-group or Tasks→Groups move
        if (fromGroup) {
          groups = groups.map(g =>
            g.name === fromGroup ? { ...g, tasks: g.tasks.filter(t => t !== taskName) } : g,
          );
        }
        groups = groups.map(g =>
          g.name === targetGroupName && !g.tasks.includes(taskName)
            ? { ...g, tasks: [...g.tasks, taskName] }
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

    const runningNames = getRunningNames(this.shared.pendingStop);

    if (!element) {
      return this.shared.virtualGroups.map(g => {
        const count = g.tasks.filter(t => runningNames.has(t)).length;
        return new VirtualGroupItem(g, count);
      });
    }

    if (element instanceof VirtualGroupItem) {
      const groupTasks = element.group.tasks
        .map(name => this.shared.cachedTasks!.find(t => t.name === name))
        .filter((t): t is vscode.Task => t !== undefined);
      return buildTaskItems(groupTasks, runningNames, element.group.name);
    }

    return [];
  }
}

type TasksNode = TaskGroupItem | TaskTreeItem;

export class TasksTreeProvider implements vscode.TreeDataProvider<TasksNode> {
  private _onDidChangeTreeData = new vscode.EventEmitter<TasksNode | undefined | null | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private readonly shared: SharedState) {}

  refresh(): void {
    this.shared.cachedTasks = null;
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

    if (!element) {
      return buildGroups(this.shared.cachedTasks, runningNames);
    }

    if (element instanceof TaskGroupItem) {
      return buildTaskItems(
        this.shared.cachedTasks.filter(t => t.source === element.source),
        runningNames,
      );
    }

    return [];
  }
}
