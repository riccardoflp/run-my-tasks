import * as vscode from 'vscode';
import { findGitCommonDir } from './gitRepo';
import { GroupScope, WORKSPACE_SCOPE_ID } from './projects';
import { VirtualGroup } from './taskTreeProvider';

export { findGitCommonDir };

// Groups of a window outside a git repository, or of the workspace scope of a multi-root workspace
const GROUPS_KEY = 'virtualGroups';
// Groups of every git repository, keyed by the repository's common git directory
const GROUPS_BY_REPO_KEY = 'virtualGroupsByRepo';
// Groups of the folders of a multi-root workspace outside a git repository, keyed by scope id
const GROUPS_BY_FOLDER_KEY = 'virtualGroupsByFolder';

type GroupsByKey = Record<string, VirtualGroup[]>;

export interface GroupStorage {
  load(scope: GroupScope): VirtualGroup[];
  save(scope: GroupScope, groups: VirtualGroup[]): Promise<void>;
}

/**
 * The groups of a project in a git repository are shared by all the windows opened on it,
 * worktrees and multi-root workspaces including it too, through globalState; the others stay
 * in the workspaceState.
 */
export function createGroupStorage(context: vscode.ExtensionContext): GroupStorage {
  // Read the maps again on every access: other windows update them too
  const map = (memento: vscode.Memento, key: string): GroupsByKey => memento.get<GroupsByKey>(key, {});
  const location = (scope: GroupScope): { memento: vscode.Memento; key: string; entry?: string } => {
    if (scope.repo) { return { memento: context.globalState, key: GROUPS_BY_REPO_KEY, entry: scope.repo }; }
    if (scope.id === WORKSPACE_SCOPE_ID) { return { memento: context.workspaceState, key: GROUPS_KEY }; }
    return { memento: context.workspaceState, key: GROUPS_BY_FOLDER_KEY, entry: scope.id };
  };

  return {
    load: scope => {
      const { memento, key, entry } = location(scope);
      return entry === undefined ? memento.get<VirtualGroup[]>(key, []) : map(memento, key)[entry] ?? [];
    },
    save: (scope, groups) => {
      const { memento, key, entry } = location(scope);
      const value = entry === undefined ? groups : { ...map(memento, key), [entry]: groups };
      return Promise.resolve(memento.update(key, value));
    },
  };
}

/**
 * Groups saved by versions before 0.6 in the workspace of a single-folder window become the
 * groups of its repository, unless the repository has groups already.
 */
export async function migrateLegacyGroups(
  context: vscode.ExtensionContext,
  storage: GroupStorage,
  scopes: readonly GroupScope[],
): Promise<void> {
  const [scope] = scopes;
  if (scopes.length !== 1 || !scope.repo) { return; }
  const legacy = context.workspaceState.get<VirtualGroup[]>(GROUPS_KEY, []);
  const byRepo = context.globalState.get<GroupsByKey>(GROUPS_BY_REPO_KEY, {});
  if (legacy.length > 0 && !(scope.repo in byRepo)) {
    await storage.save(scope, legacy);
  }
}
