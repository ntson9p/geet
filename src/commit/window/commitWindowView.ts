/**
 * Commit tool window (P11-T2): the webview that replaces the SCM sidebar's
 * commit surface — file tree with folder rows and tri-state inclusion, the
 * message editor, amend, and the action buttons, all in one panel
 * (gap analysis S1, S11, S12, S13; layout in the analysis §2A).
 *
 * Why a webview at all: `TreeItemCheckboxState` has no partial state and a
 * TreeView cannot render folder rows for a flat changelist, so IntelliJ's
 * tick-what-you-commit model is unreachable natively. This reverses the master
 * §6 "webview commit dialog: rejected" decision; the escape hatch is
 * `gittree.commit.window: 'native'`, which restores the P3 surface intact.
 *
 * The host owns all state. The webview renders what it is given and posts
 * intents back; every handler is idempotent so a rehydrate can re-send.
 */
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { Core, RepoHandle } from '../../core/core';
import { isUntracked, shortCode, type StatusEntry } from '../../core/model/statusEntry';
import { canonicalKey } from '../../core/repoDiscovery';
import {
  COMMIT_METHODS,
  type CommitChangeDto,
  type CommitGroupDto,
  type CommitRepoDto,
  type CommitRunParamsDto,
  type CommitSetCheckedParamsDto,
  type CommitStateDto,
} from '../../shared/protocol';
import { buildWebviewHtml, webviewResourceRoots, WebviewRpcHost } from '../../ui/webviewHost';
import { ChangelistService, UNVERSIONED_ID } from '../changelists/changelistService';
import type { CommitService } from '../commitService';
import type { CommitMessageBox } from '../messageBox';
import type { MessageHistory } from '../messageHistory';
import type { ParadigmManager } from '../paradigmManager';

export interface CommitWindowDeps {
  context: vscode.ExtensionContext;
  core: Core;
  changelistsFor(repo: RepoHandle): ChangelistService;
  commitService: CommitService;
  history: MessageHistory;
  paradigm: ParadigmManager;
  /** Runs the shared P3 commit flow — the webview never commits by itself. */
  runCommit(repo: RepoHandle, options: { andPush?: boolean }): Promise<boolean>;
}

const MESSAGE_KEY_PREFIX = 'gittree.commit.message.';

function classify(entry: StatusEntry | undefined): CommitChangeDto['kind'] {
  if (!entry) return 'modified';
  if (entry.kind === 'unmerged') return 'conflicted';
  if (isUntracked(entry)) return 'untracked';
  const code = entry.x !== '.' ? entry.x : entry.y;
  switch (code) {
    case 'A':
      return 'added';
    case 'D':
      return 'deleted';
    case 'R':
    case 'C':
      return 'renamed';
    default:
      return 'modified';
  }
}

