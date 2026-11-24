import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { ExtensionApi } from '../../extension';
import { computeScopes, taskOrigin, WORKSPACE_SCOPE_ID, workspaceFileLabel } from '../../projects';
import { showTaskPicker } from '../../taskPicker';
import {
  GroupScopeItem,
  GroupsTreeProvider,
  TaskGroupItem,
  TaskOriginItem,
  TasksTreeProvider,
  TaskTreeItem,
  VirtualGroupItem,
} from '../../taskTreeProvider';
import { answerQuickPicks, cancel, getApi, restoreStubs, waitFor } from '../helpers';
import { clearGroups, folder, followScmSelection, saveGroups, scope } from './workspace';

const labels = (items: vscode.TreeItem[]) => items.map(i => i.label);

suite('Multi-root workspace', () => {
  let api: ExtensionApi;

  suiteSetup(async () => {
    api = await getApi();
    // Every project shown, whatever repository Source Control has selected
    await followScmSelection(false);
  });

  suiteTeardown(async () => { await followScmSelection(undefined); });

  setup(async () => {
    await clearGroups(api);
  });

  teardown(() => restoreStubs());

  suite('Projects', () => {
    test('one per repository, its worktrees included, one per folder outside git, then the workspace', () => {
      const scopes = computeScopes();
      assert.deepStrictEqual(
        scopes.map(s => ({ label: s.label, folders: s.folders.map(f => f.name), git: s.repo !== undefined, mixed: s.mixed })),
        [
          { label: 'api', folders: ['api'], git: true, mixed: false },
          { label: 'web, web-feature', folders: ['web', 'web-feature'], git: true, mixed: false },
          { label: 'notes', folders: ['notes'], git: false, mixed: false },
          { label: 'Workspace', folders: [], git: false, mixed: true },
        ],
      );
      assert.strictEqual(scopes[3].id, WORKSPACE_SCOPE_ID);
      // The worktree shares the git directory of its repository
      assert.strictEqual(path.basename(scopes[1].repo!), '.git');
      assert.strictEqual(path.basename(path.dirname(scopes[1].repo!)), 'web');
    });

    test('the extension works with the projects of the workspace', () => {
      assert.deepStrictEqual(api.shared.scopes.map(s => s.id), computeScopes().map(s => s.id));
    });

    test('the tasks of the .code-workspace file are named after it', async () => {
      assert.strictEqual(workspaceFileLabel(), 'shop.code-workspace');
      const tasks = await vscode.tasks.fetchTasks();
      const everything = tasks.find(t => t.name === 'everything');
      assert.ok(everything, 'the task of the workspace file');
      assert.strictEqual(taskOrigin(everything).label, 'shop.code-workspace');
      assert.strictEqual(taskOrigin(everything).folder, undefined);
    });
  });

  suite('Groups view', () => {
    test('shows one node per project with its groups, the workspace last', async () => {
      await saveGroups(api, scope(api, 'web, web-feature'), [{ name: 'Web dev', tasks: ['dev'] }]);
      await saveGroups(api, scope(api, 'Workspace'), [{ name: 'All', tasks: [] }]);
      const provider = new GroupsTreeProvider(api.shared);

      const roots = await provider.getChildren();
      assert.ok(roots.every(r => r instanceof GroupScopeItem));
      assert.deepStrictEqual(labels(roots), ['api', 'web, web-feature', 'notes', 'Workspace']);
      assert.deepStrictEqual(roots.map(r => r.collapsibleState !== vscode.TreeItemCollapsibleState.None), [false, true, false, true]);

      const webGroups = await provider.getChildren(roots[1]);
      assert.ok(webGroups[0] instanceof VirtualGroupItem);
      assert.deepStrictEqual(labels(webGroups), ['Web dev']);
      const [dev] = await provider.getChildren(webGroups[0]);
      assert.ok(dev instanceof TaskTreeItem);
      assert.strictEqual(dev.task.name, 'dev');
      // A project of two folders tells the folder of its tasks
      assert.strictEqual(dev.description, 'web');
    });

    test('a group of a project shows the task of that project when another has one with the same name', async () => {
      await saveGroups(api, scope(api, 'web, web-feature'), [{ name: 'Build', tasks: ['build', 'preview'] }]);
      await saveGroups(api, scope(api, 'api'), [{ name: 'Build', tasks: ['build', 'dev'] }]);
      const provider = new GroupsTreeProvider(api.shared);
      const [apiNode, webNode] = await provider.getChildren();

      const [apiBuild] = await provider.getChildren(apiNode);
      const apiEntries = await provider.getChildren(apiBuild) as TaskTreeItem[];
      // dev is a task of web only
      assert.deepStrictEqual(apiEntries.map(e => `${e.task.name}@${taskOrigin(e.task).label}`), ['build@api']);

      const [webBuild] = await provider.getChildren(webNode);
      const webEntries = await provider.getChildren(webBuild) as TaskTreeItem[];
      assert.deepStrictEqual(webEntries.map(e => `${e.task.name}@${taskOrigin(e.task).label}`), ['build@web', 'preview@web-feature']);
    });
  });

  suite('Tasks view', () => {
    test('lists the tasks by folder, then those of the workspace file', async () => {
      const provider = new TasksTreeProvider(api.shared);
      const roots = await provider.getChildren();
      assert.ok(roots.every(r => r instanceof TaskOriginItem));
      assert.deepStrictEqual(labels(roots), ['api', 'web', 'web-feature', 'notes', 'shop.code-workspace']);

      const [source] = await provider.getChildren(roots[1]);
      assert.ok(source instanceof TaskGroupItem);
      const webTasks = await provider.getChildren(source) as TaskTreeItem[];
      assert.deepStrictEqual(webTasks.map(t => t.task.name), ['build', 'dev']);

      const [fileSource] = await provider.getChildren(roots[4]);
      const fileTasks = await provider.getChildren(fileSource) as TaskTreeItem[];
      assert.deepStrictEqual(fileTasks.map(t => t.task.name), ['everything']);
    });
  });

  suite('Task picker', () => {
    test('names the folder of each source in its separators, and of each launch configuration', async () => {
      const offered = answerQuickPicks(cancel) as vscode.QuickPickItem[][];
      await showTaskPicker();
      const separators = offered[0].filter(i => i.kind === vscode.QuickPickItemKind.Separator).map(i => i.label);
      assert.deepStrictEqual(separators, [
        'api · Workspace',
        'web · Workspace',
        'web-feature · Workspace',
        'notes · Workspace',
        'shop.code-workspace · Workspace',
        'Launch Configurations',
      ]);
      const launch = offered[0].find(i => i.label === '$(debug-alt) debug-api');
      assert.strictEqual(launch?.description, 'api');
    });
  });

  suite('Folders added and removed', () => {
    let extra: string;

    suiteSetup(() => {
      extra = path.join(path.dirname(folder('notes').uri.fsPath), 'extra');
      fs.mkdirSync(path.join(extra, '.vscode'), { recursive: true });
      fs.writeFileSync(path.join(extra, '.vscode', 'tasks.json'), JSON.stringify({
        version: '2.0.0',
        tasks: [{ label: 'extra-task', type: 'shell', command: 'node -e "0"', problemMatcher: [] }],
      }));
    });

    test('a folder added to the workspace becomes a project, and goes away when removed', async () => {
      const count = vscode.workspace.workspaceFolders!.length;
      assert.ok(vscode.workspace.updateWorkspaceFolders(count, 0, { uri: vscode.Uri.file(extra) }));
      await waitFor(() => api.shared.scopes.some(s => s.label === 'extra'), 'the new folder to become a project');
      assert.deepStrictEqual(api.shared.scopes.map(s => s.label), ['api', 'web, web-feature', 'notes', 'extra', 'Workspace']);
      const roots = await new TasksTreeProvider(api.shared).getChildren();
      assert.ok(labels(roots).includes('extra'), 'the Tasks view lists the tasks of the new folder');

      assert.ok(vscode.workspace.updateWorkspaceFolders(count, 1));
      await waitFor(() => !api.shared.scopes.some(s => s.label === 'extra'), 'the folder to go away');
      assert.deepStrictEqual(api.shared.scopes.map(s => s.label), ['api', 'web, web-feature', 'notes', 'Workspace']);
    });
  });
});
