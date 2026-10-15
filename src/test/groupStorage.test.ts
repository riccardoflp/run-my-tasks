import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { findGitCommonDir } from '../groupStorage';

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
});
