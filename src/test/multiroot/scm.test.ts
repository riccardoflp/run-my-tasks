import * as assert from 'assert';
import * as vscode from 'vscode';
import { ExtensionApi } from '../../extension';
import { GitApi, GitExtension, GitRepository, ScmSelection } from '../../scmSelection';
import { GroupsTreeProvider, TasksTreeProvider } from '../../taskTreeProvider';
import { fakeInputBox, getApi, restoreStubs, waitFor, withSettings } from '../helpers';
import { clearGroups, folder, followScmSelection, scope, selectRepository } from './workspace';

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
    await followScmSelection(undefined);
  });

  const shownProjects = async () => labels(await new GroupsTreeProvider(api.shared).getChildren());
  const shownOrigins = async () => labels(await new TasksTreeProvider(api.shared).getChildren());

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

    test('selecting web shows the project web, its worktree included, and hides api', async () => {
      await selectRepository('web');
      await waitFor(() => !api.shared.visibility.isFolderShown(folder('api')), 'api to be hidden');
      assert.deepStrictEqual(await shownProjects(), ['web, web-feature', 'notes', 'Workspace']);
      // The worktree is a repository of its own for git, not selected: its folder is hidden in the Tasks view
      assert.deepStrictEqual(await shownOrigins(), ['web', 'notes', 'shop.code-workspace']);
    });

    test('selecting the worktree shows its project', async () => {
      await selectRepository('web-feature');
      await waitFor(() => api.shared.visibility.isFolderShown(folder('web-feature')), 'web-feature to be shown');
      assert.deepStrictEqual(await shownProjects(), ['web, web-feature', 'notes', 'Workspace']);
      assert.deepStrictEqual(await shownOrigins(), ['web-feature', 'notes', 'shop.code-workspace']);
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
      assert.deepStrictEqual(await shownProjects(), ['api', 'web, web-feature', 'notes', 'Workspace']);
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
  });

  // A fake git extension, for what the Repositories view cannot do from the tests: select several
  // repositories, none, or have git missing
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
      assert.ok(selection.isScopeShown(scope(api, 'web, web-feature')));
      assert.ok(selection.isScopeShown(scope(api, 'Workspace')));
      repos.feature.select(false);
      assert.ok(!selection.isScopeShown(scope(api, 'web, web-feature')));
      assert.ok(selection.isScopeShown(scope(api, 'notes')));
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
