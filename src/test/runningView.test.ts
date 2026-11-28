import * as assert from 'assert';
import * as vscode from 'vscode';
import { ExtensionApi } from '../extension';
import { taskKey } from '../taskIdentity';
import { LaunchTreeItem, RunningTreeProvider, TaskTreeItem } from '../taskTreeProvider';
import {
  disposeAllTerminals,
  fakeInputBox,
  getApi,
  getTask,
  restoreStubs,
  runningNames,
  stopAllDebugSessions,
  stopAllTasks,
  waitFor,
  waitForDebugging,
  waitForRunning,
} from './helpers';

const run = (command: string, ...args: unknown[]) =>
  vscode.commands.executeCommand(`run-my-tasks.${command}`, ...args);

suite('Running view', () => {
  let api: ExtensionApi;

  suiteSetup(async () => { api = await getApi(); });

  setup(() => { api.shared.pendingStop.clear(); });

  teardown(async () => {
    restoreStubs();
    await stopAllTasks();
    await stopAllDebugSessions();
    await disposeAllTerminals();
  });

  const shown = () => new RunningTreeProvider(api.shared).getChildren();
  const labels = () => shown().map(i => i.label);
  const start = async (name: string) => {
    await vscode.tasks.executeTask(await getTask(name));
    await waitForRunning(name);
  };

  test('is empty, without a badge, when nothing runs', async () => {
    assert.deepStrictEqual(shown(), []);
    assert.strictEqual(api.views.running.badge, undefined);
  });

  test('lists the running tasks in the order they started, with their stop button and terminal', async () => {
    await start('long-running-2');
    await start('long-running');
    const items = shown();
    assert.deepStrictEqual(items.map(i => i.label), ['long-running-2', 'long-running']);
    assert.ok(items.every(i => i instanceof TaskTreeItem && i.running));
    // The stop button and the context menu of a running task; a click shows its terminal
    assert.deepStrictEqual(items.map(i => i.contextValue), ['runningTask', 'runningTask']);
    assert.strictEqual(items[0].command?.command, 'run-my-tasks.focusTaskTerminal');
    // A task of tasks.json does not repeat its source
    assert.strictEqual(items[0].description, undefined);
    await waitFor(() => api.views.running.badge?.value === 2, 'the badge to count the tasks');
  });

  test('a task stopped leaves it right away, and so does the badge', async () => {
    const task = await getTask('long-running');
    await start('long-running');
    await waitFor(() => api.views.running.badge?.value === 1, 'the badge');
    await run('stopTaskFromTree', new TaskTreeItem(task, true));
    assert.ok(api.shared.pendingStop.has(taskKey(task)));
    assert.deepStrictEqual(labels(), []);
    assert.strictEqual(api.views.running.badge, undefined);
    await waitFor(() => runningNames().length === 0, 'the task to stop');
  });

  test('lists the launch configurations being debugged, those of a compound one by one', async () => {
    await vscode.debug.startDebugging(vscode.workspace.workspaceFolders![0], 'debug-both');
    await waitForDebugging('debug-idle');
    await waitForDebugging('debug-idle-2');
    await start('long-running');
    const items = shown();
    // The tasks first
    assert.deepStrictEqual(items.map(i => i.label).sort(), ['debug-idle', 'debug-idle-2', 'long-running']);
    assert.strictEqual(items[0].label, 'long-running');
    const launches = items.slice(1) as LaunchTreeItem[];
    assert.ok(launches.every(i => i instanceof LaunchTreeItem && i.running));
    assert.deepStrictEqual(launches.map(i => i.contextValue), ['runningLaunch', 'runningLaunch']);
    assert.deepStrictEqual(launches.map(i => i.description), ['node', 'node']);
    await waitFor(() => api.views.running.badge?.value === 3, 'the badge to count them all');

    // The stop button of a launch configuration
    await run('stopLaunchFromTree', launches.find(i => i.label === 'debug-idle'));
    await waitFor(() => !labels().includes('debug-idle'), 'debug-idle to stop');
    assert.ok(labels().includes('debug-idle-2'));
  });

  test('lists a debug session started without launch.json under its name', async () => {
    await vscode.debug.startDebugging(vscode.workspace.workspaceFolders![0], {
      name: 'ad-hoc',
      type: 'node',
      request: 'launch',
      program: '${workspaceFolder}/idle.js',
      console: 'internalConsole',
      internalConsoleOptions: 'neverOpen',
    });
    await waitForDebugging('ad-hoc');
    assert.deepStrictEqual(labels(), ['ad-hoc']);
  });

  test('Stop All stops every task and debug session', async () => {
    await start('long-running');
    await start('long-running-2');
    await vscode.debug.startDebugging(vscode.workspace.workspaceFolders![0], 'debug-idle');
    await waitForDebugging('debug-idle');
    await run('stopAll');
    // Shown stopped right away
    assert.deepStrictEqual(labels().filter(l => l !== 'debug-idle'), []);
    await waitFor(() => runningNames().length === 0, 'the tasks to stop');
    await waitFor(() => labels().length === 0, 'the debug session to stop');
    await waitFor(() => api.views.running.badge === undefined, 'the badge to go away');
  });

  test('the search narrows it, and tells so', async () => {
    await start('long-running');
    await start('long-running-2');
    const input = fakeInputBox();
    await run('search');
    try {
      input.type('running-2');
      assert.deepStrictEqual(labels(), ['long-running-2']);
      assert.strictEqual(api.views.running.message, 'Search results for "running-2"');
      // The badge counts what runs, searched or not
      await waitFor(() => api.views.running.badge?.value === 2, 'the badge to count both');
    } finally {
      input.accept();
      await run('clearSearch');
    }
    assert.deepStrictEqual(labels(), ['long-running', 'long-running-2']);
  });
});
