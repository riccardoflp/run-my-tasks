import * as assert from 'assert';
import * as vscode from 'vscode';
import { createGroupStorage, migrateLegacyGroups } from '../groupStorage';
import {
  computeScopes,
  entryRefFor,
  GroupScope,
  parseEntryRef,
  scopeAccepts,
  taskOrigin,
  WORKSPACE_SCOPE_ID,
} from '../projects';
import {
  createSharedState,
  GroupScopeItem,
  GroupsDragController,
  GroupsTreeProvider,
  groupTasks,
  pickGroup,
  SharedState,
  setGroups,
  TaskGroupItem,
  TaskOriginItem,
  TasksDragController,
  TasksTreeProvider,
  TaskTreeItem,
  VirtualGroup,
  VirtualGroupItem,
} from '../taskTreeProvider';
import { answerQuickPicks, captureMessages, restoreStubs } from './helpers';

// Two folders of a multi-root workspace, each with its own "build" task, and a user task
const folder = (name: string, index: number): vscode.WorkspaceFolder =>
  ({ uri: vscode.Uri.file(`/projects/${name}`), name, index });
const api = folder('api', 0);
const web = folder('web', 1);
const shell = (name: string, scope: vscode.WorkspaceFolder | vscode.TaskScope, source = 'Workspace') =>
  new vscode.Task({ type: 'shell' }, scope, name, source, new vscode.ShellExecution('echo'));
const apiBuild = shell('build', api);
const apiTest = shell('test', api);
const webBuild = shell('build', web);
const webLint = shell('lint', web, 'npm');
const userTask = shell('notes', vscode.TaskScope.Global);
const tasks = [apiBuild, apiTest, webBuild, webLint, userTask];

const project = (f: vscode.WorkspaceFolder): GroupScope =>
  ({ id: `folder:${f.uri.toString()}`, label: f.name, folders: [f], mixed: false });
const apiScope = project(api);
const webScope = project(web);
const workspaceScope: GroupScope = { id: WORKSPACE_SCOPE_ID, label: 'Workspace', folders: [], mixed: true };

// The shared state of a multi-root workspace with the api and web projects
function multiRoot(groups: { api?: VirtualGroup[]; web?: VirtualGroup[]; workspace?: VirtualGroup[] } = {}): SharedState {
  const shared = createSharedState();
  shared.scopes = [apiScope, webScope, workspaceScope];
  shared.cachedTasks = tasks;
  setGroups(shared, groups.api ?? [], apiScope);
  setGroups(shared, groups.web ?? [], webScope);
  setGroups(shared, groups.workspace ?? [], workspaceScope);
  return shared;
}

