import * as assert from 'assert';
import * as path from 'path';
import * as vscode from 'vscode';
import { runTask, terminalsPlaced } from '../taskTerminals';
import { TaskTreeItem } from '../taskTreeProvider';
import {
  disposeAllTerminals,
  getTask,
  restoreStubs,
  stopAllTasks,
  waitFor,
  waitForRunning,
  withSettings,
} from './helpers';

const run = (command: string, ...args: unknown[]) =>
  vscode.commands.executeCommand(`run-my-tasks.${command}`, ...args);

// The editor groups as the labels of their tabs, terminals marked with a leading "$ "
function editorLayout(): string[][] {
  return vscode.window.tabGroups.all.map(g =>
    g.tabs.map(t => (t.input instanceof vscode.TabInputTerminal ? `$ ${t.label}` : t.label)),
  );
}

// The grid of the editor groups, as returned by vscode.getEditorLayout
interface GridLayout { orientation: number; groups: { groups?: unknown[] }[]; }
const VERTICAL = 1;
const gridLayout = async (): Promise<GridLayout> => vscode.commands.executeCommand<GridLayout>('vscode.getEditorLayout');

const terminalTabs = (): string[] => editorLayout().flat().filter(label => label.startsWith('$ '));

async function openFixtureFile(): Promise<void> {
  const folder = vscode.workspace.workspaceFolders![0].uri.fsPath;
  const doc = await vscode.workspace.openTextDocument(path.join(folder, 'idle.js'));
  await vscode.window.showTextDocument(doc);
}

async function runFromTree(name: string, command = 'runTaskFromTree'): Promise<void> {
  await run(command, new TaskTreeItem(await getTask(name), false));
  await waitForRunning(name);
  // The move starts with the task
  await new Promise(r => setTimeout(r, 200));
  await terminalsPlaced();
}

