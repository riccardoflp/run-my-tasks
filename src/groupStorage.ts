import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { VirtualGroup } from './taskTreeProvider';

const GROUPS_KEY = 'virtualGroups';
// Groups of every git repository, keyed by the repository's common git directory
const GROUPS_BY_REPO_KEY = 'virtualGroupsByRepo';

type GroupsByRepo = Record<string, VirtualGroup[]>;

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

// The repository a single-folder window works in; multi-root workspaces keep their own groups
function workspaceRepo(): string | undefined {
  const folders = vscode.workspace.workspaceFolders;
  if (vscode.workspace.workspaceFile || folders?.length !== 1 || folders[0].uri.scheme !== 'file') {
    return undefined;
  }
  try {
    return findGitCommonDir(folders[0].uri.fsPath);
  } catch {
    return undefined;
  }
}

export interface GroupStorage {
  load(): VirtualGroup[];
  save(groups: VirtualGroup[]): Promise<void>;
}

/**
 * Groups are shared by all the windows opened on the same git repository, worktrees included,
 * through globalState; outside a repository they stay in the workspaceState.
 */
export function createGroupStorage(context: vscode.ExtensionContext): GroupStorage {
  const repo = workspaceRepo();
  if (!repo) {
    return {
      load: () => context.workspaceState.get<VirtualGroup[]>(GROUPS_KEY, []),
      save: groups => Promise.resolve(context.workspaceState.update(GROUPS_KEY, groups)),
    };
  }

  // Read the map again on every access: other windows update it too
  const byRepo = (): GroupsByRepo => context.globalState.get<GroupsByRepo>(GROUPS_BY_REPO_KEY, {});
  const storage: GroupStorage = {
    load: () => byRepo()[repo] ?? [],
    save: groups => Promise.resolve(
      context.globalState.update(GROUPS_BY_REPO_KEY, { ...byRepo(), [repo]: groups }),
    ),
  };

  // Groups saved by earlier versions in this workspace become the groups of the repository
  const legacy = context.workspaceState.get<VirtualGroup[]>(GROUPS_KEY, []);
  if (legacy.length > 0 && !(repo in byRepo())) {
    void storage.save(legacy);
  }
  return storage;
}
