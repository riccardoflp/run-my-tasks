import * as assert from 'assert';
import * as vscode from 'vscode';
import { ExtensionApi } from '../extension';
import { TaskTreeItem, VirtualGroup, VirtualGroupItem } from '../taskTreeProvider';
import {
  answerInputBox,
  answerQuickPicks,
  cancel,
  captureMessages,
  getApi,
  getTask,
  pick,
  restoreStubs,
} from './helpers';

const run = (command: string, ...args: unknown[]) =>
  vscode.commands.executeCommand(`run-my-tasks.${command}`, ...args);

suite('Group commands', () => {
  let api: ExtensionApi;
  const groups = () => api.shared.virtualGroups;
  const names = () => groups().map(g => g.name);
  const item = (name: string) => new VirtualGroupItem(groups().find(g => g.name === name)!, 0);

  suiteSetup(async () => { api = await getApi(); });

  async function given(state: VirtualGroup[]): Promise<void> {
    await api.saveGroups(state);
  }

  setup(() => given([]));
  teardown(() => restoreStubs());

  suite('createGroup', () => {
    test('adds a group with the trimmed name', async () => {
      await given([{ name: 'Dev', tasks: [] }]);
      answerInputBox('  Build  ');
      await run('createGroup');
      assert.deepStrictEqual(groups(), [{ name: 'Dev', tasks: [] }, { name: 'Build', tasks: [] }]);
    });

    test('does nothing when cancelled or blank', async () => {
      answerInputBox(undefined);
      await run('createGroup');
      restoreStubs();
      answerInputBox('   ');
      await run('createGroup');
      assert.deepStrictEqual(groups(), []);
    });

    test('refuses a duplicate name', async () => {
      await given([{ name: 'Dev', tasks: ['quick'] }]);
      const messages = captureMessages();
      answerInputBox('Dev');
      await run('createGroup');
      assert.deepStrictEqual(groups(), [{ name: 'Dev', tasks: ['quick'] }]);
      assert.deepStrictEqual(messages.warning, ['Group "Dev" already exists.']);
    });
  });

  suite('deleteGroup', () => {
    test('deletes the group of the clicked item', async () => {
      await given([{ name: 'Dev', tasks: [] }, { name: 'Build', tasks: [] }]);
      await run('deleteGroup', item('Dev'));
      assert.deepStrictEqual(names(), ['Build']);
    });

    test('asks which group to delete when run from the palette', async () => {
      await given([{ name: 'Dev', tasks: [] }, { name: 'Build', tasks: [] }]);
      const offered = answerQuickPicks(pick('Build'));
      await run('deleteGroup');
      assert.deepStrictEqual(offered, [['Dev', 'Build']]);
      assert.deepStrictEqual(names(), ['Dev']);
    });

    test('does nothing when the pick is cancelled', async () => {
      await given([{ name: 'Dev', tasks: [] }]);
      answerQuickPicks(cancel);
      await run('deleteGroup');
      assert.deepStrictEqual(names(), ['Dev']);
    });

    test('tells the user when there are no groups', async () => {
      const messages = captureMessages();
      await run('deleteGroup');
      assert.deepStrictEqual(messages.info, ['No groups to delete.']);
    });
  });

  suite('renameGroup', () => {
    test('renames the clicked group, keeping its tasks and position', async () => {
      await given([{ name: 'Dev', tasks: ['quick'] }, { name: 'Build', tasks: [] }]);
      const calls = answerInputBox(' Develop ');
      await run('renameGroup', item('Dev'));
      assert.strictEqual(calls[0].value, 'Dev');
      assert.deepStrictEqual(groups(), [{ name: 'Develop', tasks: ['quick'] }, { name: 'Build', tasks: [] }]);
    });

    test('validates the new name', async () => {
      await given([{ name: 'Dev', tasks: [] }, { name: 'Build', tasks: [] }]);
      const calls = answerInputBox(undefined);
      await run('renameGroup', item('Dev'));
      const validate = calls[0].validateInput!;
      assert.strictEqual(validate('  '), 'Name cannot be empty');
      assert.strictEqual(validate('Build'), 'A group with this name already exists');
      assert.strictEqual(validate('Dev'), undefined);
      assert.strictEqual(validate('Test'), undefined);
    });

    test('does nothing when cancelled or unchanged', async () => {
      await given([{ name: 'Dev', tasks: [] }]);
      answerInputBox(undefined);
      await run('renameGroup', item('Dev'));
      restoreStubs();
      answerInputBox('Dev');
      await run('renameGroup', item('Dev'));
      assert.deepStrictEqual(names(), ['Dev']);
    });

    test('asks which group to rename when run from the palette', async () => {
      await given([{ name: 'Dev', tasks: [] }, { name: 'Build', tasks: [] }]);
      answerQuickPicks(pick('Build'));
      answerInputBox('Release');
      await run('renameGroup');
      assert.deepStrictEqual(names(), ['Dev', 'Release']);
    });

    test('tells the user when there are no groups', async () => {
      const messages = captureMessages();
      await run('renameGroup');
      assert.deepStrictEqual(messages.info, ['No groups to rename.']);
    });
  });

  suite('addTaskToGroup', () => {
    test('adds the clicked task to the picked group', async () => {
      await given([{ name: 'Dev', tasks: ['quick'] }, { name: 'Build', tasks: [] }]);
      answerQuickPicks(pick('Build'));
      await run('addTaskToGroup', new TaskTreeItem(await getTask('long-running'), false));
      assert.deepStrictEqual(groups(), [
        { name: 'Dev', tasks: ['quick'] },
        { name: 'Build', tasks: ['long-running'] },
      ]);
    });

    test('does not add a task twice', async () => {
      await given([{ name: 'Dev', tasks: ['quick'] }]);
      answerQuickPicks(pick('Dev'));
      await run('addTaskToGroup', new TaskTreeItem(await getTask('quick'), false));
      assert.deepStrictEqual(groups(), [{ name: 'Dev', tasks: ['quick'] }]);
    });

    test('asks for the task and the group when run from the palette', async () => {
      await given([{ name: 'Dev', tasks: [] }]);
      const offered = answerQuickPicks(pick('compound'), pick('Dev'));
      await run('addTaskToGroup');
      const taskLabels = (offered[0] as vscode.QuickPickItem[]).map(i => i.label).sort();
      assert.deepStrictEqual(taskLabels, ['compound', 'long-running', 'long-running-2', 'quick']);
      assert.deepStrictEqual(groups(), [{ name: 'Dev', tasks: ['compound'] }]);
    });

    test('does nothing when the group pick is cancelled', async () => {
      await given([{ name: 'Dev', tasks: [] }]);
      answerQuickPicks(cancel);
      await run('addTaskToGroup', new TaskTreeItem(await getTask('quick'), false));
      assert.deepStrictEqual(groups(), [{ name: 'Dev', tasks: [] }]);
    });

    test('offers to create a group when there are none', async () => {
      const messages = captureMessages('Create Group');
      answerInputBox('Dev');
      await run('addTaskToGroup', new TaskTreeItem(await getTask('quick'), false));
      assert.deepStrictEqual(messages.info, ['No groups yet. Create one first.']);
      assert.deepStrictEqual(groups(), [{ name: 'Dev', tasks: [] }]);
    });
  });

  suite('removeTaskFromGroup', () => {
    test('removes the clicked task from its own group only', async () => {
      await given([{ name: 'Dev', tasks: ['quick', 'compound'] }, { name: 'Build', tasks: ['quick'] }]);
      await run('removeTaskFromGroup', new TaskTreeItem(await getTask('quick'), false, 'Dev'));
      assert.deepStrictEqual(groups(), [
        { name: 'Dev', tasks: ['compound'] },
        { name: 'Build', tasks: ['quick'] },
      ]);
    });

    test('asks for the group and the task when run from the palette', async () => {
      await given([{ name: 'Empty', tasks: [] }, { name: 'Dev', tasks: ['quick', 'compound'] }]);
      const offered = answerQuickPicks(pick('Dev'), pick('compound'));
      await run('removeTaskFromGroup');
      assert.deepStrictEqual(offered, [['Dev'], ['quick', 'compound']]);
      assert.deepStrictEqual(groups()[1], { name: 'Dev', tasks: ['quick'] });
    });

    test('tells the user when no group has tasks', async () => {
      await given([{ name: 'Empty', tasks: [] }]);
      const messages = captureMessages();
      await run('removeTaskFromGroup');
      assert.deepStrictEqual(messages.info, ['No tasks in any group.']);
    });
  });

  suite('ordering', () => {
    const taskItem = async (name: string) => new TaskTreeItem(await getTask(name), false, 'Dev');
    const devTasks = () => groups().find(g => g.name === 'Dev')!.tasks;

    setup(() => given([
      { name: 'Dev', tasks: ['quick', 'long-running', 'compound'] },
      { name: 'Build', tasks: [] },
      { name: 'Test', tasks: [] },
    ]));

    test('moveTaskUp / moveTaskDown swap a task with its neighbour', async () => {
      await run('moveTaskUp', await taskItem('long-running'));
      assert.deepStrictEqual(devTasks(), ['long-running', 'quick', 'compound']);
      await run('moveTaskDown', await taskItem('quick'));
      assert.deepStrictEqual(devTasks(), ['long-running', 'compound', 'quick']);
    });

    test('moving a task past either end does nothing', async () => {
      await run('moveTaskUp', await taskItem('quick'));
      await run('moveTaskDown', await taskItem('compound'));
      assert.deepStrictEqual(devTasks(), ['quick', 'long-running', 'compound']);
    });

    test('moveGroupUp / moveGroupDown swap a group with its neighbour', async () => {
      await run('moveGroupUp', item('Build'));
      assert.deepStrictEqual(names(), ['Build', 'Dev', 'Test']);
      await run('moveGroupDown', item('Dev'));
      assert.deepStrictEqual(names(), ['Build', 'Test', 'Dev']);
    });

    test('moving a group past either end does nothing', async () => {
      await run('moveGroupUp', item('Dev'));
      await run('moveGroupDown', item('Test'));
      assert.deepStrictEqual(names(), ['Dev', 'Build', 'Test']);
    });
  });

  test('groups survive a reload of the stored state', async () => {
    await given([{ name: 'Dev', tasks: ['quick'] }]);
    answerInputBox('Build');
    await run('createGroup');
    // createGroup reads from workspaceState, so the second group proves the first was persisted
    assert.deepStrictEqual(names(), ['Dev', 'Build']);
  });
});