export class CommitWindowViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly viewType = 'gittree.commit';

  private view: vscode.WebviewView | undefined;
  private rpc: WebviewRpcHost | undefined;
  private busy = 0;
  private lastError: string | undefined;
  private readonly subs: vscode.Disposable[] = [];
  /** Test observability, mirroring the RebaseViewController convention. */
  readonly debugTrail: string[] = [];

  constructor(private readonly deps: CommitWindowDeps) {
    const { core } = deps;
    const watch = (repo: RepoHandle): void => {
      repo.disposables.add(deps.changelistsFor(repo).onDidChange(() => this.push()));
      repo.disposables.add(repo.model.onDidChange(() => this.push()));
    };
    for (const repo of core.repos) watch(repo);
    this.subs.push(
      core.onDidAddRepo((repo) => {
        watch(repo);
        this.push();
      }),
      core.onDidRemoveRepo(() => this.push()),
      deps.paradigm.onDidChange(() => this.push()),
      deps.commitService.onDidCommit(() => this.push()),
    );
  }

  // ---- message storage ------------------------------------------------------

  private messageKey(repo: RepoHandle): string {
    return `${MESSAGE_KEY_PREFIX}${canonicalKey(repo.root)}`;
  }

  getMessage(repo: RepoHandle): string {
    return this.deps.context.workspaceState.get<string>(this.messageKey(repo)) ?? '';
  }

  private setMessage(repo: RepoHandle, value: string, echo: boolean): void {
    void this.deps.context.workspaceState.update(this.messageKey(repo), value);
    if (echo) this.push();
  }

  /**
   * The message box `commitFlow` and `messageHistory` read through when the
   * commit window owns the message. Programmatic writes (history pick, amend
   * prefill, post-commit clear) echo back to the webview.
   */
  messageBoxFor(repo: RepoHandle): CommitMessageBox {
    const read = (): string => this.getMessage(repo);
    const write = (next: string): void => this.setMessage(repo, next, true);
    return {
      get value(): string {
        return read();
      },
      set value(next: string) {
        write(next);
      },
    };
  }

  // ---- state ----------------------------------------------------------------

  private activeRepo(): RepoHandle | undefined {
    const uri = vscode.window.activeTextEditor?.document.uri;
    return (uri && this.deps.core.repoForUri(uri)) ?? this.deps.core.repos[0];
  }

  private groupsFor(repo: RepoHandle): CommitGroupDto[] {
    const service = this.deps.changelistsFor(repo);
    const change = (relPath: string, checked: boolean): CommitChangeDto => {
      const entry = service.statusEntry(relPath);
      return {
        path: relPath.replace(/\\/g, '/'),
        code: entry ? shortCode(entry) : 'M.',
        kind: classify(entry),
        checked,
        ...(entry?.origPath !== undefined ? { origPath: entry.origPath } : {}),
      };
    };

    const groups: CommitGroupDto[] = service.getLists().map((list) => {
      const checked = new Set(list.checked);
      return {
        id: list.id,
        name: list.name,
        ...(list.comment !== undefined ? { comment: list.comment } : {}),
        isActive: list.isActive,
        isDefault: list.isDefault,
        checkable: true,
        changes: list.files.map((f) => change(f, checked.has(f))),
      };
    });

    const unversioned = service.unversioned();
    if (unversioned.length > 0) {
      groups.push({
        id: UNVERSIONED_ID,
        name: vscode.l10n.t('Unversioned Files'),
        isActive: false,
        isDefault: false,
        // P11-T3 turns this on; until then an inert checkbox would lie.
        checkable: false,
        changes: unversioned.map((f) => change(f, false)),
      });
    }
    return groups;
  }

  buildState(): CommitStateDto {
    const repos: CommitRepoDto[] = this.deps.core.repos.map((repo) => ({
      root: repo.root,
      label: path.basename(repo.root),
      groups: this.groupsFor(repo),
    }));
    const active = this.activeRepo();
    // The tree renders every repository's groups, so the `N of M` counter has
    // to describe everything on screen — not just the repo the message box
    // happens to target.
    const changes = repos.flatMap((r) => r.groups.flatMap((g) => g.changes));
    return {
      repos,
      ...(active !== undefined ? { activeRepo: active.root } : {}),
      message: active ? this.getMessage(active) : '',
      amend: active ? this.deps.commitService.isAmend(active) : false,
      signing: false,
      busy: this.busy > 0,
      modifiedCount: changes.length,
      checkedCount: changes.filter((c) => c.checked).length,
      paradigm: this.deps.paradigm.paradigm,
      ...(this.lastError !== undefined ? { error: this.lastError } : {}),
    };
  }

  push(): void {
    if (!this.view) return;
    this.rpc?.notify(COMMIT_METHODS.evtState, this.buildState());
  }

  private repoFor(root: string): RepoHandle | undefined {
    return this.deps.core.repos.find((r) => canonicalKey(r.root) === canonicalKey(root));
  }

  /** Runs a mutation with the busy flag raised and errors surfaced in-panel. */
  private async guard(label: string, run: () => Promise<void>): Promise<void> {
    this.busy++;
    this.lastError = undefined;
    this.push();
    try {
      await run();
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      this.debugTrail.push(`${label} failed: ${this.lastError}`);
    } finally {
      this.busy--;
      this.push();
    }
  }

  // ---- view -----------------------------------------------------------------

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: webviewResourceRoots(this.deps.context.extensionUri),
    };
    view.webview.html = buildWebviewHtml({
      app: 'commit',
      webview: view.webview,
      extensionUri: this.deps.context.extensionUri,
      title: vscode.l10n.t('Commit'),
    });

    const rpc = new WebviewRpcHost(view.webview, (l) =>
      this.deps.core.output.appendLine(`[commit-window] ${l}`),
    );
    this.rpc = rpc;
    this.wire(rpc);

    view.onDidDispose(() => {
      rpc.dispose();
      this.rpc = undefined;
      this.view = undefined;
    });
    view.onDidChangeVisibility(() => {
      if (view.visible) {
        rpc.rehydrate();
        this.push();
      }
    });
  }

  private wire(rpc: WebviewRpcHost): void {
    rpc.on(COMMIT_METHODS.init, () => this.buildState());
    rpc.on(COMMIT_METHODS.refresh, async () => {
      await vscode.commands.executeCommand('gittree.refresh');
      this.push();
    });

    rpc.on(COMMIT_METHODS.setChecked, (raw) => {
      const p = raw as CommitSetCheckedParamsDto;
      const repo = this.repoFor(p.repoRoot);
      if (!repo) return;
      this.deps.changelistsFor(repo).setChecked(p.paths, p.checked);
      this.push();
    });

    rpc.on(COMMIT_METHODS.setMessage, (raw) => {
      const p = raw as { repoRoot: string; message: string };
      const repo = this.repoFor(p.repoRoot);
      // No echo: the webview already holds this text, and pushing it back
      // while the user types would fight the editor's own undo stack.
      if (repo) this.setMessage(repo, p.message, false);
    });

    rpc.on(COMMIT_METHODS.commit, async (raw) => {
      const p = raw as CommitRunParamsDto;
      const repo = this.repoFor(p.repoRoot);
      if (!repo) return;
      await this.guard('commit', async () => {
        await this.deps.runCommit(repo, { andPush: p.andPush });
      });
    });

    rpc.on(COMMIT_METHODS.toggleAmend, async (raw) => {
      const p = raw as { repoRoot: string };
      const repo = this.repoFor(p.repoRoot);
      if (!repo) return;
      const result = await this.deps.commitService.toggleAmend(repo);
      if (
        result.amend &&
        result.previousMessage !== undefined &&
        this.getMessage(repo).trim().length === 0
      ) {
        this.setMessage(repo, result.previousMessage, false);
      }
      this.push();
    });

    rpc.on(COMMIT_METHODS.openDiff, async (raw) => {
      const p = raw as { repoRoot: string; path: string };
      const repo = this.repoFor(p.repoRoot);
      if (!repo) return;
      await vscode.commands.executeCommand(
        'gittree.openDiff',
        vscode.Uri.file(path.join(repo.root, p.path)),
      );
    });

    rpc.on(COMMIT_METHODS.rollback, async (raw) => {
      const p = raw as { repoRoot: string; paths: string[] };
      const repo = this.repoFor(p.repoRoot);
      if (!repo || p.paths.length === 0) return;
      await this.guard('rollback', async () => {
        for (const rel of p.paths) {
          await vscode.commands.executeCommand(
            'gittree.rollbackFile',
            vscode.Uri.file(path.join(repo.root, rel)),
          );
        }
      });
    });

    rpc.on(COMMIT_METHODS.shelve, async (raw) => {
      const p = raw as { repoRoot: string };
      const repo = this.repoFor(p.repoRoot);
      if (!repo) return;
      await this.guard('shelve', async () => {
        await vscode.commands.executeCommand('gittree.shelve', repo.root);
      });
    });

    rpc.on(COMMIT_METHODS.showHistory, async (raw) => {
      const p = raw as { repoRoot: string };
      const repo = this.repoFor(p.repoRoot);
      if (!repo) return;
      await this.deps.history.showPicker(repo, this.messageBoxFor(repo));
    });

    // P11-T5 replaces this with the in-webview gear popup; until then the
    // existing multi-select QuickPick is the honest surface.
    rpc.on(COMMIT_METHODS.showOptions, async () => {
      await vscode.commands.executeCommand('gittree.commit.configureChecks');
    });
  }

  dispose(): void {
    for (const s of this.subs) s.dispose();
    this.subs.length = 0;
    this.rpc?.dispose();
  }
}
