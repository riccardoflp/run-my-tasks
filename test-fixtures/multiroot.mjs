// Builds the multi-root workspace of the multi-root tests from test-fixtures/multiroot, in the temporary directory:
// outside this repository, whose git directory the folders would otherwise belong to. Its folders are
// - api: a git repository with the tasks build and serve, and the launch configuration debug-api
// - web: another git repository, with the tasks build (named as the one of api) and dev
// - web-feature: a worktree of web, with its tasks build and dev and the task preview of its branch: a project
//   of its own, sharing the groups of web
// - notes: a folder outside git, with the task todo
// and shop.code-workspace has the task everything.
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';

const template = path.join(path.dirname(fileURLToPath(import.meta.url)), 'multiroot');

const git = (cwd, ...args) => execFileSync('git', [
  '-c', 'user.name=Run My Tasks tests',
  '-c', 'user.email=tests@example.com',
  '-c', 'init.defaultBranch=main',
  '-c', 'commit.gpgsign=false',
  ...args,
], { cwd, stdio: 'pipe' });

// The path of the .code-workspace file to open
export function createMultiRootWorkspace() {
  const root = path.join(os.tmpdir(), 'run-my-tasks-multiroot');
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });
  for (const entry of ['api', 'web', 'notes', 'shop.code-workspace']) {
    fs.cpSync(path.join(template, entry), path.join(root, entry), { recursive: true });
  }
  for (const repo of ['api', 'web']) {
    git(path.join(root, repo), 'init', '--quiet');
    git(path.join(root, repo), 'add', '--all');
    git(path.join(root, repo), 'commit', '--quiet', '-m', 'Fixture');
  }
  git(path.join(root, 'web'), 'worktree', 'add', '--quiet', path.join(root, 'web-feature'));
  fs.cpSync(path.join(template, 'web-feature'), path.join(root, 'web-feature'), { recursive: true });
  return path.join(root, 'shop.code-workspace');
}
