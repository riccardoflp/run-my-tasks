import * as assert from 'assert';
import * as vscode from 'vscode';
import { ExtensionApi } from '../extension';
import {
  createSharedState,
  GroupsTreeProvider,
  LaunchTreeProvider,
  TasksTreeProvider,
} from '../taskTreeProvider';
import { fakeInputBox, getApi, restoreStubs } from './helpers';

const run = (command: string, ...args: unknown[]) =>
  vscode.commands.executeCommand(`run-my-tasks.${command}`, ...args);

suite('Search', () => {
  suite('Tasks view', () => {
    async function workspaceTasks(filter: string): Promise<string[]> {
      const shared = createSharedState();
      shared.filter = filter;
      const provider = new TasksTreeProvider(shared);
      const workspace = (await provider.getChildren()).find(r => r.label === 'Workspace');
      return workspace ? (await provider.getChildren(workspace)).map(i => i.label as string).sort() : [];
    }

    test('keeps the tasks whose name contains the text, ignoring case', async () => {
      assert.deepStrictEqual(await workspaceTasks('LONG'), ['long-running', 'long-running-2']);
    });

    test('requires every word to match', async () => {
      assert.deepStrictEqual(await workspaceTasks('running 2'), ['long-running-2']);
    });

    test('matches the source name too', async () => {
      assert.deepStrictEqual(await workspaceTasks('workspace qui'), ['quick']);
      assert.deepStrictEqual(
        await workspaceTasks('workspace'),
        ['compound', 'long-running', 'long-running-2', 'quick'],
      );
    });

    test('hides the sources left without tasks', async () => {
      assert.deepStrictEqual(await workspaceTasks('no-such-task'), []);
    });
  });

  suite('Groups view', () => {
    async function visible(filter: string): Promise<Record<string, string[]>> {
      const shared = createSharedState();
      shared.filter = filter;
      shared.virtualGroups = [
        { name: 'Dev', tasks: ['quick', 'long-running'], launches: ['debug-idle'] },
        { name: 'Build', tasks: ['compound'] },
        { name: 'Empty', tasks: [] },
      ];
      const provider = new GroupsTreeProvider(shared);
      const result: Record<string, string[]> = {};
      for (const root of await provider.getChildren()) {
        result[root.label as string] = (await provider.getChildren(root)).map(i => i.label as string);
      }
      return result;
    }

    test('shows every group, even empty, when not searching', async () => {
      assert.deepStrictEqual(Object.keys(await visible('')), ['Dev', 'Build', 'Empty']);
    });

    test('keeps the matching tasks and launch configurations, hiding the groups left empty', async () => {
      assert.deepStrictEqual(await visible('quick'), { Dev: ['quick'] });
      assert.deepStrictEqual(await visible('idle'), { Dev: ['debug-idle'] });
      assert.deepStrictEqual(await visible('o'), { Dev: ['long-running'], Build: ['compound'] });
    });

    test('keeps the whole group when its name matches', async () => {
      assert.deepStrictEqual(await visible('dev'), { Dev: ['quick', 'long-running', 'debug-idle'] });
    });
  });

  test('Launch Configurations view keeps the configurations whose name matches', () => {
    const shared = createSharedState();
    shared.filter = 'idle 2';
    assert.deepStrictEqual(new LaunchTreeProvider(shared).getChildren().map(i => i.label), ['debug-idle-2']);
  });

  suite('commands', () => {
    let api: ExtensionApi;

    suiteSetup(async () => { api = await getApi(); });

    teardown(async () => {
      restoreStubs();
      await run('clearSearch');
    });

    test('search filters the views while typing and keeps the text once closed', async () => {
      const input = fakeInputBox();
      await run('search');

      input.type('  qui ');
      assert.strictEqual(api.shared.filter, 'qui');
      input.type('quick');
      input.accept();
      assert.strictEqual(api.shared.filter, 'quick');
    });

    test('search starts from the current text', async () => {
      const first = fakeInputBox();
      await run('search');
      first.type('quick');
      first.accept();
      restoreStubs();

      const input = fakeInputBox();
      await run('search');
      assert.strictEqual(input.box.value, 'quick');
    });

    test('typing does not refetch the tasks', async () => {
      const cached: vscode.Task[] = [];
      api.shared.cachedTasks = cached;
      const input = fakeInputBox();
      await run('search');
      input.type('quick');
      assert.strictEqual(api.shared.cachedTasks, cached);
      api.shared.cachedTasks = null;
    });

    test('clearSearch shows everything again', async () => {
      const input = fakeInputBox();
      await run('search');
      input.type('quick');

      await run('clearSearch');
      assert.strictEqual(api.shared.filter, '');
    });
  });
});
