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

// VS Code automatically places dragged tree items under this MIME type (lowercase viewId)
const TASKS_VIEW_MIME = 'application/vnd.code.tree.run-my-tasks.tasksview';
const GROUPS_VIEW_MIME = 'application/vnd.code.tree.run-my-tasks.groupsview';

type GroupsNode = VirtualGroupItem | TaskTreeItem;

export class TasksDragController implements vscode.TreeDragAndDropController<TaskGroupItem | TaskTreeItem> {
  readonly dragMimeTypes: string[] = [];
  readonly dropMimeTypes: string[] = [];
}

export class GroupsDragController implements vscode.TreeDragAndDropController<GroupsNode> {
  readonly dragMimeTypes: string[] = [];
  readonly dropMimeTypes = [TASKS_VIEW_MIME, GROUPS_VIEW_MIME];

  constructor(
    private readonly shared: SharedState,
    private readonly onDrop: (groups: VirtualGroup[]) => Promise<void>,
  ) {}

  async handleDrop(target: GroupsNode | undefined, dataTransfer: vscode.DataTransfer): Promise<void> {
    let targetGroupName: string | undefined;
    if (target instanceof VirtualGroupItem) {
      targetGroupName = target.group.name;
    } else if (target instanceof TaskTreeItem && target.groupName) {
      targetGroupName = target.groupName;
    }
    if (!targetGroupName) { return; }

    const transferItem = dataTransfer.get(TASKS_VIEW_MIME) ?? dataTransfer.get(GROUPS_VIEW_MIME);
    if (!transferItem) { return; }

    // VS Code provides the actual tree item instances via .value
    const dragged = transferItem.value as Array<VirtualGroupItem | TaskGroupItem | TaskTreeItem>;
    if (!Array.isArray(dragged)) { return; }

    const tasks = dragged.filter((item): item is TaskTreeItem => item instanceof TaskTreeItem);
    if (tasks.length === 0) { return; }

    let groups = [...this.shared.virtualGroups];
    for (const item of tasks) {
      const taskName = item.task.name;
      const fromGroup = item.groupName;
      if (fromGroup === targetGroupName) { continue; }
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
      const groupTasks = this.shared.cachedTasks.filter(t =>
        element.group.tasks.includes(t.name),
      );
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
