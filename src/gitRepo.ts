import * as fs from 'fs';
import * as path from 'path';

/**
 * The common git directory of the repository containing `folder`: the same for the main
 * checkout and all its worktrees. Undefined when `folder` is not inside a git repository.
 */
export function findGitCommonDir(folder: string): string | undefined {
  for (let dir = path.resolve(folder); ; dir = path.dirname(dir)) {
    const dotGit = path.join(dir, '.git');
    const stat = fs.statSync(dotGit, { throwIfNoEntry: false });
    if (stat?.isDirectory()) {
      return normalize(dotGit);
    }
    if (stat?.isFile()) {
      // A worktree: .git is a file pointing to <common dir>/worktrees/<name>, whose
      // commondir file points back to the common dir
      const match = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dotGit, 'utf8'));
      if (!match) { return undefined; }
      const gitDir = path.resolve(dir, match[1].trim());
      const commonDirFile = path.join(gitDir, 'commondir');
      if (!fs.existsSync(commonDirFile)) { return normalize(gitDir); }
      return normalize(path.resolve(gitDir, fs.readFileSync(commonDirFile, 'utf8').trim()));
    }
    if (path.dirname(dir) === dir) { return undefined; }
  }
}

function normalize(dir: string): string {
  const resolved = path.resolve(dir);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}
