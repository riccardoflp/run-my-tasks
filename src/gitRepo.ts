import * as fs from 'fs';
import * as path from 'path';

/**
 * The git directories of the checkout containing `folder`: `gitDir` is its own (.git of the
 * main checkout, .git/worktrees/<name> of a worktree), `commonDir` the one the main checkout
 * and all its worktrees share. Undefined when `folder` is not inside a git repository.
 */
export function findGitDirs(folder: string): { gitDir: string; commonDir: string } | undefined {
  for (let dir = path.resolve(folder); ; dir = path.dirname(dir)) {
    const dotGit = path.join(dir, '.git');
    const stat = fs.statSync(dotGit, { throwIfNoEntry: false });
    if (stat?.isDirectory()) {
      const gitDir = canonicalGitDir(dotGit);
      return { gitDir, commonDir: gitDir };
    }
    if (stat?.isFile()) {
      // A worktree: .git is a file pointing to <common dir>/worktrees/<name>, whose
      // commondir file points back to the common dir
      const match = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dotGit, 'utf8'));
      if (!match) { return undefined; }
      const gitDir = path.resolve(dir, match[1].trim());
      const commonDirFile = path.join(gitDir, 'commondir');
      const commonDir = fs.existsSync(commonDirFile)
        ? path.resolve(gitDir, fs.readFileSync(commonDirFile, 'utf8').trim())
        : gitDir;
      return { gitDir: canonicalGitDir(gitDir), commonDir: canonicalGitDir(commonDir) };
    }
    if (path.dirname(dir) === dir) { return undefined; }
  }
}

/**
 * The common git directory of the repository containing `folder`: the same for the main
 * checkout and all its worktrees. Undefined when `folder` is not inside a git repository.
 */
export function findGitCommonDir(folder: string): string | undefined {
  return findGitDirs(folder)?.commonDir;
}

/**
 * The key of a git directory: its real path, so that a repository opened through a symbolic link, a
 * junction or a short 8.3 name (C:\Users\RUNNER~1) gets the key of its worktrees, whose .git file
 * git writes with the real path. In lower case on Windows, whose paths ignore it.
 */
export function canonicalGitDir(dir: string): string {
  let real = path.resolve(dir);
  try {
    real = fs.realpathSync.native(real);
  } catch {
    // A git directory that is gone keeps the path it had
  }
  return process.platform === 'win32' ? real.toLowerCase() : real;
}
