import * as vscode from 'vscode';
import { GroupScope } from './projects';

// The part of the API of the built-in git extension (vscode.git, API version 1) used here
export interface GitRepository {
  readonly rootUri: vscode.Uri;
  // Selection of the repository in the Repositories view of Source Control
  readonly ui: { readonly selected: boolean; readonly onDidChange: vscode.Event<void> };
}

export interface GitApi {
  readonly repositories: GitRepository[];
  readonly onDidOpenRepository: vscode.Event<GitRepository>;
  readonly onDidCloseRepository: vscode.Event<GitRepository>;
  getRepository(uri: vscode.Uri): GitRepository | null;
}

export interface GitExtension {
  readonly enabled: boolean;
  getAPI(version: 1): GitApi;
}

export const FOLLOW_SCM_SETTING = 'followScmSelection';

/**
 * The repositories selected in the Repositories view of Source Control. In a multi-root
 * workspace the Groups and Tasks views show only the projects of the selected repositories,
 * unless runMyTasks.followScmSelection is off.
 */
export class ScmSelection implements vscode.Disposable {
  private api: GitApi | undefined;
  private readonly repoListeners = new Map<GitRepository, vscode.Disposable>();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;

  // The git extension is looked up by the tests too, which may hand a fake one
  constructor(
    private readonly gitExtension: () => vscode.Extension<GitExtension> | undefined =
      () => vscode.extensions.getExtension<GitExtension>('vscode.git'),
  ) {
    this.disposables.push(
      this.changed,
      vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration(`runMyTasks.${FOLLOW_SCM_SETTING}`)) { this.changed.fire(); }
      }),
    );
    void this.connect();
  }

  // The git extension may be disabled, or git missing: then every project stays visible
  private async connect(): Promise<void> {
    try {
      const extension = this.gitExtension();
      if (!extension) { return; }
      const git = extension.isActive ? extension.exports : await extension.activate();
      if (!git.enabled) { return; }
      this.api = git.getAPI(1);
    } catch {
      return;
    }
    const api = this.api;
    api.repositories.forEach(r => this.watch(r));
    this.disposables.push(
      api.onDidOpenRepository(r => {
        this.watch(r);
        this.changed.fire();
      }),
      api.onDidCloseRepository(r => {
        this.repoListeners.get(r)?.dispose();
        this.repoListeners.delete(r);
        this.changed.fire();
      }),
    );
    this.changed.fire();
  }

  private watch(repo: GitRepository): void {
    if (this.repoListeners.has(repo)) { return; }
    this.repoListeners.set(repo, repo.ui.onDidChange(() => this.changed.fire()));
  }

  private get following(): boolean {
    return vscode.workspace.getConfiguration('runMyTasks').get<boolean>(FOLLOW_SCM_SETTING, true);
  }

  /**
   * Whether the folder is shown: it is outside the repositories git knows, or its repository is
   * selected. With no repository selected at all everything is shown.
   */
  isFolderShown(folder: vscode.WorkspaceFolder): boolean {
    const api = this.api;
    if (!api || !this.following || !api.repositories.some(r => r.ui.selected)) { return true; }
    return api.getRepository(folder.uri)?.ui.selected ?? true;
  }

  // The workspace scope, mixing the projects, is always shown
  isScopeShown(scope: GroupScope): boolean {
    return scope.mixed || scope.folders.length === 0 || scope.folders.some(f => this.isFolderShown(f));
  }

  dispose(): void {
    this.repoListeners.forEach(d => d.dispose());
    this.repoListeners.clear();
    this.disposables.forEach(d => d.dispose());
  }
}