suite('Projects', () => {
  teardown(() => restoreStubs());

  test('the test window, a single folder, has one scope holding its folder', () => {
    const scopes = computeScopes();
    assert.strictEqual(scopes.length, 1);
    assert.strictEqual(scopes[0].mixed, false);
    assert.deepStrictEqual(scopes[0].folders.map(f => f.name), [vscode.workspace.workspaceFolders![0].name]);
  });

  test('tasks tell their origin: their folder, the workspace file or the user tasks', () => {
    assert.strictEqual(taskOrigin(apiBuild).label, 'api');
    assert.strictEqual(taskOrigin(userTask).label, 'User');
    // The test window has no .code-workspace file to name the workspace tasks after
    assert.strictEqual(taskOrigin(shell('start-all', vscode.TaskScope.Workspace)).label, 'Workspace');
  });

  test('the groups of the workspace scope name the folder of their entries', () => {
    assert.strictEqual(entryRefFor(apiScope, 'build', api), 'build');
    assert.strictEqual(entryRefFor(workspaceScope, 'notes', undefined), 'notes');
    const ref = entryRefFor(workspaceScope, 'build', web);
    assert.notStrictEqual(ref, 'build');
    assert.deepStrictEqual(parseEntryRef(ref), { folder: 'web', name: 'build' });
    assert.deepStrictEqual(parseEntryRef('build'), { name: 'build' });
  });

  test('a project takes only its own entries and those of no folder', () => {
    assert.ok(scopeAccepts(apiScope, api));
    assert.ok(!scopeAccepts(apiScope, web));
    assert.ok(scopeAccepts(apiScope, undefined));
    assert.ok(scopeAccepts(workspaceScope, web));
  });

  test('a group runs the task of its own project when another project has one with the same name', () => {
    const group = { name: 'Dev', tasks: ['build', 'notes'] };
    assert.deepStrictEqual(groupTasks(group, tasks, apiScope), [apiBuild, userTask]);
    assert.deepStrictEqual(groupTasks(group, tasks, webScope), [webBuild, userTask]);
    // A project lacking the task skips it
    assert.deepStrictEqual(groupTasks({ name: 'Dev', tasks: ['lint'] }, tasks, apiScope), []);
  });

  test('a group of the workspace runs the task of the folder its entry names', () => {
    const group = { name: 'All', tasks: [entryRefFor(workspaceScope, 'build', web), entryRefFor(workspaceScope, 'build', api)] };
    assert.deepStrictEqual(groupTasks(group, tasks, workspaceScope), [webBuild, apiBuild]);
    // A plain name, saved before projects, still stands for the first task with that name
    assert.deepStrictEqual(groupTasks({ name: 'Old', tasks: ['build'] }, tasks, workspaceScope), [apiBuild]);
  });

  suite('Tasks view', () => {
    test('lists the tasks by folder, then the user tasks, then by source', async () => {
      const provider = new TasksTreeProvider(multiRoot());
      const roots = await provider.getChildren();
      assert.ok(roots.every(r => r instanceof TaskOriginItem));
      assert.deepStrictEqual(roots.map(r => r.label), ['api', 'web', 'User']);

      const webSources = await provider.getChildren(roots[1]);
      assert.ok(webSources.every(s => s instanceof TaskGroupItem));
      assert.deepStrictEqual(webSources.map(s => s.label), ['Workspace', 'npm']);

      const webWorkspace = (await provider.getChildren(webSources[0])) as TaskTreeItem[];
      assert.deepStrictEqual(webWorkspace.map(t => t.task), [webBuild]);
    });

    test('the search matches the folder name', async () => {
      const shared = multiRoot();
      shared.filter = 'web build';
      const provider = new TasksTreeProvider(shared);
      const roots = await provider.getChildren();
      assert.deepStrictEqual(roots.map(r => r.label), ['web']);
    });

    test('hides the folders of the repositories not selected in Source Control', async () => {
      const shared = multiRoot();
      shared.visibility = { isFolderShown: f => f.name !== 'web', isScopeShown: s => s.label !== 'web' };
      const roots = await new TasksTreeProvider(shared).getChildren();
      assert.deepStrictEqual(roots.map(r => r.label), ['api', 'User']);
    });
  });

  suite('Groups view', () => {
    test('shows the groups under their project, with the entries of the project', async () => {
      const provider = new GroupsTreeProvider(multiRoot({
        api: [{ name: 'Dev', tasks: ['build', 'test'] }],
        web: [{ name: 'Dev', tasks: ['build', 'test'] }],
      }));
      const roots = await provider.getChildren();
      assert.ok(roots.every(r => r instanceof GroupScopeItem));
      assert.deepStrictEqual(roots.map(r => r.label), ['api', 'web', 'Workspace']);
      // The workspace scope, with no groups, cannot be expanded
      assert.strictEqual(roots[2].collapsibleState, vscode.TreeItemCollapsibleState.None);

      const [webDev] = await provider.getChildren(roots[1]);
      assert.ok(webDev instanceof VirtualGroupItem);
      assert.strictEqual(webDev.scopeId, webScope.id);
      const entries = (await provider.getChildren(webDev)) as TaskTreeItem[];
      assert.deepStrictEqual(entries.map(e => e.task), [webBuild]);
    });

    test('the entries of a workspace group tell their folder', async () => {
      const shared = multiRoot({
        workspace: [{ name: 'All', tasks: [entryRefFor(workspaceScope, 'build', api), entryRefFor(workspaceScope, 'build', web)] }],
      });
      const provider = new GroupsTreeProvider(shared);
      const [, , workspace] = await provider.getChildren();
      const [all] = await provider.getChildren(workspace);
      const entries = (await provider.getChildren(all)) as TaskTreeItem[];
      assert.deepStrictEqual(entries.map(e => [e.task, e.description]), [[apiBuild, 'api'], [webBuild, 'web']]);
    });

    test('hides the projects of the repositories not selected in Source Control, never the workspace', async () => {
      const shared = multiRoot();
      shared.visibility = { isFolderShown: f => f.name !== 'web', isScopeShown: s => s.mixed || s.label !== 'web' };
      const roots = await new GroupsTreeProvider(shared).getChildren();
      assert.deepStrictEqual(roots.map(r => r.label), ['api', 'Workspace']);
    });

    test('the search matches the project name', async () => {
      const shared = multiRoot({ api: [{ name: 'Dev', tasks: ['build'] }], web: [{ name: 'Dev', tasks: ['build'] }] });
      shared.filter = 'web dev';
      const provider = new GroupsTreeProvider(shared);
      const roots = await provider.getChildren();
      assert.deepStrictEqual(roots.map(r => r.label), ['web']);
    });
  });

  suite('Drag and drop', () => {
    async function drop(shared: SharedState, item: TaskTreeItem, target: VirtualGroupItem) {
      const saved = new Map<string, VirtualGroup[]>();
      const controller = new GroupsDragController(shared, async (scopeId, groups) => { saved.set(scopeId, groups); });
      const dt = new vscode.DataTransfer();
      new TasksDragController().handleDrag([item], dt);
      await controller.handleDrop(target, dt);
      return saved;
    }

    test('a task dropped on a group of the workspace is saved with its folder', async () => {
      const all = { name: 'All', tasks: [] };
      const shared = multiRoot({ workspace: [all] });
      const saved = await drop(shared, new TaskTreeItem(webBuild, false), new VirtualGroupItem(all, 0, undefined, WORKSPACE_SCOPE_ID));
      assert.deepStrictEqual(saved.get(WORKSPACE_SCOPE_ID), [{ name: 'All', tasks: [entryRefFor(workspaceScope, 'build', web)] }]);
    });

    test('a task of another project is not added to a group of a project', async () => {
      const dev = { name: 'Dev', tasks: [] };
      const shared = multiRoot({ api: [dev] });
      const messages = captureMessages();
      const saved = await drop(shared, new TaskTreeItem(webBuild, false), new VirtualGroupItem(dev, 0, undefined, apiScope.id));
      assert.deepStrictEqual(saved.get(apiScope.id) ?? [dev], [dev]);
      assert.strictEqual(messages.warning.length, 1);
    });

    test('a task moved from a project group to a workspace group leaves the project group', async () => {
      const dev = { name: 'Dev', tasks: ['build'] };
      const all = { name: 'All', tasks: [] };
      const shared = multiRoot({ api: [dev], workspace: [all] });
      const saved = await drop(
        shared,
        new TaskTreeItem(apiBuild, false, 'Dev', apiScope.id, 'build'),
        new VirtualGroupItem(all, 0, undefined, WORKSPACE_SCOPE_ID),
      );
      assert.deepStrictEqual(saved.get(apiScope.id), [{ name: 'Dev', tasks: [] }]);
      assert.deepStrictEqual(saved.get(WORKSPACE_SCOPE_ID), [{ name: 'All', tasks: [entryRefFor(workspaceScope, 'build', api)] }]);
    });
  });

  test('the group picker of a multi-root workspace tells the project of each group', async () => {
    const shared = multiRoot({ api: [{ name: 'Dev', tasks: [] }], web: [{ name: 'Dev', tasks: [] }] });
    const offered = answerQuickPicks(items => items[1]);
    const picked = await pickGroup(shared, 'Select group');
    assert.deepStrictEqual(
      (offered[0] as vscode.QuickPickItem[]).map(i => [i.label, i.description]),
      [['Dev', 'api'], ['Dev', 'web']],
    );
    assert.strictEqual(picked?.scope, webScope);
  });
});

