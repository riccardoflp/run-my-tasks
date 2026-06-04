import * as vscode from 'vscode';
import { createStatusBarItem } from './statusBar';
import { showTaskPicker } from './taskPicker';
import { TaskTreeItem, TaskTreeProvider, VirtualGroup, VirtualGroupItem } from './taskTreeProvider';

const GROUPS_KEY = 'virtualGroups';

export function activate(context: vscode.ExtensionContext): void {
  // Status bar picker command
  context.subscriptions.push(
    vscode.commands.registerCommand('run-my-tasks.showTaskPicker', () => showTaskPicker()),
  );

  createStatusBarItem(context);

  // Side panel tree view
  const treeProvider = new TaskTreeProvider();
  const treeView = vscode.window.createTreeView('run-my-tasks.tasksView', {
    treeDataProvider: treeProvider,
    showCollapseAll: false,
  });
  context.subscriptions.push(treeView);

  // Load persisted groups on startup
  treeProvider.setVirtualGroups(context.workspaceState.get<VirtualGroup[]>(GROUPS_KEY, []));

  const loadGroups = (): VirtualGroup[] =>
    context.workspaceState.get<VirtualGroup[]>(GROUPS_KEY, []);

  const saveGroups = async (groups: VirtualGroup[]): Promise<void> => {
    await context.workspaceState.update(GROUPS_KEY, groups);
    treeProvider.setVirtualGroups(groups);
  };

  // Refresh tree on task lifecycle events
  context.subscriptions.push(
    vscode.tasks.onDidStartTask(() => treeProvider.refresh()),
    vscode.tasks.onDidEndTask(e => {
      treeProvider.clearStopped(e.execution.task.name);
      treeProvider.refresh();
    }),
  );

  // Refresh button in view title
  context.subscriptions.push(
    vscode.commands.registerCommand('run-my-tasks.refreshTasksView', () => treeProvider.refresh()),
  );

  // Run inline button / click on idle task
  context.subscriptions.push(
    vscode.commands.registerCommand('run-my-tasks.runTaskFromTree', (item: TaskTreeItem) => {
      Promise.resolve(vscode.tasks.executeTask(item.task)).catch((err: unknown) =>
        vscode.window.showErrorMessage(`Failed to run task "${item.task.name}": ${err}`),
      );
    }),
  );

  // Stop inline button on running task
  context.subscriptions.push(
    vscode.commands.registerCommand('run-my-tasks.stopTaskFromTree', (item: TaskTreeItem) => {
      const execution = vscode.tasks.taskExecutions.find(e => e.task.name === item.task.name);
      if (execution) {
        treeProvider.markStopped(item.task.name);
        execution.terminate();
      }
    }),
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

  // Add task to group (palette or context menu on task)
  context.subscriptions.push(
    vscode.commands.registerCommand('run-my-tasks.addTaskToGroup', async (item?: TaskTreeItem) => {
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

      let taskName: string | undefined;
      if (item) {
        taskName = item.task.name;
      } else {
        const allTasks = await vscode.tasks.fetchTasks();
        const pick = await vscode.window.showQuickPick(
          allTasks.map(t => ({ label: t.name, description: t.source })),
          { placeHolder: 'Select task to add' },
        );
        taskName = pick?.label;
      }
      if (!taskName) { return; }

      const groupPick = await vscode.window.showQuickPick(
        groups.map(g => g.name),
        { placeHolder: `Add "${taskName}" to group` },
      );
      if (!groupPick) { return; }

      const task = taskName;
      await saveGroups(groups.map(g =>
        g.name === groupPick && !g.tasks.includes(task)
          ? { ...g, tasks: [...g.tasks, task] }
          : g,
      ));
    }),
  );

  // Remove task from group (palette or context menu on task inside group)
  context.subscriptions.push(
    vscode.commands.registerCommand('run-my-tasks.removeTaskFromGroup', async (item?: TaskTreeItem) => {
      const groups = loadGroups();

      if (item?.groupName) {
        const { groupName, task } = item;
        await saveGroups(groups.map(g =>
          g.name === groupName
            ? { ...g, tasks: g.tasks.filter(t => t !== task.name) }
            : g,
        ));
        return;
      }

      const groupsWithTasks = groups.filter(g => g.tasks.length > 0);
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
      const taskPick = await vscode.window.showQuickPick(
        group.tasks,
        { placeHolder: 'Select task to remove' },
      );
      if (!taskPick) { return; }

      await saveGroups(groups.map(g =>
        g.name === groupPick
          ? { ...g, tasks: g.tasks.filter(t => t !== taskPick) }
          : g,
      ));
    }),
  );

  // Run all idle tasks in group
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
      const runningNames = new Set(vscode.tasks.taskExecutions.map(e => e.task.name));
      const toRun = allTasks.filter(t =>
        group!.tasks.includes(t.name) && !runningNames.has(t.name),
      );
      for (const task of toRun) {
        await vscode.tasks.executeTask(task);
      }
    }),
  );

  // Stop all running tasks in group
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
          treeProvider.markStopped(execution.task.name);
          execution.terminate();
        }
      }
    }),
  );
}

export function deactivate(): void {}
