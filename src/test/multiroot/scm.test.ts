import * as assert from 'assert';
import * as vscode from 'vscode';
import { ExtensionApi } from '../../extension';
import { GitApi, GitExtension, GitRepository, ScmSelection } from '../../scmSelection';
import { taskOrigin } from '../../projects';
import { GroupsTreeProvider, SharedState, TasksTreeProvider, TaskTreeItem } from '../../taskTreeProvider';
import { fakeInputBox, getApi, restoreStubs, waitFor, withSettings } from '../helpers';
import { clearGroups, folder, followScmSelection, gitApi, saveGroups, scope, selectRepository } from './workspace';

const labels = (items: vscode.TreeItem[]) => items.map(i => i.label);
const SCM_MESSAGE = 'Showing the repositories selected in Source Control';

suite('Source Control selection', () => {
  let api: ExtensionApi;

  suiteSetup(async () => {
    api = await getApi();
    await followScmSelection(undefined);
  });

  setup(async () => {
    await clearGroups(api);
  });

  teardown(async () => {
    restoreStubs();
    // Back to following the active repository
    await vscode.commands.executeCommand('run-my-tasks.showScmRepositories');
    await followScmSelection(undefined);
  });

  const shownProjects = async () => labels(await new GroupsTreeProvider(api.shared).getChildren());
  const shownOrigins = async () => labels(await new TasksTreeProvider(api.shared).getChildren());
  // "task@folder" of the entries of the groups of each project shown, by project
  const shownEntries = async (shared: SharedState = api.shared): Promise<Record<string, string[][]>> => {
    const provider = new GroupsTreeProvider(shared);
    const entries: Record<string, string[][]> = {};
    for (const project of await provider.getChildren()) {
      const groups = await provider.getChildren(project);
      if (groups.length === 0) { continue; }
      entries[String(project.label)] = await Promise.all(groups.map(async group =>
        (await provider.getChildren(group) as TaskTreeItem[]).map(e => `${e.task.name}@${taskOrigin(e.task).label}`)));
    }
    return entries;
  };

  // The real Repositories view, selected one repository at a time (its default selection mode)
  suite('Repositories view', () => {
    test('with api selected, the views show api, the folders outside git and the workspace', async () => {
      await selectRepository('api');
      await waitFor(() => !api.shared.visibility.isFolderShown(folder('web')), 'web to be hidden');
      assert.deepStrictEqual(await shownProjects(), ['api', 'notes', 'Workspace']);
      assert.deepStrictEqual(await shownOrigins(), ['api', 'notes', 'shop.code-workspace']);
      assert.strictEqual(api.views.groups.message, SCM_MESSAGE);
      assert.strictEqual(api.views.tasks.message, SCM_MESSAGE);
      // The launch configurations are not filtered
      assert.strictEqual(api.views.launch.message, undefined);
    });

    test('selecting web shows the project web, not the one of its worktree, and hides api', async () => {
      await selectRepository('web');
      await waitFor(() => !api.shared.visibility.isFolderShown(folder('api')), 'api to be hidden');
      // The worktree is a repository of its own for git, not selected: its project and folder are hidden
      assert.deepStrictEqual(await shownProjects(), ['web', 'notes', 'Workspace']);
      assert.deepStrictEqual(await shownOrigins(), ['web', 'notes', 'shop.code-workspace']);
    });

    test('selecting the worktree shows its project, whose groups run its tasks', async () => {
      await saveGroups(api, scope(api, 'web'), [{ name: 'Build', tasks: ['build'] }]);
      await selectRepository('web-feature');
      await waitFor(() => api.shared.visibility.isFolderShown(folder('web-feature')), 'web-feature to be shown');
      assert.deepStrictEqual(await shownProjects(), ['web-feature', 'notes', 'Workspace']);
      assert.deepStrictEqual(await shownOrigins(), ['web-feature', 'notes', 'shop.code-workspace']);
      assert.deepStrictEqual(await shownEntries(), { 'web-feature': [['build@web-feature']] });
    });

    test('the views are redrawn when the selection changes', async () => {
      await selectRepository('api');
      const changed = new Promise<void>(resolve => {
        const listener = (api.shared.visibility as ScmSelection).onDidChange(() => { listener.dispose(); resolve(); });
      });
      await selectRepository('web');
      await changed;
    });

    test('runMyTasks.followScmSelection off shows every project, without the message', async () => {
      await selectRepository('api');
      await followScmSelection(false);
      await waitFor(() => api.views.groups.message === undefined, 'the message to go away');
      assert.deepStrictEqual(await shownProjects(), ['api', 'web', 'web-feature', 'notes', 'Workspace']);
      assert.deepStrictEqual(await shownOrigins(), ['api', 'web', 'web-feature', 'notes', 'shop.code-workspace']);
      assert.strictEqual(api.views.tasks.message, undefined);

      await followScmSelection(true);
      await waitFor(() => api.views.groups.message === SCM_MESSAGE, 'the message to come back');
      assert.deepStrictEqual(await shownProjects(), ['api', 'notes', 'Workspace']);
    });

    test('the message tells the search too, and the search matches the project names', async () => {
      await selectRepository('api');
      const input = fakeInputBox();
      await vscode.commands.executeCommand('run-my-tasks.search');
      try {
        input.type('notes');
        assert.strictEqual(api.views.groups.message, `Search results for "notes" · ${SCM_MESSAGE}`);
        assert.strictEqual(api.views.tasks.message, `Search results for "notes" · ${SCM_MESSAGE}`);
        assert.strictEqual(api.views.launch.message, 'Search results for "notes"');
        assert.deepStrictEqual(await shownProjects(), ['notes']);
        assert.deepStrictEqual(await shownOrigins(), ['notes']);
      } finally {
        input.accept();
        await vscode.commands.executeCommand('run-my-tasks.clearSearch');
      }
      assert.strictEqual(api.views.groups.message, SCM_MESSAGE);
    });

    test('Show in Run My Tasks shows the repositories of the rows it is given, until another one is clicked', async () => {
      await saveGroups(api, scope(api, 'web'), [{ name: 'Build', tasks: ['build'] }]);
      await selectRepository('web');
      const git = await gitApi();
      // What the context menu of the rows hands: the source control of the row clicked, then those of the other selected rows
      const row = (name: string) => ({ rootUri: git.getRepository(folder(name).uri)!.rootUri, label: 'Git' });
      await vscode.commands.executeCommand('run-my-tasks.showScmRepositories', row('web-feature'), row('web'));
      assert.deepStrictEqual(await shownProjects(), ['web', 'web-feature', 'notes', 'Workspace']);
      assert.deepStrictEqual(await shownEntries(), { web: [['build@web']], 'web-feature': [['build@web-feature']] });
      assert.deepStrictEqual(await shownOrigins(), ['web', 'web-feature', 'notes', 'shop.code-workspace']);
      assert.strictEqual(api.views.groups.message, SCM_MESSAGE);

      await selectRepository('api');
      await waitFor(async () => (await shownProjects()).join() === 'api,notes,Workspace', 'the views to follow api');
    });
  });

  // A fake git extension, for what the Repositories view cannot do from the tests: mark several
  // repositories active (VS Code marks one at a time), none, or have git missing
  suite('With any selection', () => {
    interface FakeRepo extends GitRepository { select(selected: boolean): void; }

    const fakeRepo = (name: string): FakeRepo => {
      const changed = new vscode.EventEmitter<void>();
      const ui = { selected: false, onDidChange: changed.event };
      return {
        rootUri: folder(name).uri,
        ui,
        select: selected => {
          ui.selected = selected;
          changed.fire();
        },
      };
    };

    const fakeGit = (repos: FakeRepo[], enabled = true) => {
      const opened = new vscode.EventEmitter<GitRepository>();
      const closed = new vscode.EventEmitter<GitRepository>();
      const gitApi: GitApi = {
        repositories: repos,
        onDidOpenRepository: opened.event,
        onDidCloseRepository: closed.event,
        getRepository: uri => repos.find(r => uri.toString() === r.rootUri.toString()) ?? null,
      };
      const extension = { isActive: true, exports: { enabled, getAPI: () => gitApi } };
      return { extension: () => extension as unknown as vscode.Extension<GitExtension>, opened, closed };
    };

    // A selection over the fake git, connected once it has fired its first change
    const connect = async (git: ReturnType<typeof fakeGit>): Promise<ScmSelection> => {
      const selection = new ScmSelection(git.extension);
      await new Promise(r => setTimeout(r, 50));
      return selection;
    };

    let repos: Record<'api' | 'web' | 'feature', FakeRepo>;
    let selection: ScmSelection;

    setup(async () => {
      repos = { api: fakeRepo('api'), web: fakeRepo('web'), feature: fakeRepo('web-feature') };
      selection = await connect(fakeGit(Object.values(repos)));
    });

    teardown(() => selection.dispose());

    test('with no repository selected every folder is shown', () => {
      for (const name of ['api', 'web', 'web-feature', 'notes']) {
        assert.ok(selection.isFolderShown(folder(name)), name);
      }
    });

    test('with several repositories selected their folders are shown, with those outside git', () => {
      repos.api.select(true);
      repos.feature.select(true);
      assert.deepStrictEqual(
        ['api', 'web', 'web-feature', 'notes'].filter(name => selection.isFolderShown(folder(name))),
        ['api', 'web-feature', 'notes'],
      );
      // A project is shown when one of its folders is; the workspace always
      assert.ok(selection.isScopeShown(scope(api, 'web-feature')));
      assert.ok(!selection.isScopeShown(scope(api, 'web')));
      assert.ok(selection.isScopeShown(scope(api, 'Workspace')));
      repos.feature.select(false);
      assert.ok(!selection.isScopeShown(scope(api, 'web-feature')));
      assert.ok(selection.isScopeShown(scope(api, 'notes')));
    });

    test('with a repository and its worktree selected, each project runs the groups on its own checkout', async () => {
      await saveGroups(api, scope(api, 'web'), [{ name: 'Build', tasks: ['build', 'preview'] }]);
      repos.web.select(true);
      repos.feature.select(true);
      const shared = { ...api.shared, visibility: selection };
      assert.deepStrictEqual(labels(await new GroupsTreeProvider(shared).getChildren()), ['web', 'web-feature', 'notes', 'Workspace']);
      assert.deepStrictEqual(await shownEntries(shared), {
        web: [['build@web']],
        'web-feature': [['build@web-feature', 'preview@web-feature']],
      });
      assert.deepStrictEqual(labels(await new TasksTreeProvider(shared).getChildren()), ['web', 'web-feature', 'notes', 'shop.code-workspace']);
    });

    test('with a worktree and another repository selected, the repository of the worktree stays hidden', async () => {
      await saveGroups(api, scope(api, 'web'), [{ name: 'Build', tasks: ['build'] }]);
      await saveGroups(api, scope(api, 'api'), [{ name: 'Build', tasks: ['build'] }]);
      repos.api.select(true);
      repos.feature.select(true);
      const shared = { ...api.shared, visibility: selection };
      assert.deepStrictEqual(await shownEntries(shared), {
        api: [['build@api']],
        'web-feature': [['build@web-feature']],
      });
      assert.deepStrictEqual(labels(await new TasksTreeProvider(shared).getChildren()), ['api', 'web-feature', 'notes', 'shop.code-workspace']);
    });

    test('tells when a repository is selected, opened or closed, or the setting changes', async () => {
      let changes = 0;
      const git = fakeGit(Object.values(repos));
      selection.dispose();
      selection = await connect(git);
      selection.onDidChange(() => changes++);

      repos.web.select(true);
      assert.strictEqual(changes, 1);
      git.opened.fire(fakeRepo('notes'));
      assert.strictEqual(changes, 2);
      git.closed.fire(repos.web);
      assert.strictEqual(changes, 3);
      // The closed repository is no longer listened to
      repos.web.select(false);
      assert.strictEqual(changes, 3);

      await followScmSelection(false);
      await waitFor(() => changes === 4, 'the setting change to be told');
    });

    test('with the setting off every folder is shown', () => {
      repos.api.select(true);
      withSettings({ followScmSelection: false });
      assert.ok(selection.isFolderShown(folder('web')));
    });

    const shown = () => ['api', 'web', 'web-feature', 'notes'].filter(name => selection.isFolderShown(folder(name)));

    test('the repositories chosen with Show in Run My Tasks are shown until another one becomes active', () => {
      let changes = 0;
      selection.onDidChange(() => changes++);
      repos.web.select(true);
      selection.choose([repos.web.rootUri, repos.feature.rootUri]);
      assert.strictEqual(changes, 2);
      assert.deepStrictEqual(shown(), ['web', 'web-feature', 'notes']);
      assert.ok(selection.isScopeShown(scope(api, 'web')));
      assert.ok(selection.isScopeShown(scope(api, 'web-feature')));
      assert.ok(!selection.isScopeShown(scope(api, 'api')));

      // The active repository moving among them keeps them
      repos.web.select(false);
      repos.feature.select(true);
      assert.deepStrictEqual(shown(), ['web', 'web-feature', 'notes']);

      // Another one: the views follow it again
      repos.feature.select(false);
      repos.api.select(true);
      assert.deepStrictEqual(shown(), ['api', 'notes']);
    });

    test('a chosen repository closed is no longer shown; with none left, the active one is', async () => {
      const git = fakeGit(Object.values(repos));
      selection.dispose();
      selection = await connect(git);
      repos.api.select(true);
      selection.choose([repos.web.rootUri, repos.feature.rootUri]);
      git.closed.fire(repos.feature);
      assert.deepStrictEqual(shown(), ['web', 'notes']);
      git.closed.fire(repos.web);
      assert.deepStrictEqual(shown(), ['api', 'notes']);
    });

    test('choosing no repository follows the active one again', () => {
      repos.api.select(true);
      selection.choose([repos.web.rootUri]);
      assert.deepStrictEqual(shown(), ['web', 'notes']);
      selection.choose([]);
      assert.deepStrictEqual(shown(), ['api', 'notes']);
    });

    test('with the setting off the chosen repositories are ignored', () => {
      selection.choose([repos.web.rootUri]);
      withSettings({ followScmSelection: false });
      assert.deepStrictEqual(shown(), ['api', 'web', 'web-feature', 'notes']);
    });

    test('with git disabled or missing every folder is shown', async () => {
      repos.api.select(true);
      const disabled = await connect(fakeGit(Object.values(repos), false));
      const missing = new ScmSelection(() => undefined);
      try {
        assert.ok(disabled.isFolderShown(folder('web')));
        assert.ok(missing.isFolderShown(folder('web')));
      } finally {
        disabled.dispose();
        missing.dispose();
      }
    });
  });
});
