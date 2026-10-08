import * as assert from 'assert';
import * as vscode from 'vscode';
import {
  createSharedState,
  GroupsTreeProvider,
  TaskGroupItem,
  TasksTreeProvider,
  TaskTreeItem,
  VirtualGroupItem,
} from '../taskTreeProvider';
import { disposeAllTerminals, getTask, stopAllTasks, waitFor } from './helpers';

suite('Tree providers', () => {
  teardown(async () => {
    await stopAllTasks();
    disposeAllTerminals();
  });

  test('Tasks view lists workspace tasks under the Workspace source first', async () => {
    const provider = new TasksTreeProvider(createSharedState());
    const roots = await provider.getChildren();

    assert.ok(roots[0] instanceof TaskGroupItem);
    assert.strictEqual((roots[0] as TaskGroupItem).source, 'Workspace');

    const names = (await provider.getChildren(roots[0])).map(i => (i as TaskTreeItem).task.name);
    assert.deepStrictEqual(names.sort(), ['compound', 'long-running', 'quick']);
  });

  test('Groups view keeps the user-defined task order and skips unknown tasks', async () => {
    const shared = createSharedState();
    shared.virtualGroups = [{ name: 'Dev', tasks: ['quick', 'missing', 'long-running'] }];
    const provider = new GroupsTreeProvider(shared);

    const [root] = await provider.getChildren();
    assert.ok(root instanceof VirtualGroupItem);

    const children = (await provider.getChildren(root)) as TaskTreeItem[];
    assert.deepStrictEqual(children.map(c => c.task.name), ['quick', 'long-running']);
    assert.ok(children.every(c => c.groupName === 'Dev' && c.contextValue === 'idleTaskInGroup'));
  });

  test('running tasks are marked as running and counted on their group', async () => {
    await vscode.tasks.executeTask(await getTask('long-running'));
    await waitFor(
      () => vscode.tasks.taskExecutions.some(e => e.task.name === 'long-running'),
      'the task to start',
    );

    const shared = createSharedState();
    shared.virtualGroups = [{ name: 'Dev', tasks: ['quick', 'long-running'] }];
    const provider = new GroupsTreeProvider(shared);

    const [root] = await provider.getChildren();
    assert.strictEqual(root.description, '1 running');

    const children = (await provider.getChildren(root)) as TaskTreeItem[];
    assert.deepStrictEqual(children.map(c => c.running), [false, true]);
    assert.strictEqual(children[1].contextValue, 'runningTaskInGroup');
  });

  test('a task pending stop is shown as idle', async () => {
    await vscode.tasks.executeTask(await getTask('long-running'));
    await waitFor(
      () => vscode.tasks.taskExecutions.some(e => e.task.name === 'long-running'),
      'the task to start',
    );

    const shared = createSharedState();
    shared.pendingStop.add('long-running');
    shared.virtualGroups = [{ name: 'Dev', tasks: ['long-running'] }];
    const provider = new GroupsTreeProvider(shared);

    const [root] = await provider.getChildren();
    const [child] = (await provider.getChildren(root)) as TaskTreeItem[];
    assert.strictEqual(child.running, false);
    assert.strictEqual(root.description, undefined);
  });
});
