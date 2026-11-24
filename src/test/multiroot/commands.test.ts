import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { ExtensionApi } from '../../extension';
import { entryRefFor, GroupScope } from '../../projects';
import { GroupScopeItem, groupsOf, TaskTreeItem, VirtualGroup, VirtualGroupItem } from '../../taskTreeProvider';
import {
  answerInputBox,
  answerOpenDialog,
  answerQuickPicks,
  answerSaveDialog,
  cancel,
  captureMessages,
  disposeAllTerminals,
  getApi,
  pick,
  pickMany,
  restoreStubs,
  stopAllTasks,
  waitFor,
} from '../helpers';
import { clearGroups, folder, folderTask, followScmSelection, runningInFolders, saveGroups, scope } from './workspace';

const run = (command: string, ...args: unknown[]) =>
  vscode.commands.executeCommand(`run-my-tasks.${command}`, ...args);

type Pickable = string | vscode.QuickPickItem;
const labelOf = (i: Pickable) => (typeof i === 'string' ? i : i.label);
const descriptionOf = (i: Pickable) => (typeof i === 'string' ? undefined : i.description);
// The item with that label and description
const pickIn = (label: string, description: string) => (items: Pickable[]) =>
  items.find(i => labelOf(i) === label && descriptionOf(i) === description);
const offeredAs = (items: Pickable[]) => items.map(i => [labelOf(i), descriptionOf(i)].filter(Boolean).join(' · '));

