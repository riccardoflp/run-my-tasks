import * as vscode from 'vscode';
import { GroupScope } from './projects';
import { ScmSelection } from './scmSelection';
import { ProjectVisibility } from './taskTreeProvider';

// Where the workspace keeps the projects chosen with Choose Projects
export const CHOSEN_PROJECTS_KEY = 'runMyTasks.chosenProjects';

// Every project, or the ids of the scopes of those chosen
export type Choice = 'all' | readonly string[];

// What decides the projects shown: the choice, or the selection of Source Control
export type ChoiceMode = 'all' | 'chosen' | 'scm';

/**
 * The projects the Groups and Tasks views of a multi-root workspace show. Those chosen with
 * Choose Projects, or with Show in Run My Tasks in Source Control, stay shown, in this window and the
 * next ones on the workspace, until another choice; without a choice the views follow the
 * repositories selected in Source Control (ScmSelection).
 */
export class ProjectChoice implements ProjectVisibility, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;
  private readonly listener: vscode.Disposable;

  constructor(
    private readonly state: vscode.Memento,
    readonly scm: ScmSelection,
    private readonly scopes: () => readonly GroupScope[],
  ) {
    this.listener = scm.onDidChange(() => this.changed.fire());
  }

  // The choice saved, the ids of projects no longer in the workspace left out
  get choice(): Choice | undefined {
    const saved = this.state.get<unknown>(CHOSEN_PROJECTS_KEY);
    if (saved === 'all') { return 'all'; }
    if (!Array.isArray(saved)) { return undefined; }
    const known = new Set(this.scopes().map(s => s.id));
    const ids = saved.filter((id): id is string => typeof id === 'string' && known.has(id));
    // None of those chosen is left: the views follow Source Control again
    return ids.length > 0 ? ids : undefined;
  }

  get mode(): ChoiceMode {
    const choice = this.choice;
    return choice === undefined ? 'scm' : choice === 'all' ? 'all' : 'chosen';
  }

  // undefined: back to following Source Control
  async choose(choice: Choice | undefined): Promise<void> {
    await this.state.update(CHOSEN_PROJECTS_KEY, choice === 'all' ? 'all' : choice && [...choice]);
    this.changed.fire();
  }

  /** Chooses the projects of these repositories, the rows of Source Control Show in Run My Tasks is given */
  async chooseRepositories(roots: readonly vscode.Uri[]): Promise<void> {
    const wanted = new Set(roots.map(uri => uri.toString()));
    const ids = this.scopes()
      .filter(scope => !scope.mixed && scope.folders.some(f => {
        const root = this.scm.repositoryRoot(f);
        return root !== undefined && wanted.has(root);
      }))
      .map(scope => scope.id);
    await this.choose(ids.length > 0 ? ids : undefined);
  }

  // The workspace scope, mixing the projects, is always shown
  isScopeShown(scope: GroupScope): boolean {
    if (scope.mixed || scope.folders.length === 0) { return true; }
    const choice = this.choice;
    if (choice === undefined) { return this.scm.isScopeShown(scope); }
    return choice === 'all' || choice.includes(scope.id);
  }

  isFolderShown(folder: vscode.WorkspaceFolder): boolean {
    if (this.choice === undefined) { return this.scm.isFolderShown(folder); }
    const scope = this.scopes().find(s => !s.mixed && s.folders.some(f => f.uri.toString() === folder.uri.toString()));
    return !scope || this.isScopeShown(scope);
  }

  dispose(): void {
    this.listener.dispose();
    this.changed.dispose();
  }
}

interface ProjectItem extends vscode.QuickPickItem { scope: GroupScope; }

// A project as offered by Choose Projects: a repository, one of its worktrees, or a folder outside git
function projectItem(scope: GroupScope, scopes: readonly GroupScope[]): ProjectItem {
  // The main checkout keeps the id of its repository (see projects.ts)
  const worktree = scope.repo !== undefined && scope.id !== `repo:${scope.repo}`;
  const main = worktree ? scopes.find(s => s.id === `repo:${scope.repo}`) : undefined;
  return {
    label: `$(${worktree ? 'git-branch' : scope.repo ? 'repo' : 'root-folder'}) ${scope.label}`,
    description: worktree ? (main ? `worktree of ${main.label}` : 'worktree') : scope.repo ? undefined : 'outside git',
    scope,
  };
}

export const FOLLOW_SCM_TOOLTIP = 'Follow the repositories selected in Source Control';

/**
 * Choose Projects: the projects of the workspace, those shown ticked. The ones ticked are
 * shown, all of them or none meaning every project; the button in the title goes back to
 * following Source Control. Resolves once the picker is closed.
 */
export function chooseProjects(choice: ProjectChoice, scopes: readonly GroupScope[]): Promise<void> {
  const picker = vscode.window.createQuickPick<ProjectItem>();
  const items = scopes.filter(s => !s.mixed).map(s => projectItem(s, scopes));
  const follow = choice.scm.available && choice.scm.following;
  const followButton: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('source-control'), tooltip: FOLLOW_SCM_TOOLTIP };
  picker.title = 'Projects shown in Run My Tasks';
  picker.placeholder = 'Tick the projects to show';
  picker.canSelectMany = true;
  picker.matchOnDescription = true;
  picker.items = items;
  picker.selectedItems = items.filter(i => choice.isScopeShown(i.scope));
  picker.buttons = follow ? [followButton] : [];

  return new Promise(resolve => {
    let done: Promise<void> = Promise.resolve();
    picker.onDidTriggerButton(button => {
      if (button !== followButton) { return; }
      done = choice.choose(undefined);
      picker.hide();
    });
    picker.onDidAccept(() => {
      const picked = picker.selectedItems;
      done = choice.choose(picked.length === 0 || picked.length === items.length ? 'all' : picked.map(i => i.scope.id));
      picker.hide();
    });
    picker.onDidHide(() => {
      picker.dispose();
      void done.then(resolve);
    });
    picker.show();
  });
}