suite('Task terminals', () => {
  teardown(async () => {
    restoreStubs();
    await terminalsPlaced();
    await stopAllTasks();
    // Back to a single empty group: the empty groups left would change where the next terminals go
    await vscode.commands.executeCommand('workbench.action.closeAllGroups');
    await waitFor(
      () => vscode.window.tabGroups.all.length === 1 && vscode.window.tabGroups.all[0].tabs.length === 0,
      'the editor groups to close',
    );
    disposeAllTerminals();
    // A terminal still closing would be taken for the terminal of the next test, having the same title
    await waitFor(() => vscode.window.terminals.length === 0, 'the terminals to close');
  });

  test('open in the panel by default', async () => {
    await openFixtureFile();
    await runFromTree('long-running');
    await waitFor(() => vscode.window.terminals.some(t => t.name.includes('long-running')), 'the task terminal');
    // Give a misplaced move the time to happen
    await new Promise(r => setTimeout(r, 1000));
    assert.deepStrictEqual(terminalTabs(), []);
  });

  test('split: open beside the active editor, keeping the focus there', async () => {
    withSettings({ terminalLocation: 'editor', editorTerminalLayout: 'split' });
    await openFixtureFile();
    await runFromTree('long-running');

    await waitFor(() => editorLayout().length === 2 && terminalTabs().length === 1, 'the terminal beside the file');
    assert.deepStrictEqual(editorLayout()[0], ['idle.js']);
    assert.ok(editorLayout()[1][0].includes('long-running'));
    await waitFor(() => vscode.window.tabGroups.activeTabGroup.viewColumn === 1, 'the focus back on the file');
  });

  test('split: the next terminals open side by side, each in its own group', async () => {
    withSettings({ terminalLocation: 'editor', editorTerminalLayout: 'split' });
    await openFixtureFile();
    await runFromTree('long-running');
    await waitFor(() => terminalTabs().length === 1, 'the first terminal in the editor');
    await runFromTree('long-running-2');

    await waitFor(() => terminalTabs().length === 2, 'the second terminal in the editor');
    assert.strictEqual(editorLayout().length, 3);
    assert.deepStrictEqual(editorLayout()[0], ['idle.js']);
    assert.ok(editorLayout()[1][0].includes('long-running'));
    assert.ok(editorLayout()[2][0].includes('long-running-2'));
    await waitFor(() => vscode.window.tabGroups.activeTabGroup.viewColumn === 1, 'the focus back on the file');
  });

  test('group: all the terminals open as tabs of one group beside the active editor', async () => {
    withSettings({ terminalLocation: 'editor', editorTerminalLayout: 'group' });
    await openFixtureFile();
    await runFromTree('long-running');
    await waitFor(() => terminalTabs().length === 1, 'the first terminal in the editor');
    await runFromTree('long-running-2');

    await waitFor(() => terminalTabs().length === 2, 'the second terminal in the editor');
    assert.strictEqual(editorLayout().length, 2);
    assert.deepStrictEqual(editorLayout()[0], ['idle.js']);
    await waitFor(() => vscode.window.tabGroups.activeTabGroup.viewColumn === 1, 'the focus back on the file');
  });

  test('split below: the terminals open one under the other, below the active editor', async () => {
    withSettings({ terminalLocation: 'editor', editorTerminalLayout: 'split', editorTerminalPosition: 'below' });
    await openFixtureFile();
    await runFromTree('long-running');
    await runFromTree('long-running-2');

    await waitFor(() => terminalTabs().length === 2, 'both terminals in the editor');
    // One column: the files, then the two terminals
    const layout = await gridLayout();
    assert.strictEqual(layout.orientation, VERTICAL, JSON.stringify(layout));
    assert.strictEqual(layout.groups.length, 3, JSON.stringify(layout));
    assert.ok(layout.groups.every(g => g.groups === undefined), JSON.stringify(layout));
    assert.deepStrictEqual(editorLayout()[0], ['idle.js']);
  });

  test('group below: all the terminals open as tabs of one group below the active editor', async () => {
    withSettings({ terminalLocation: 'editor', editorTerminalLayout: 'group', editorTerminalPosition: 'below' });
    await openFixtureFile();
    await runFromTree('long-running');
    await runFromTree('long-running-2');

    await waitFor(() => terminalTabs().length === 2, 'both terminals in the editor');
    const layout = await gridLayout();
    assert.strictEqual(layout.orientation, VERTICAL, JSON.stringify(layout));
    assert.strictEqual(layout.groups.length, 2, JSON.stringify(layout));
    assert.strictEqual(layout.groups[1].groups, undefined, JSON.stringify(layout));
    assert.deepStrictEqual(editorLayout()[0], ['idle.js']);
  });

  test('tab: open as a tab of the active editor group', async () => {
    withSettings({ terminalLocation: 'editor', editorTerminalLayout: 'tab' });
    await openFixtureFile();
    await runFromTree('long-running');

    await waitFor(() => terminalTabs().length === 1, 'the terminal in the editor');
    assert.strictEqual(editorLayout().length, 1);
    assert.strictEqual(editorLayout()[0][0], 'idle.js');
  });

  for (const layout of ['split', 'group', 'tab']) {
    test(`${layout}, with no file open: the first terminal takes the whole editor area`, async () => {
      withSettings({ terminalLocation: 'editor', editorTerminalLayout: layout });
      await runFromTree('long-running');

      await waitFor(() => terminalTabs().length === 1, 'the terminal in the editor');
      assert.strictEqual(editorLayout().length, 1);
    });
  }

  for (const layout of ['group', 'tab']) {
    test(`${layout}, with no file open: the next terminals join the group of the first one`, async () => {
      withSettings({ terminalLocation: 'editor', editorTerminalLayout: layout });
      await runFromTree('long-running');
      await waitFor(() => terminalTabs().length === 1, 'the first terminal in the editor');
      await runFromTree('long-running-2');

      await waitFor(() => terminalTabs().length === 2, 'the second terminal in the editor');
      assert.strictEqual(editorLayout().length, 1, JSON.stringify(editorLayout()));
    });
  }

  test('split, with no file open: the next terminals open side by side with the first one', async () => {
    withSettings({ terminalLocation: 'editor', editorTerminalLayout: 'split' });
    await runFromTree('long-running');
    await waitFor(() => terminalTabs().length === 1, 'the first terminal in the editor');
    await runFromTree('long-running-2');

    await waitFor(() => terminalTabs().length === 2, 'the second terminal in the editor');
    assert.strictEqual(editorLayout().length, 2, JSON.stringify(editorLayout()));
  });

  test('a task that does not reveal its terminal keeps it in the panel', async () => {
    withSettings({ terminalLocation: 'editor', editorTerminalLayout: 'tab' });
    const task = await getTask('long-running');
    task.presentationOptions = { reveal: vscode.TaskRevealKind.Never };
    await runTask(task);
    await waitForRunning('long-running');
    await waitFor(() => vscode.window.terminals.some(t => t.name.includes('long-running')), 'the task terminal');
    await new Promise(r => setTimeout(r, 1000));
    assert.deepStrictEqual(terminalTabs(), []);
  });

  test('Run in Editor overrides the panel setting', async () => {
    withSettings({ terminalLocation: 'panel', editorTerminalLayout: 'tab' });
    await runFromTree('long-running', 'runTaskInEditor');
    await waitFor(() => terminalTabs().length === 1, 'the terminal in the editor');
  });

  test('Run in Panel overrides the editor setting', async () => {
    withSettings({ terminalLocation: 'editor', editorTerminalLayout: 'tab' });
    await runFromTree('long-running', 'runTaskInPanel');
    await waitFor(() => vscode.window.terminals.some(t => t.name.includes('long-running')), 'the task terminal');
    await new Promise(r => setTimeout(r, 1000));
    assert.deepStrictEqual(terminalTabs(), []);
  });

  test('Run Group opens the terminals of its tasks in the editor', async () => {
    withSettings({ terminalLocation: 'editor', editorTerminalLayout: 'split' });
    await openFixtureFile();
    await run('runGroup', { group: { name: 'G', tasks: ['long-running', 'long-running-2'] } });

    await waitFor(() => terminalTabs().length === 2, 'both terminals in the editor');
    assert.strictEqual(editorLayout().length, 3);
  });
});