suite('Multi-root commands', () => {
  let api: ExtensionApi;
  let apiScope: GroupScope;
  let webScope: GroupScope;
  let notesScope: GroupScope;
  let workspaceScope: GroupScope;

  const groupsIn = (s: GroupScope) => groupsOf(api.shared, s);
  const given = async (s: GroupScope, groups: VirtualGroup[]) => saveGroups(api, s, groups);
  const groupItem = (s: GroupScope, name: string) =>
    new VirtualGroupItem(groupsIn(s).find(g => g.name === name)!, 0, undefined, s.id);

  suiteSetup(async () => {
    api = await getApi();
    await followScmSelection(false);
    apiScope = scope(api, 'api');
    webScope = scope(api, 'web, web-feature');
    notesScope = scope(api, 'notes');
    workspaceScope = scope(api, 'Workspace');
  });

  suiteTeardown(async () => { await followScmSelection(undefined); });

  setup(async () => {
    await clearGroups(api);
    // A question the test does not answer fails it, instead of waiting for an answer
    answerQuickPicks();
  });

  teardown(async () => {
    restoreStubs();
    await stopAllTasks();
    await disposeAllTerminals();
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });

  suite('createGroup', () => {
    test('from the palette asks the project to create the group in', async () => {
      const offered = answerQuickPicks(pick('web, web-feature'));
      const prompts = answerInputBox('Dev');
      await run('createGroup');
      assert.deepStrictEqual(offered.map(offeredAs), [['api', 'web, web-feature', 'notes', 'Workspace · groups mixing the projects']]);
      assert.strictEqual(prompts[0].prompt, 'Group name in web, web-feature');
      assert.deepStrictEqual(groupsIn(webScope), [{ name: 'Dev', tasks: [] }]);
      assert.deepStrictEqual(groupsIn(apiScope), []);
    });

    test('the + button of a project creates the group in it, without asking', async () => {
      answerQuickPicks();
      answerInputBox('Notes');
      await run('createGroup', new GroupScopeItem(notesScope, 0, 0));
      assert.deepStrictEqual(groupsIn(notesScope), [{ name: 'Notes', tasks: [] }]);
    });

    test('two projects may have a group with the same name, one project may not', async () => {
      await given(apiScope, [{ name: 'Dev', tasks: [] }]);
      answerInputBox('Dev');
      await run('createGroup', new GroupScopeItem(webScope, 0, 0));
      assert.deepStrictEqual(groupsIn(webScope), [{ name: 'Dev', tasks: [] }]);

      const messages = captureMessages();
      await run('createGroup', new GroupScopeItem(apiScope, 1, 0));
      assert.deepStrictEqual(messages.warning, ['Group "Dev" already exists.']);
      assert.deepStrictEqual(groupsIn(apiScope), [{ name: 'Dev', tasks: [] }]);
    });
  });

  suite('addTaskToGroup', () => {
    test('from the palette tells the folder of each task, and offers the groups that can take the one picked', async () => {
      await given(apiScope, [{ name: 'Api', tasks: [] }]);
      await given(webScope, [{ name: 'Web', tasks: [] }]);
      await given(workspaceScope, [{ name: 'All', tasks: [] }]);
      const offered = answerQuickPicks(pickIn('build', 'web · Workspace'), pick('All'));
      await run('addTaskToGroup');

      const [entries, groups] = offered.map(offeredAs);
      for (const entry of ['build · api · Workspace', 'build · web · Workspace', 'preview · web-feature · Workspace',
        'todo · notes · Workspace', 'everything · shop.code-workspace · Workspace', 'debug-api · Launch Configuration · api']) {
        assert.ok(entries.includes(entry), `${entry} among ${entries.join(', ')}`);
      }
      // The group of api cannot take a task of web
      assert.deepStrictEqual(groups, ['Web · web, web-feature', 'All · Workspace']);
      // A group of the workspace remembers the folder of the task
      assert.deepStrictEqual(groupsIn(workspaceScope), [{ name: 'All', tasks: [entryRefFor(workspaceScope, 'build', folder('web'))] }]);
    });

    test('a group of the project stores the bare name', async () => {
      await given(webScope, [{ name: 'Web', tasks: [] }]);
      answerQuickPicks(pick('Web'));
      await run('addTaskToGroup', new TaskTreeItem(await folderTask('preview', 'web-feature'), false));
      assert.deepStrictEqual(groupsIn(webScope), [{ name: 'Web', tasks: ['preview'] }]);
    });

    test('tells when no group can take the task', async () => {
      await given(webScope, [{ name: 'Web', tasks: [] }]);
      const messages = captureMessages();
      await run('addTaskToGroup', new TaskTreeItem(await folderTask('build', 'api'), false));
      assert.deepStrictEqual(messages.info, ['No groups can take "build" yet: create one in api or in the Workspace.']);
    });
  });

  suite('removeTaskFromGroup', () => {
    test('from the palette tells the folder of the entries of a workspace group, and removes the one picked', async () => {
      const apiBuild = entryRefFor(workspaceScope, 'build', folder('api'));
      const webBuild = entryRefFor(workspaceScope, 'build', folder('web'));
      await given(workspaceScope, [{ name: 'All', tasks: [apiBuild, webBuild] }]);
      const offered = answerQuickPicks(pick('All'), pickIn('build', 'web'));
      await run('removeTaskFromGroup');
      assert.deepStrictEqual(offered.map(offeredAs), [['All · Workspace'], ['build · api', 'build · web']]);
      assert.deepStrictEqual(groupsIn(workspaceScope), [{ name: 'All', tasks: [apiBuild] }]);
    });

    test('from the context menu removes the entry clicked', async () => {
      const webBuild = entryRefFor(workspaceScope, 'build', folder('web'));
      await given(workspaceScope, [{ name: 'All', tasks: [webBuild, 'todo'] }]);
      const item = new TaskTreeItem(await folderTask('build', 'web'), false, 'All', workspaceScope.id, webBuild);
      await run('removeTaskFromGroup', item);
      assert.deepStrictEqual(groupsIn(workspaceScope), [{ name: 'All', tasks: ['todo'] }]);
    });
  });

  suite('runGroup and stopGroup', () => {
    test('a group of a project runs the task of that project', async () => {
      await given(webScope, [{ name: 'Build', tasks: ['build'] }]);
      await run('runGroup', groupItem(webScope, 'Build'));
      await waitFor(() => runningInFolders().length === 1, 'the task to start');
      assert.deepStrictEqual(runningInFolders(), ['build@web']);
    });

    test('a group of the workspace runs the tasks of the folders its entries name', async () => {
      await given(workspaceScope, [{
        name: 'All',
        tasks: [entryRefFor(workspaceScope, 'build', folder('api')), entryRefFor(workspaceScope, 'build', folder('web'))],
      }]);
      await run('runGroup', groupItem(workspaceScope, 'All'));
      await waitFor(() => runningInFolders().length === 2, 'the tasks to start');
      assert.deepStrictEqual(runningInFolders(), ['build@api', 'build@web']);
    });

    test('a group of a project stops the task of that project only', async () => {
      await given(apiScope, [{ name: 'Build', tasks: ['build'] }]);
      await vscode.tasks.executeTask(await folderTask('build', 'api'));
      await vscode.tasks.executeTask(await folderTask('build', 'web'));
      await waitFor(() => runningInFolders().length === 2, 'the tasks to start');

      await run('stopGroup', groupItem(apiScope, 'Build'));
      await waitFor(() => runningInFolders().length === 1, 'the task of api to stop');
      assert.deepStrictEqual(runningInFolders(), ['build@web']);
    });

    test('from the palette offers the groups of every project', async () => {
      await given(apiScope, [{ name: 'Build', tasks: ['serve'] }]);
      await given(webScope, [{ name: 'Build', tasks: ['dev'] }]);
      const offered = answerQuickPicks(pickIn('Build', 'web, web-feature'));
      await run('runGroup');
      assert.deepStrictEqual(offered.map(offeredAs), [['Build · api', 'Build · web, web-feature']]);
      await waitFor(() => runningInFolders().length === 1, 'the task to start');
      assert.deepStrictEqual(runningInFolders(), ['dev@web']);
    });
  });

  suite('exportGroups and importGroups', () => {
    let dir: string;

    setup(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-my-tasks-export-')); });
    teardown(() => fs.rmSync(dir, { recursive: true, force: true }));

    test('export asks among the projects with groups, and names the file after the project', async () => {
      await given(apiScope, [{ name: 'Api', tasks: ['serve'] }]);
      await given(webScope, [{ name: 'Web', tasks: ['dev'] }, { name: 'Other', tasks: [] }]);
      const file = vscode.Uri.file(path.join(dir, 'out.json'));
      const offered = answerQuickPicks(pick('web, web-feature'), pickMany('Web'));
      const dialogs = answerSaveDialog(file);
      captureMessages();
      await run('exportGroups');

      assert.deepStrictEqual(offered.map(offeredAs)[0], ['api', 'web, web-feature']);
      assert.deepStrictEqual(offered.map(offeredAs)[1], ['Web', 'Other']);
      assert.strictEqual(path.basename(dialogs[0].defaultUri!.fsPath), 'web-groups.json');
      assert.strictEqual(path.dirname(dialogs[0].defaultUri!.fsPath), folder('web').uri.fsPath);
      const exported = JSON.parse(fs.readFileSync(file.fsPath, 'utf8'));
      assert.deepStrictEqual(exported.groups, [{ name: 'Web', tasks: ['dev'], launches: [] }]);
    });

    test('import asks the project, and tells the tasks it lacks', async () => {
      const file = path.join(dir, 'groups.json');
      fs.writeFileSync(file, JSON.stringify({ version: 1, groups: [{ name: 'Mixed', tasks: ['build', 'todo'], launches: [] }] }));
      answerOpenDialog(vscode.Uri.file(file));
      const offered = answerQuickPicks(pick('notes'));
      const messages = captureMessages();
      await run('importGroups');

      assert.deepStrictEqual(offered.map(offeredAs), [['api', 'web, web-feature', 'notes', 'Workspace · groups mixing the projects']]);
      assert.deepStrictEqual(groupsIn(notesScope).map(g => [g.name, g.tasks]), [['Mixed', ['build', 'todo']]]);
      // build is a task of api and web, not of notes
      assert.deepStrictEqual(messages.warning, ['Imported 1 group from groups.json. Not found in this workspace: build.']);
    });
  });

  suite('openTasksJson and openLaunchJson', () => {
    const openFile = () => vscode.window.activeTextEditor?.document.uri.fsPath;

    test('open tasks.json asks the folder', async () => {
      const offered = answerQuickPicks(pick('web'));
      await run('openTasksJson');
      assert.deepStrictEqual(offered.map(o => o.map(labelOf)), [['api', 'web', 'web-feature', 'notes']]);
      assert.strictEqual(openFile(), path.join(folder('web').uri.fsPath, '.vscode', 'tasks.json'));
    });

    test('open launch.json asks the folder', async () => {
      answerQuickPicks(pick('api'));
      await run('openLaunchJson');
      assert.strictEqual(openFile(), path.join(folder('api').uri.fsPath, '.vscode', 'launch.json'));
    });

    test('cancelling the folder opens nothing', async () => {
      answerQuickPicks(cancel);
      await run('openTasksJson');
      assert.strictEqual(openFile(), undefined);
    });

    test('a folder without the file is reported', async () => {
      answerQuickPicks(pick('notes'));
      const messages = captureMessages();
      await run('openLaunchJson');
      assert.deepStrictEqual(messages.error, ['launch.json not found in .vscode/']);
    });
  });
});
