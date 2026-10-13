import * as assert from 'assert';
import * as path from 'path';
import * as vscode from 'vscode';
import { ExtensionApi } from '../extension';
import { getLaunchConfigs, runningLaunchNames } from '../launchConfigs';
import {
  createSharedState,
  GroupsTreeProvider,
  LaunchTreeItem,
  LaunchTreeProvider,
  TaskTreeItem,
  VirtualGroupItem,
} from '../taskTreeProvider';
import {
  answerQuickPicks,
  captureMessages,
  disposeAllTerminals,
  getApi,
  getLaunch,
  pick,
  restoreStubs,
  runningNames,
  stopAllDebugSessions,
  stopAllTasks,
  stub,
  waitFor,
  waitForDebugging,
  waitForRunning,
} from './helpers';

const run = (command: string, ...args: unknown[]) =>
  vscode.commands.executeCommand(`run-my-tasks.${command}`, ...args);

const launchItem = (name: string) => new LaunchTreeItem(getLaunch(name), false);

const debugging = () => [...runningLaunchNames()].sort();

suite('Launch configurations', () => {
  let api: ExtensionApi;

  suiteSetup(async () => { api = await getApi(); });

  setup(() => api.saveGroups([]));

  teardown(async () => {
    restoreStubs();
    await stopAllDebugSessions();
    await stopAllTasks();
    disposeAllTerminals();
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });

  test('reads the configurations then the compounds of launch.json', () => {
    const folder = vscode.workspace.workspaceFolders![0];
    assert.deepStrictEqual(getLaunchConfigs(), [
      { name: 'debug-idle', folder, type: 'node', request: 'launch' },
      { name: 'debug-idle-2', folder, type: 'node', request: 'launch' },
      { name: 'debug-both', folder, compound: ['debug-idle', 'debug-idle-2'] },
    ]);
  });

  suite('view', () => {
    const items = () => new LaunchTreeProvider(createSharedState()).getChildren();

    test('lists the launch configurations with their debugger type', () => {
      assert.deepStrictEqual(
        items().map(i => [i.label, i.description, i.contextValue]),
        [
          ['debug-idle', 'node', 'idleLaunch'],
          ['debug-idle-2', 'node', 'idleLaunch'],
          ['debug-both', 'compound', 'idleLaunch'],
        ],
      );
      assert.ok(items().every(i => i.command === undefined), 'clicking an idle configuration does nothing');
    });

    test('marks a configuration being debugged as running, and its click shows the Debug Console', async () => {
      await vscode.debug.startDebugging(getLaunch('debug-idle').folder, 'debug-idle');
      await waitForDebugging('debug-idle');

      const [idle, idle2, both] = items();
      assert.deepStrictEqual([idle.running, idle2.running, both.running], [true, false, false]);
      assert.strictEqual(idle.contextValue, 'runningLaunch');

      const commands = await vscode.commands.getCommands(true);
      assert.ok(idle.command && commands.includes(idle.command.command));
    });

    test('a compound is running once all its configurations are', async () => {
      await run('debugLaunchFromTree', launchItem('debug-both'));
      await waitFor(() => debugging().length === 2, 'both configurations to start');

      assert.deepStrictEqual(items().map(i => i.running), [true, true, true]);
    });
  });

  suite('commands', () => {
    test('debugLaunchFromTree starts debugging and stopLaunchFromTree stops it', async () => {
      await run('debugLaunchFromTree', launchItem('debug-idle'));
      await waitForDebugging('debug-idle');

      await run('stopLaunchFromTree', launchItem('debug-idle'));
      await waitFor(() => debugging().length === 0, 'the session to stop');
    });

    test('stopLaunchFromTree leaves the other sessions alone', async () => {
      await run('debugLaunchFromTree', launchItem('debug-idle'));
      await run('debugLaunchFromTree', launchItem('debug-idle-2'));
      await waitFor(() => debugging().length === 2, 'both sessions to start');

      await run('stopLaunchFromTree', launchItem('debug-idle'));
      await waitFor(() => debugging().length === 1, 'the session to stop');
      assert.deepStrictEqual(debugging(), ['debug-idle-2']);
    });

    test('stopping a compound stops all its configurations', async () => {
      await run('debugLaunchFromTree', launchItem('debug-both'));
      await waitFor(() => debugging().length === 2, 'both configurations to start');

      await run('stopLaunchFromTree', launchItem('debug-both'));
      await waitFor(() => debugging().length === 0, 'the sessions to stop');
    });

    test('runLaunchFromTree starts the configuration without debugging', async () => {
      const calls: unknown[][] = [];
      stub(vscode.debug, 'startDebugging', (async (...args: unknown[]) => {
        calls.push(args);
        return true;
      }) as typeof vscode.debug.startDebugging);

      await run('runLaunchFromTree', launchItem('debug-idle'));
      await run('debugLaunchFromTree', launchItem('debug-idle'));

      const folder = vscode.workspace.workspaceFolders![0];
      assert.deepStrictEqual(calls, [
        [folder, 'debug-idle', { noDebug: true }],
        [folder, 'debug-idle', { noDebug: false }],
      ]);
    });

    test('reports a failure to start', async () => {
      const messages = captureMessages();
      stub(vscode.debug, 'startDebugging', (async () => {
        throw new Error('boom');
      }) as typeof vscode.debug.startDebugging);
      await run('debugLaunchFromTree', launchItem('debug-idle'));
      assert.deepStrictEqual(messages.error, ['Failed to start "debug-idle": Error: boom']);
    });

    test('openLaunchJson opens .vscode/launch.json of the workspace', async () => {
      await run('openLaunchJson');
      const file = vscode.window.activeTextEditor?.document.uri.fsPath ?? '';
      assert.strictEqual(path.basename(path.dirname(file)), '.vscode');
      assert.strictEqual(path.basename(file), 'launch.json');
    });
  });

  suite('in groups', () => {
    test('are listed after the tasks, in the user-defined order, skipping unknown ones', async () => {
      const shared = createSharedState();
      shared.virtualGroups = [{ name: 'Dev', tasks: ['quick'], launches: ['debug-both', 'missing', 'debug-idle'] }];
      const provider = new GroupsTreeProvider(shared);

      const [root] = await provider.getChildren();
      const children = await provider.getChildren(root);

      assert.deepStrictEqual(children.map(c => c.label), ['quick', 'debug-both', 'debug-idle']);
      assert.ok(children[0] instanceof TaskTreeItem);
      assert.ok(children.slice(1).every(c => c instanceof LaunchTreeItem && c.groupName === 'Dev'));
      assert.strictEqual(children[1].contextValue, 'idleLaunchInGroup');
    });

    test('a configuration being debugged is counted on its group', async () => {
      await vscode.debug.startDebugging(getLaunch('debug-idle').folder, 'debug-idle');
      await waitForDebugging('debug-idle');

      const shared = createSharedState();
      shared.virtualGroups = [{ name: 'Dev', tasks: ['quick'], launches: ['debug-idle', 'debug-idle-2'] }];
      const provider = new GroupsTreeProvider(shared);

      const [root] = await provider.getChildren();
      assert.strictEqual(root.description, '1 running');
      const children = await provider.getChildren(root);
      assert.deepStrictEqual(children.map(c => c.contextValue), [
        'idleTaskInGroup', 'runningLaunchInGroup', 'idleLaunchInGroup',
      ]);
    });

    test('runGroup starts the tasks and the configurations that are not already running', async () => {
      await api.saveGroups([{ name: 'Dev', tasks: ['long-running'], launches: ['debug-idle', 'debug-idle-2'] }]);
      await vscode.debug.startDebugging(getLaunch('debug-idle').folder, 'debug-idle');
      await waitForDebugging('debug-idle');

      const started: unknown[] = [];
      const startDebugging = vscode.debug.startDebugging;
      stub(vscode.debug, 'startDebugging', ((...args: Parameters<typeof startDebugging>) => {
        started.push(args[1]);
        return startDebugging(...args);
      }) as typeof vscode.debug.startDebugging);

      await run('runGroup', new VirtualGroupItem(api.shared.virtualGroups[0], 1));
      await waitForRunning('long-running');
      await waitForDebugging('debug-idle-2');
      assert.deepStrictEqual(started, ['debug-idle-2']);
    });

    test('stopGroup stops the tasks and the configurations of the group only', async () => {
      await api.saveGroups([{ name: 'Dev', tasks: ['long-running'], launches: ['debug-idle'] }]);
      await run('runGroup', new VirtualGroupItem(api.shared.virtualGroups[0], 0));
      await vscode.debug.startDebugging(getLaunch('debug-idle-2').folder, 'debug-idle-2');
      await waitForRunning('long-running');
      await waitFor(() => debugging().length === 2, 'both sessions to start');

      answerQuickPicks(pick('Dev'));
      await run('stopGroup');

      await waitFor(() => debugging().length === 1 && runningNames().length === 0, 'the group to stop');
      assert.deepStrictEqual(debugging(), ['debug-idle-2']);
    });
  });
});
