import * as vscode from 'vscode';

export interface VirtualGroup {
  name: string;
  tasks: string[];
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

    if (!running) {
      this.command = {
        command: 'run-my-tasks.runTaskFromTree',
        title: 'Run Task',
        arguments: [this],
      };
    }
  }
}

type TreeNode = VirtualGroupItem | TaskGroupItem | TaskTreeItem;

export class TaskTreeProvider implements vscode.TreeDataProvider<TreeNode> {
  private _onDidChangeTreeData = new vscode.EventEmitter<TreeNode | undefined | null | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private cachedTasks: vscode.Task[] | null = null;
  private pendingStop = new Set<string>();
  private virtualGroups: VirtualGroup[] = [];

  refresh(): void {
    this.cachedTasks = null;
    this._onDidChangeTreeData.fire();
  }

  markStopped(taskName: string): void {
    this.pendingStop.add(taskName);
    this.refresh();
  }

  clearStopped(taskName: string): void {
    this.pendingStop.delete(taskName);
  }

  setVirtualGroups(groups: VirtualGroup[]): void {
    this.virtualGroups = groups;
    this.refresh();
  }

  getTreeItem(element: TreeNode): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: TreeNode): Promise<TreeNode[]> {
    if (!this.cachedTasks) {
      try {
        this.cachedTasks = await vscode.tasks.fetchTasks();
      } catch {
        return [];
      }
    }

    const runningNames = new Set(
      vscode.tasks.taskExecutions
        .filter(e => !this.pendingStop.has(e.task.name))
        .map(e => e.task.name),
    );

    if (!element) {
      const virtualItems = this.virtualGroups.map(g => {
        const count = g.tasks.filter(t => runningNames.has(t)).length;
        return new VirtualGroupItem(g, count);
      });
      return [...virtualItems, ...this.buildGroups(this.cachedTasks, runningNames)];
    }

    if (element instanceof VirtualGroupItem) {
      const groupTasks = this.cachedTasks.filter(t =>
        element.group.tasks.includes(t.name),
      );
      return this.buildTaskItems(groupTasks, runningNames, element.group.name);
    }

    if (element instanceof TaskGroupItem) {
      return this.buildTaskItems(
        this.cachedTasks.filter(t => t.source === element.source),
        runningNames,
      );
    }

    return [];
  }

  private buildGroups(tasks: vscode.Task[], runningNames: Set<string>): TaskGroupItem[] {
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

  private buildTaskItems(tasks: vscode.Task[], runningNames: Set<string>, groupName?: string): TaskTreeItem[] {
    return tasks
      .map(t => new TaskTreeItem(t, runningNames.has(t.name), groupName))
      .sort((a, b) => {
        if (a.running !== b.running) { return a.running ? -1 : 1; }
        return a.task.name.localeCompare(b.task.name);
      });
  }
}