suite('Group storage by scope', () => {
  // An in-memory Memento
  const memento = (): vscode.Memento & { data: Record<string, unknown> } => {
    const data: Record<string, unknown> = {};
    return {
      data,
      keys: () => Object.keys(data),
      get: <T>(key: string, fallback?: T) => (key in data ? data[key] as T : fallback) as T,
      update: async (key: string, value: unknown) => { data[key] = value; },
    };
  };
  const context = () => ({ globalState: memento(), workspaceState: memento() });

  test('the groups of a repository go to the global state, shared with the other windows', async () => {
    const ctx = context();
    const storage = createGroupStorage(ctx as unknown as vscode.ExtensionContext);
    const repoScope: GroupScope = { ...apiScope, id: 'repo:/r/.git', repo: '/r/.git' };
    await storage.save(repoScope, [{ name: 'Dev', tasks: ['build'] }]);
    await storage.save(webScope, [{ name: 'Web', tasks: [] }]);
    await storage.save(workspaceScope, [{ name: 'All', tasks: [] }]);
    assert.deepStrictEqual(ctx.globalState.data.virtualGroupsByRepo, { '/r/.git': [{ name: 'Dev', tasks: ['build'] }] });
    assert.deepStrictEqual(ctx.workspaceState.data.virtualGroupsByFolder, { [webScope.id]: [{ name: 'Web', tasks: [] }] });
    assert.deepStrictEqual(ctx.workspaceState.data.virtualGroups, [{ name: 'All', tasks: [] }]);
    assert.deepStrictEqual(storage.load(repoScope), [{ name: 'Dev', tasks: ['build'] }]);
    assert.deepStrictEqual(storage.load(apiScope), []);
  });

  test('the groups of the workspace of a single-folder window move to its repository once', async () => {
    const ctx = context();
    const storage = createGroupStorage(ctx as unknown as vscode.ExtensionContext);
    const repoScope: GroupScope = { ...apiScope, id: 'repo:/r/.git', repo: '/r/.git' };
    ctx.workspaceState.data.virtualGroups = [{ name: 'Old', tasks: [] }];
    await migrateLegacyGroups(ctx as unknown as vscode.ExtensionContext, storage, [repoScope]);
    assert.deepStrictEqual(storage.load(repoScope), [{ name: 'Old', tasks: [] }]);

    await storage.save(repoScope, []);
    await migrateLegacyGroups(ctx as unknown as vscode.ExtensionContext, storage, [repoScope]);
    assert.deepStrictEqual(storage.load(repoScope), []);
  });
});
