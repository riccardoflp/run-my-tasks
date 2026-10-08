import * as assert from 'assert';
import * as vscode from 'vscode';
import { TaskTreeItem } from '../taskTreeProvider';
import { disposeAllTerminals, getTask, stopAllTasks, waitFor } from './helpers';

suite('focusTaskTerminal', () => {
  teardown(async () => {
    await stopAllTasks();
    disposeAllTerminals();
  });

  test('clicking a running task item is wired to the focus command', async () => {
    const task = await getTask('long-running');
    const item = new TaskTreeItem(task, true);
    assert.strictEqual(item.command?.command, 'run-my-tasks.focusTaskTerminal');
    assert.deepStrictEqual(item.command?.arguments, [item]);
  });

  test('clicking an idle task item does nothing', async () => {
    const task = await getTask('long-running');
    assert.strictEqual(new TaskTreeItem(task, false).command, undefined);
  });

  test('focuses the terminal of the running task', async () => {
    const task = await getTask('long-running');
    await vscode.tasks.executeTask(task);
    const taskTerminal = await waitFor(
      () => vscode.window.terminals.find(t => t.name.includes('long-running')),
      'the task terminal to open',
    );

    // Move focus elsewhere so the command has something to change
    const other = vscode.window.createTerminal('other');
    other.show();
    await waitFor(() => vscode.window.activeTerminal === other, 'the other terminal to become active');

    await vscode.commands.executeCommand('run-my-tasks.focusTaskTerminal', new TaskTreeItem(task, true));

    await waitFor(() => vscode.window.activeTerminal === taskTerminal, 'the task terminal to become active');
  });

  test('leaves the active terminal alone when the task has no terminal', async () => {
    const other = vscode.window.createTerminal('other');
    other.show();
    await waitFor(() => vscode.window.activeTerminal === other, 'the other terminal to become active');

    const task = await getTask('long-running');
    await vscode.commands.executeCommand('run-my-tasks.focusTaskTerminal', new TaskTreeItem(task, true));

    assert.strictEqual(vscode.window.activeTerminal, other);
  });
});
