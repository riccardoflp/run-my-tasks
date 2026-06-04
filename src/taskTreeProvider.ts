import * as vscode from 'vscode';

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
  ) {
    super(task.name, vscode.TreeItemCollapsibleState.None);
    this.tooltip = running ? `${task.name} (running)` : task.name;
    this.iconPath = new vscode.ThemeIcon(
      running ? 'loading~spin' : 'circle-outline',
      running ? new vscode.ThemeColor('charts.green') : undefined,
    );
    this.contextValue = running ? 'runningTask' : 'idleTask';

    if (!running) {
      this.command = {
        command: 'run-my-tasks.runTaskFromTree',
        title: 'Run Task',
        arguments: [this],
      };
    }
  }
}

type TreeNode = TaskGroupItem | TaskTreeItem;

export class TaskTreeProvider implements vscode.TreeDataProvider<TreeNode> {
  private _onDidChangeTreeData = new vscode.EventEmitter<TreeNode | undefined | null | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private cachedTasks: vscode.Task[] | null = null;
  private pendingStop = new Set<string>();

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
      return this.buildGroups(this.cachedTasks, runningNames);
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
    const sourceCounts = new Map<string, number>();
    for (const t of tasks) {
      const running = runningNames.has(t.name) ? 1 : 0;
      sourceCounts.set(t.source, (sourceCounts.get(t.source) ?? 0) + running);
      if (!sourceCounts.has(t.source)) {
        sourceCounts.set(t.source, 0);
      }
    }

    // Collect unique sources, counting running tasks per group
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

  private buildTaskItems(tasks: vscode.Task[], runningNames: Set<string>): TaskTreeItem[] {
    return tasks
      .map(t => new TaskTreeItem(t, runningNames.has(t.name)))
      .sort((a, b) => {
        if (a.running !== b.running) { return a.running ? -1 : 1; }
        return a.task.name.localeCompare(b.task.name);
      });
  }
}
