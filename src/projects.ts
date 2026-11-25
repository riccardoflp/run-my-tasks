import * as path from 'path';
import * as vscode from 'vscode';
import { findGitDirs } from './gitRepo';

/**
 * Where groups live. A single-folder window has one scope: the checkout (or the folder) it
 * works in. A multi-root workspace has one scope per project (the folders in the same checkout
 * of a git repository make one project; each worktree is a project of its own) plus the
 * workspace scope, whose groups may mix the projects.
 */
export interface GroupScope {
  // Key of the scope among the scopes of the window, also used in the ids of the tree items
  readonly id: string;
  readonly label: string;
  // The workspace folders whose tasks and launch configurations the groups of the scope refer to
  readonly folders: readonly vscode.WorkspaceFolder[];
  // Git common dir of the project: its groups are shared by all the windows on the repository, and
  // by the projects of its other worktrees, each running them on its own checkout
  readonly repo?: string;
  // True for the workspace scope of a multi-root workspace: its entries name their folder
  readonly mixed: boolean;
}

export const WORKSPACE_SCOPE_ID = 'workspace';

// A .code-workspace (saved or untitled) or several folders: tasks may come from different projects
export function isMultiRoot(): boolean {
  return vscode.workspace.workspaceFile !== undefined || (vscode.workspace.workspaceFolders?.length ?? 0) > 1;
}

function gitDirsOf(folder: vscode.WorkspaceFolder): { gitDir: string; commonDir: string } | undefined {
  if (folder.uri.scheme !== 'file') { return undefined; }
  try {
    return findGitDirs(folder.uri.fsPath);
  } catch {
    return undefined;
  }
}

// The id of the project of a checkout: the main checkout keeps the id of its repository
const checkoutScopeId = (gitDir: string): string => `repo:${gitDir}`;

/**
 * Where the groups of a scope are kept: the projects of the worktrees of one repository share
 * theirs, the other scopes have their own
 */
export function groupsKey(scope: GroupScope): string {
  return scope.repo ? `repo:${scope.repo}` : scope.id;
}

export function computeScopes(): GroupScope[] {
  const folders = vscode.workspace.workspaceFolders ?? [];

  if (!isMultiRoot()) {
    const folder = folders[0];
    const git = folder && gitDirsOf(folder);
    return [{
      id: git ? checkoutScopeId(git.gitDir) : WORKSPACE_SCOPE_ID,
      label: folder?.name ?? 'Workspace',
      folders: folder ? [folder] : [],
      repo: git?.commonDir,
      mixed: false,
    }];
  }

  // Folders of the same checkout (e.g. two packages of a monorepo) make one project. A worktree
  // has the tasks of its repository under the same names: it makes a project of its own, so that
  // its groups run its tasks and not those of the main checkout
  const projects = new Map<string, { repo?: string; folders: vscode.WorkspaceFolder[] }>();
  for (const folder of folders) {
    const git = gitDirsOf(folder);
    const id = git ? checkoutScopeId(git.gitDir) : `folder:${folder.uri.toString()}`;
    const project = projects.get(id) ?? { repo: git?.commonDir, folders: [] };
    project.folders.push(folder);
    projects.set(id, project);
  }

  return [
    ...[...projects].map(([id, { repo, folders }]): GroupScope => ({
      id,
      label: folders.map(f => f.name).join(', '),
      folders,
      repo,
      mixed: false,
    })),
    { id: WORKSPACE_SCOPE_ID, label: 'Workspace', folders: [], mixed: true },
  ];
}

// The workspace folder a task belongs to; undefined for the tasks of the .code-workspace and the user tasks
export function taskFolder(task: vscode.Task): vscode.WorkspaceFolder | undefined {
  return typeof task.scope === 'object' ? task.scope : undefined;
}

/**
 * Where a task comes from, for the Tasks view and the picker of a multi-root workspace: its
 * folder, the .code-workspace file or the user tasks.
 */
export interface TaskOrigin {
  readonly key: string;
  readonly label: string;
  readonly folder?: vscode.WorkspaceFolder;
}

export function taskOrigin(task: vscode.Task): TaskOrigin {
  const folder = taskFolder(task);
  if (folder) { return { key: folder.uri.toString(), label: folder.name, folder }; }
  if (task.scope === vscode.TaskScope.Global) { return { key: 'user', label: 'User' }; }
  return { key: 'workspace', label: workspaceFileLabel() };
}

/**
 * How the tasks and launch configurations of the .code-workspace file are labelled: by the
 * file name, as "Workspace" is already the source of the tasks of tasks.json
 */
export function workspaceFileLabel(): string {
  const file = vscode.workspace.workspaceFile;
  return file?.scheme === 'file' ? path.basename(file.fsPath) : 'Workspace';
}

// Folders first, in the order of the workspace, then the .code-workspace tasks, then the user tasks
export function compareOrigins(a: TaskOrigin, b: TaskOrigin): number {
  const rank = (o: TaskOrigin): number => {
    if (o.folder) { return o.folder.index; }
    return (vscode.workspace.workspaceFolders?.length ?? 0) + (o.key === 'workspace' ? 0 : 1);
  };
  return rank(a) - rank(b);
}

const sameFolder = (a: vscode.WorkspaceFolder, b: vscode.WorkspaceFolder): boolean =>
  a.uri.toString() === b.uri.toString();

/**
 * Whether the groups of `scope` can hold a task or launch configuration of `folder`. Those
 * of no folder (the user tasks, say) can go anywhere.
 */
export function scopeAccepts(scope: GroupScope, folder: vscode.WorkspaceFolder | undefined): boolean {
  return scope.mixed || !folder || scope.folders.some(f => sameFolder(f, folder));
}

// The entries of the groups of the workspace scope name their folder: "<folder>\0<name>"
const REF_SEPARATOR = '\u0000';

export interface EntryRef {
  readonly name: string;
  // Name of the workspace folder; undefined for a plain name
  readonly folder?: string;
}

export function parseEntryRef(ref: string): EntryRef {
  const at = ref.indexOf(REF_SEPARATOR);
  return at < 0 ? { name: ref } : { folder: ref.slice(0, at), name: ref.slice(at + 1) };
}

// What a group of `scope` stores for the entry `name` of `folder`
export function entryRefFor(scope: GroupScope, name: string, folder: vscode.WorkspaceFolder | undefined): string {
  return scope.mixed && folder ? `${folder.name}${REF_SEPARATOR}${name}` : name;
}

/**
 * Whether an entry of `folder` may be the one `ref` stands for in a group of `scope`: a ref naming
 * a folder takes only the entries of that folder, a plain name those the scope accepts. Without
 * a scope (or in the workspace scope, for the groups saved before projects) any entry may be.
 */
export function refMatches(
  scope: GroupScope | undefined,
  ref: EntryRef,
  folder: vscode.WorkspaceFolder | undefined,
): boolean {
  if (ref.folder !== undefined) { return folder?.name === ref.folder; }
  return !scope || scopeAccepts(scope, folder);
}

// A ref as shown to the user: its name, and its folder when it names one
export function describeRef(ref: string): { label: string; description?: string } {
  const { name, folder } = parseEntryRef(ref);
  return { label: name, description: folder };
}
