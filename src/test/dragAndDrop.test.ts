import * as assert from 'assert';
import * as vscode from 'vscode';
import {
  createSharedState,
  GroupsDragController,
  TasksDragController,
  TaskTreeItem,
  VirtualGroup,
  VirtualGroupItem,
} from '../taskTreeProvider';
import { getTask } from './helpers';

suite('Groups drag and drop', () => {
  let quick: vscode.Task;
  let longRunning: vscode.Task;
  let compound: vscode.Task;

  suiteSetup(async () => {
    quick = await getTask('quick');
    longRunning = await getTask('long-running');
    compound = await getTask('compound');
  });

  function setup(groups: VirtualGroup[]) {
    const shared = createSharedState();
    shared.virtualGroups = groups;
    let saved: VirtualGroup[] | undefined;
    const controller = new GroupsDragController(shared, async g => { saved = g; });
    return { controller, saved: () => saved };
  }

  const group = (g: VirtualGroup) => new VirtualGroupItem(g, 0);
  const inGroup = (t: vscode.Task, g: string) => new TaskTreeItem(t, false, g);

  test('reorders groups by dropping a group onto another', async () => {
    const a = { name: 'A', tasks: [] };
    const b = { name: 'B', tasks: [] };
    const c = { name: 'C', tasks: [] };
    const { controller, saved } = setup([a, b, c]);

    const dt = new vscode.DataTransfer();
    controller.handleDrag([group(c)], dt);
    await controller.handleDrop(group(a), dt);

    assert.deepStrictEqual(saved()?.map(g => g.name), ['C', 'A', 'B']);
  });

  test('reorders a task within its group by dropping it onto another task', async () => {
    const dev = { name: 'Dev', tasks: ['quick', 'long-running', 'compound'] };
    const { controller, saved } = setup([dev]);

    const dt = new vscode.DataTransfer();
    controller.handleDrag([inGroup(compound, 'Dev')], dt);
    await controller.handleDrop(inGroup(quick, 'Dev'), dt);

    assert.deepStrictEqual(saved()?.[0].tasks, ['compound', 'quick', 'long-running']);
  });

  test('moves a task to another group', async () => {
    const dev = { name: 'Dev', tasks: ['quick', 'long-running'] };
    const build = { name: 'Build', tasks: [] };
    const { controller, saved } = setup([dev, build]);

    const dt = new vscode.DataTransfer();
    controller.handleDrag([inGroup(longRunning, 'Dev')], dt);
    await controller.handleDrop(group(build), dt);

    assert.deepStrictEqual(saved(), [
      { name: 'Dev', tasks: ['quick'] },
      { name: 'Build', tasks: ['long-running'] },
    ]);
  });

  test('adds a task dragged from the Tasks view without duplicating it', async () => {
    const dev = { name: 'Dev', tasks: ['quick'] };
    const { controller, saved } = setup([dev]);

    const dt = new vscode.DataTransfer();
    new TasksDragController().handleDrag(
      [new TaskTreeItem(quick, false), new TaskTreeItem(longRunning, false)],
      dt,
    );
    await controller.handleDrop(group(dev), dt);

    assert.deepStrictEqual(saved()?.[0].tasks, ['quick', 'long-running']);
  });

  test('ignores a drop with no drag in progress', async () => {
    const dev = { name: 'Dev', tasks: [] };
    const { controller, saved } = setup([dev]);

    await controller.handleDrop(group(dev), new vscode.DataTransfer());

    assert.strictEqual(saved(), undefined);
  });
});
