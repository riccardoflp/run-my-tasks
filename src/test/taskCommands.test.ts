import * as assert from 'assert';
import * as path from 'path';
import * as vscode from 'vscode';
import { ExtensionApi } from '../extension';
import { taskKey, terminateTask } from '../taskIdentity';
import { groupsOf, TaskTreeItem, VirtualGroupItem } from '../taskTreeProvider';
import {
  answerQuickPicks,
  captureMessages,
  disposeAllTerminals,
  getApi,
  getTask,
  pick,
  restoreStubs,
  runningNames,
  stopAllTasks,
  stub,
  waitFor,
  waitForRunning,
} from './helpers';

const run = (command: string, ...args: unknown[]) =>
  vscode.commands.executeCommand(`run-my-tasks.${command}`, ...args);

suite('Task commands', () => {
  let api: ExtensionApi;

  suiteSetup(async () => { api = await getApi(); });

  setup(async () => {
    await api.saveGroups([]);
    api.shared.pendingStop.clear();
  });

  teardown(async () => {
    restoreStubs();
    await stopAllTasks();
    await disposeAllTerminals();
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });

  test('runTaskFromTree starts the task', async () => {
    await run('runTaskFromTree', new TaskTreeItem(await getTask('long-running'), false));
    await waitForRunning('long-running');
  });

  test('stopTaskFromTree stops the task and shows it idle right away', async () => {
    const task = await getTask('long-running');
    await vscode.tasks.executeTask(task);
    await waitForRunning('long-running');

    await run('stopTaskFromTree', new TaskTreeItem(task, true));
    assert.ok(api.shared.pendingStop.has(taskKey(task)), 'task should be shown as stopped immediately');

    await waitFor(() => runningNames().length === 0, 'the task to stop');
    await waitFor(() => !api.shared.pendingStop.has(taskKey(task)), 'pendingStop to be cleared');
  });

  test('starting a task clears a stale pending stop', async () => {
    const task = await getTask('long-running');
    api.shared.pendingStop.add(taskKey(task));
    await vscode.tasks.executeTask(task);
    await waitFor(() => !api.shared.pendingStop.has(taskKey(task)), 'pendingStop to be cleared');
  });

  test('starting and ending a task keeps the cached task list', async () => {
    const cached = await vscode.tasks.fetchTasks();
    api.shared.cachedTasks = cached;
    const ended = new Promise<void>(resolve => {
      const listener = vscode.tasks.onDidEndTask(e => {
        if (e.execution.task.name === 'quick') { listener.dispose(); resolve(); }
      });
    });
    await vscode.tasks.executeTask(await getTask('quick'));
    await ended;
    assert.strictEqual(api.shared.cachedTasks, cached);
  });

  suite('terminateTask', () => {
    // An execution of the task that only records being terminated
    const fakeExecution = (task: vscode.Task) => {
      const execution = { task, terminated: false, terminate: () => { execution.terminated = true; } };
      return execution;
    };

    test('a task VS Code has not finished starting is terminated once it has started', async () => {
      const task = await getTask('long-running');
      const early = fakeExecution(task);
      terminateTask(early as unknown as vscode.TaskExecution);
      await vscode.tasks.executeTask(task);
      await waitFor(() => runningNames().length === 0, 'the task to stop as soon as it starts');
      // Through the execution VS Code reported started
      assert.strictEqual(early.terminated, false);
    });

    test('a task that never starts is not terminated once the wait is over', async () => {
      const early = fakeExecution(await getTask('long-running-2'));
      terminateTask(early as unknown as vscode.TaskExecution);
      await new Promise(r => setTimeout(r, 5500));
      assert.strictEqual(early.terminated, false);
      assert.deepStrictEqual(runningNames(), []);
    });
  });

  suite('runGroup', () => {
    test('starts every task of the group that is not already running', async () => {
      await api.saveGroups([
        { name: 'Dev', tasks: ['long-running', 'long-running-2'] },
        { name: 'Other', tasks: ['quick'] },
      ]);
      await vscode.tasks.executeTask(await getTask('long-running'));
      await waitForRunning('long-running');

      const started: string[] = [];
      const executeTask = vscode.tasks.executeTask;
      stub(vscode.tasks, 'executeTask', (task: vscode.Task) => {
        started.push(task.name);
        return executeTask(task);
      });
      await run('runGroup', new VirtualGroupItem(groupsOf(api.shared)[0], 1));
      await waitForRunning('long-running-2');
      assert.deepStrictEqual(started, ['long-running-2']);
      assert.deepStrictEqual(runningNames(), ['long-running', 'long-running-2']);
    });

    test('starts the tasks in the order of the group', async () => {
      await api.saveGroups([{ name: 'Dev', tasks: ['long-running-2', 'quick', 'long-running'] }]);
      const started: string[] = [];
      const executeTask = vscode.tasks.executeTask;
      stub(vscode.tasks, 'executeTask', (task: vscode.Task) => {
        started.push(task.name);
        return executeTask(task);
      });
      await run('runGroup', new VirtualGroupItem(groupsOf(api.shared)[0], 0));
      assert.deepStrictEqual(started, ['long-running-2', 'quick', 'long-running']);
    });

    test('a task failing to start does not stop the others', async () => {
      await api.saveGroups([{ name: 'Dev', tasks: ['quick', 'long-running'] }]);
      const messages = captureMessages();
      const executeTask = vscode.tasks.executeTask;
      stub(vscode.tasks, 'executeTask', (async (task: vscode.Task) => {
        if (task.name === 'quick') { throw new Error('boom'); }
        return executeTask(task);
      }) as typeof vscode.tasks.executeTask);
      await run('runGroup', new VirtualGroupItem(groupsOf(api.shared)[0], 0));
      await waitForRunning('long-running');
      assert.deepStrictEqual(messages.error, ['Failed to run task "quick": boom']);
    });

    test('asks which group to run when run from the palette', async () => {
      await api.saveGroups([{ name: 'Dev', tasks: ['long-running'] }, { name: 'Build', tasks: ['long-running-2'] }]);
      answerQuickPicks(pick('Build'));
      await run('runGroup');
      await waitForRunning('long-running-2');
      assert.deepStrictEqual(runningNames(), ['long-running-2']);
    });

    test('tells the user when there are no groups', async () => {
      const messages = captureMessages();
      await run('runGroup');
      assert.deepStrictEqual(messages.info, ['No groups defined.']);
    });
  });

  suite('stopGroup', () => {
    test('stops only the tasks of the group', async () => {
      await api.saveGroups([{ name: 'Dev', tasks: ['long-running'] }]);
      await vscode.tasks.executeTask(await getTask('long-running'));
      await vscode.tasks.executeTask(await getTask('long-running-2'));
      await waitForRunning('long-running');
      await waitForRunning('long-running-2');

      await run('stopGroup', new VirtualGroupItem(groupsOf(api.shared)[0], 1));

      await waitFor(() => runningNames().length === 1, 'the group task to stop');
      assert.deepStrictEqual(runningNames(), ['long-running-2']);
    });

    test('asks which group to stop when run from the palette', async () => {
      await api.saveGroups([{ name: 'Dev', tasks: ['long-running'] }]);
      await vscode.tasks.executeTask(await getTask('long-running'));
      await waitForRunning('long-running');
      answerQuickPicks(pick('Dev'));
      await run('stopGroup');
      await waitFor(() => runningNames().length === 0, 'the group task to stop');
    });

    test('tells the user when there are no groups', async () => {
      const messages = captureMessages();
      await run('stopGroup');
      assert.deepStrictEqual(messages.info, ['No groups defined.']);
    });
  });

  test('refreshTasksView drops the cached task list', async () => {
    // The views refetch lazily when shown, so emptying the cache is the observable effect
    api.shared.cachedTasks = [];
    await run('refreshTasksView');
    assert.strictEqual(api.shared.cachedTasks, null);
  });

  suite('openTasksJson', () => {
    test('opens .vscode/tasks.json of the workspace', async () => {
      await run('openTasksJson');
      const file = vscode.window.activeTextEditor?.document.uri.fsPath ?? '';
      assert.strictEqual(path.basename(path.dirname(file)), '.vscode');
      assert.strictEqual(path.basename(file), 'tasks.json');
    });

    test('reports a missing tasks.json', async () => {
      const messages = captureMessages();
      stub(vscode.workspace, 'openTextDocument', (async () => {
        throw new Error('not found');
      }) as typeof vscode.workspace.openTextDocument);
      await run('openTasksJson');
      assert.deepStrictEqual(messages.error, ['tasks.json not found in .vscode/']);
    });
  });

  test('focusTaskTerminal tells the user when the task has no terminal', async () => {
    const messages = captureMessages();
    await run('focusTaskTerminal', new TaskTreeItem(await getTask('compound'), true));
    assert.deepStrictEqual(messages.info, ['No terminal found for task "compound".']);
  });
});
