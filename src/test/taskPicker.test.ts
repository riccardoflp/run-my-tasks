import * as assert from 'assert';
import * as vscode from 'vscode';
import { createStatusBarItem } from '../statusBar';
import { showTaskPicker } from '../taskPicker';
import {
  answerQuickPicks,
  cancel,
  captureMessages,
  disposeAllTerminals,
  restoreStubs,
  runningNames,
  stopAllTasks,
  stub,
  waitForRunning,
} from './helpers';

function withSettings(values: Record<string, unknown>): void {
  const original = vscode.workspace.getConfiguration;
  stub(vscode.workspace, 'getConfiguration', ((section?: string) => {
    const config = original(section);
    return {
      ...config,
      get: (key: string, fallback?: unknown) => (key in values ? values[key] : config.get(key, fallback)),
    };
  }) as typeof vscode.workspace.getConfiguration);
}

suite('Task picker', () => {
  teardown(async () => {
    restoreStubs();
    await stopAllTasks();
    disposeAllTerminals();
  });

  test('lists tasks by source, Workspace first, sorted by name, with the command as detail', async () => {
    const offered = answerQuickPicks(cancel) as vscode.QuickPickItem[][];
    await showTaskPicker();
    const [items] = offered;

    assert.strictEqual(items[0].kind, vscode.QuickPickItemKind.Separator);
    assert.strictEqual(items[0].label, 'Workspace');

    const end = items.findIndex((i, n) => n > 0 && i.kind === vscode.QuickPickItemKind.Separator);
    const workspace = items.slice(1, end === -1 ? undefined : end);
    assert.deepStrictEqual(
      workspace.map(i => i.label),
      ['$(run) compound', '$(run) long-running', '$(run) long-running-2', '$(run) quick'],
    );
    assert.strictEqual(workspace[3].detail, 'node -e "0"');
    assert.strictEqual(workspace[0].detail, undefined, 'a compound task has no command to show');
  });

  test('hides the detail line when runMyTasks.showTaskType is off', async () => {
    withSettings({ showTaskType: false });
    const offered = answerQuickPicks(cancel) as vscode.QuickPickItem[][];
    await showTaskPicker();
    const [items] = offered;
    assert.ok(items.every(i => i.detail === undefined));
  });

  test('runs the picked task', async () => {
    answerQuickPicks(items => items.find(i => typeof i !== 'string' && i.label === '$(run) long-running'));
    await showTaskPicker();
    await waitForRunning('long-running');
  });

  test('runs nothing when cancelled', async () => {
    answerQuickPicks(cancel);
    await showTaskPicker();
    assert.deepStrictEqual(runningNames(), []);
  });

  test('tells the user when there are no tasks', async () => {
    const messages = captureMessages();
    stub(vscode.tasks, 'fetchTasks', (async () => []) as typeof vscode.tasks.fetchTasks);
    await showTaskPicker();
    assert.deepStrictEqual(messages.info, ['No tasks found. Add tasks to .vscode/tasks.json to get started.']);
  });

  test('reports a failure to fetch tasks', async () => {
    const messages = captureMessages();
    stub(vscode.tasks, 'fetchTasks', (async () => { throw new Error('boom'); }) as typeof vscode.tasks.fetchTasks);
    await showTaskPicker();
    assert.deepStrictEqual(messages.error, ['Failed to fetch tasks: Error: boom']);
  });

  test('the showTaskPicker command opens the picker', async () => {
    const offered = answerQuickPicks(cancel);
    await vscode.commands.executeCommand('run-my-tasks.showTaskPicker');
    assert.strictEqual(offered.length, 1);
  });

  suite('status bar', () => {
    const create = () => {
      const subscriptions: vscode.Disposable[] = [];
      const item = createStatusBarItem({ subscriptions } as unknown as vscode.ExtensionContext);
      subscriptions.forEach(d => d.dispose());
      return item;
    };

    test('opens the picker, on the left with priority 100 by default', async () => {
      const item = create();
      assert.strictEqual(item.command, 'run-my-tasks.showTaskPicker');
      assert.strictEqual(item.text, '$(run) Tasks');
      assert.strictEqual(item.alignment, vscode.StatusBarAlignment.Left);
      assert.strictEqual(item.priority, 100);
    });

    test('follows the alignment and priority settings', async () => {
      withSettings({ statusBarAlignment: 'right', statusBarPriority: 5 });
      const item = create();
      assert.strictEqual(item.alignment, vscode.StatusBarAlignment.Right);
      assert.strictEqual(item.priority, 5);
    });
  });
});
