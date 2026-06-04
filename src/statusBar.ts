import * as vscode from 'vscode';

export function createStatusBarItem(context: vscode.ExtensionContext): vscode.StatusBarItem {
  const config = vscode.workspace.getConfiguration('runMyTasks');

  const alignmentSetting = config.get<string>('statusBarAlignment', 'left');
  const alignment = alignmentSetting === 'right'
    ? vscode.StatusBarAlignment.Right
    : vscode.StatusBarAlignment.Left;
  const priority = config.get<number>('statusBarPriority', 100);

  const item = vscode.window.createStatusBarItem(alignment, priority);
  item.text = '$(run) Tasks';
  item.tooltip = 'Click to run a workspace task';
  item.command = 'run-my-tasks.showTaskPicker';
  item.show();

  context.subscriptions.push(item);
  return item;
}
