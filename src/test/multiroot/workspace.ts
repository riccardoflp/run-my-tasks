import * as vscode from 'vscode';
import { ExtensionApi } from '../../extension';
import { GroupScope } from '../../projects';
import { setGroups, VirtualGroup } from '../../taskTreeProvider';
import { FOLLOW_SCM_SETTING, GitApi, GitExtension, GitRepository } from '../../scmSelection';
import { saveGroups as saveGroupsOf, waitFor } from '../helpers';

// The workspace of the multi-root tests, built by test-fixtures/multiroot.mjs: the projects api (a repository),
// web (a repository and its worktree web-feature) and notes (outside git), and the tasks of shop.code-workspace

export function folder(name: string): vscode.WorkspaceFolder {
  const found = vscode.workspace.workspaceFolders?.find(f => f.name === name);
  if (!found) { throw new Error(`Fixture folder "${name}" not found`); }
  return found;
}

export function scope(api: ExtensionApi, label: string): GroupScope {
  const found = api.shared.scopes.find(s => s.label === label);
  if (!found) { throw new Error(`Scope "${label}" not found among ${api.shared.scopes.map(s => s.label).join(', ')}`); }
  return found;
}

// The task named `name` of the folder `folderName`
export async function folderTask(name: string, folderName: string): Promise<vscode.Task> {
  const tasks = await vscode.tasks.fetchTasks();
  const task = tasks.find(t => t.name === name && typeof t.scope === 'object' && t.scope.name === folderName);
  if (!task) { throw new Error(`Fixture task "${name}" of ${folderName} not found`); }
  return task;
}

// "build@api": the names of the running tasks with their folder
export function runningInFolders(): string[] {
  return vscode.tasks.taskExecutions
    .map(e => `${e.task.name}@${typeof e.task.scope === 'object' ? e.task.scope.name : 'workspace'}`)
    .sort();
}

export async function gitApi(): Promise<GitApi> {
  const extension = vscode.extensions.getExtension<GitExtension>('vscode.git');
  if (!extension) { throw new Error('The git extension is missing'); }
  const git = extension.isActive ? extension.exports : await extension.activate();
  const api = git.getAPI(1);
  // api, web and the worktree web-feature
  await waitFor(() => api.repositories.length >= 3, 'git to open the repositories of the workspace', 20000);
  return api;
}

const repositoryOf = (api: GitApi, name: string): GitRepository | null => api.getRepository(folder(name).uri);

/**
 * Selects the repository of the folder in the Repositories view of Source Control, as a click
 * does: the rows are walked from the first one until the repository is selected.
 */
export async function selectRepository(name: string): Promise<void> {
  const git = await gitApi();
  const selected = () => repositoryOf(git, name)?.ui.selected === true;
  // The selection reaches the git extension a moment after the click
  const becomesSelected = () => waitFor(selected, 'the selection', 1000).then(() => true, () => false);
  if (!selected()) {
    await vscode.commands.executeCommand('workbench.scm.repositories.focus');
    await vscode.commands.executeCommand('list.focusFirst');
    await vscode.commands.executeCommand('list.select');
    for (let row = 1; row < git.repositories.length && !await becomesSelected(); row++) {
      await vscode.commands.executeCommand('list.focusDown');
      await vscode.commands.executeCommand('list.select');
    }
    await waitFor(selected, `the repository of ${name} to be selected in Source Control`);
  }
  // Only that one: the others follow
  await waitFor(() => git.repositories.filter(r => r.ui.selected).length === 1, 'a single repository selected');
}

// Turns runMyTasks.followScmSelection on or off in the workspace settings (undefined: back to the default)
export async function followScmSelection(value: boolean | undefined): Promise<void> {
  await vscode.workspace.getConfiguration('runMyTasks')
    .update(FOLLOW_SCM_SETTING, value, vscode.ConfigurationTarget.Workspace);
  await waitFor(
    () => vscode.workspace.getConfiguration('runMyTasks').get(FOLLOW_SCM_SETTING, true) === (value ?? true),
    'the setting to change',
  );
}

// Saves the groups of the scope, and waits until they stay saved (see helpers.ts)
export async function saveGroups(api: ExtensionApi, scope: GroupScope, groups: VirtualGroup[]): Promise<void> {
  await saveGroupsOf(api, groups, scope);
}

// Every project without groups, waiting as saveGroups does
export async function clearGroups(api: ExtensionApi): Promise<void> {
  let steady = 0;
  await waitFor(async () => {
    const left = api.shared.scopes.filter(scope => api.loadGroups(scope).length > 0);
    for (const scope of left) { await api.saveGroups([], scope); }
    steady = left.length > 0 ? 0 : steady + 1;
    return steady >= 3;
  }, 'the groups of every project to be cleared');
  // The views show what is saved
  for (const scope of api.shared.scopes) { setGroups(api.shared, [], scope); }
}
