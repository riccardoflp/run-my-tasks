import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { createGroupStorage, findGitCommonDir } from '../groupStorage';
import { GroupScope } from '../projects';

suite('Group storage', () => {
  let root: string;

  setup(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'run-my-tasks-')); });
  teardown(() => fs.rmSync(root, { recursive: true, force: true }));

  // A repository in root/main with a worktree in root/wt, laid out as git does
  function createRepoWithWorktree(): { main: string; worktree: string } {
    const main = path.join(root, 'main');
    const worktree = path.join(root, 'wt');
    const worktreeGitDir = path.join(main, '.git', 'worktrees', 'wt');
    fs.mkdirSync(path.join(main, 'src'), { recursive: true });
    fs.mkdirSync(worktreeGitDir, { recursive: true });
    fs.writeFileSync(path.join(worktreeGitDir, 'commondir'), '../..\n');
    fs.mkdirSync(worktree);
    fs.writeFileSync(path.join(worktree, '.git'), `gitdir: ${worktreeGitDir}\n`);
    return { main, worktree };
  }

  test('a worktree shares the common git dir of its main checkout', () => {
    const { main, worktree } = createRepoWithWorktree();
    const mainDir = findGitCommonDir(main);
    assert.ok(mainDir);
    assert.strictEqual(findGitCommonDir(worktree), mainDir);
  });

  test('a folder inside the repository resolves to the repository', () => {
    const { main } = createRepoWithWorktree();
    assert.strictEqual(findGitCommonDir(path.join(main, 'src')), findGitCommonDir(main));
  });

  test('a relative gitdir is resolved from the worktree', () => {
    const { worktree } = createRepoWithWorktree();
    fs.writeFileSync(path.join(worktree, '.git'), 'gitdir: ../main/.git/worktrees/wt\n');
    assert.strictEqual(findGitCommonDir(worktree), findGitCommonDir(path.join(root, 'main')));
  });

  test('different repositories get different keys', () => {
    const { main } = createRepoWithWorktree();
    const other = path.join(root, 'other');
    fs.mkdirSync(path.join(other, '.git'), { recursive: true });
    assert.notStrictEqual(findGitCommonDir(other), findGitCommonDir(main));
  });

  // A link to the main checkout, as a repository opened through a symbolic link, or through a short
  // 8.3 name on Windows (a junction needs no privileges there)
  function linkTo(target: string): string {
    const link = path.join(root, 'link');
    fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
    return link;
  }

  test('a repository opened through a link gets the key of its worktrees, which git writes with the real path', () => {
    const { main, worktree } = createRepoWithWorktree();
    const link = linkTo(main);
    assert.strictEqual(findGitCommonDir(link), findGitCommonDir(worktree));
    assert.strictEqual(findGitCommonDir(link), findGitCommonDir(main));
  });

  test('the groups saved under the path the repository was opened by are still found', async () => {
    const { main } = createRepoWithWorktree();
    const link = linkTo(main);
    // The key before 0.9: the path of the .git directory as opened, not its real path
    const oldKey = path.resolve(link, '.git');
    const keyOf = (p: string) => (process.platform === 'win32' ? p.toLowerCase() : p);
    const data: Record<string, unknown> = {
      virtualGroupsByRepo: { [keyOf(oldKey)]: [{ name: 'Dev', tasks: ['build'] }] },
    };
    const memento = {
      get: (key: string, fallback?: unknown) => (key in data ? data[key] : fallback),
      update: async (key: string, value: unknown) => { data[key] = value; },
      keys: () => Object.keys(data),
    };
    const storage = createGroupStorage({ globalState: memento, workspaceState: memento } as unknown as vscode.ExtensionContext);
    const repo = findGitCommonDir(link)!;
    assert.notStrictEqual(repo, keyOf(oldKey));
    const scope: GroupScope = { id: `repo:${repo}`, label: 'main', folders: [], repo, mixed: false };

    assert.deepStrictEqual(storage.load(scope), [{ name: 'Dev', tasks: ['build'] }]);
    // Saved again under the real path
    await storage.save(scope, [{ name: 'Dev', tasks: ['build', 'test'] }]);
    assert.deepStrictEqual(storage.load(scope), [{ name: 'Dev', tasks: ['build', 'test'] }]);
  });
});
