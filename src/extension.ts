import * as vscode from 'vscode';
import { createStatusBarItem } from './statusBar';
import { showTaskPicker } from './taskPicker';
import { TaskTreeItem, TaskTreeProvider } from './taskTreeProvider';

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

  // Refresh tree on task lifecycle events
  context.subscriptions.push(
    vscode.tasks.onDidStartTask(() => treeProvider.refresh()),
    vscode.tasks.onDidEndTask(() => treeProvider.refresh()),
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
        execution.terminate();
      }
    }),
  );
}

export function deactivate(): void {}
