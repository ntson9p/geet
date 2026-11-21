/**
 * Interactive Rebase editor host (P5-T2): a `geet.rebaseEditor` webview
 * panel per window. Gathers the linear range, applies the published guard,
 * serves the dialog's RPC, and drives the T1 engine — the panel flips into
 * progress mode (per-step log, Continue/Skip/Abort) once the rebase starts.
 * The host owns all state; the webview survives disposal by re-requesting it.
 */
import * as vscode from 'vscode';
import { notifySuccess } from '../../ui/notify';
import type { Core, RepoHandle } from '../../core/core';
import {
  REBASE_METHODS,
  type RebaseStartParamsDto,
  type RebaseStateDto,
  type RebaseRowDto,
} from '../../shared/protocol';
import { buildWebviewHtml, webviewResourceRoots, WebviewRpcHost } from '../../ui/webviewHost';
import { isPublished } from '../publishedGuard';
import { validatePlan, type RebasePlan } from './planSerializer';
import type { RebaseOntoResult } from './rebaseOnto';
import type { RebaseEngine } from './rebaseEngine';
import type { RebaseStateMonitor } from './stateMonitor';
import { showInfo } from '../../ui/notices';

interface ActiveSession {
  repo: RepoHandle;
  state: RebaseStateDto;
  monitorSubs: Array<{ dispose(): void }>;
  /** Where the rows start when that is not the new base (the Rebase dialog's From). */
  upstream?: string;
}

export class RebaseViewController implements vscode.Disposable {
  static readonly viewType = 'geet.rebaseEditor';
  private panel: vscode.WebviewPanel | undefined;
  private rpc: WebviewRpcHost | undefined;
  private session: ActiveSession | undefined;
  /** Test observability (integration suite). */
  readonly debugTrail: string[] = [];

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly core: Core,
    private readonly engineFor: (repo: RepoHandle) => RebaseEngine | undefined,
    private readonly monitorFor: (repo: RepoHandle) => RebaseStateMonitor | undefined,
  ) {}

  get currentState(): RebaseStateDto | undefined {
    return this.session?.state;
  }

  /** The repository the open rebase belongs to — what `Show in Log` targets. */
  get currentRepoRoot(): string | undefined {
    return this.session?.repo.root;
  }

  /**
   * Opens the dialog anchored at `anchorSha` (range = anchorSha^..HEAD).
   * Multi-select callers pass the *oldest* selected sha.
   */
  async open(repo: RepoHandle, anchorSha: string): Promise<boolean> {
    const engine = this.engineFor(repo);
    if (!engine) return false;

    const base = await this.revParse(repo, `${anchorSha}^`);
    if (base === undefined) {
      void vscode.window.showErrorMessage(
        vscode.l10n.t('Cannot rebase from the root commit — it has no parent to rebase onto.'),
      );
      return false;
    }
    if (await engine.hasMergesInRange(base)) {
      void vscode.window.showErrorMessage(
        vscode.l10n.t(
          'The selected range contains merge commits. Geet cannot rebase merges yet — rebase from a commit after the merge instead.',
        ),
      );
      return false;
    }
    const rows = await this.loadRows(repo, base);
    if (rows.length === 0) {
      showInfo(vscode.l10n.t('Nothing to rebase.'));
      return false;
    }
    await this.openSession(repo, base, rows, undefined);
    return true;
  }

  /**
   * The Rebase dialog's Interactive (POST-P14cw): the editor on the commits
   * `git rebase -i --onto <onto> <from>` would replay, `from..HEAD`, or
   * `onto..HEAD` without From, to be replayed onto `onto`. Shows nothing itself
   * when it cannot open: the dialog reports why, once.
   */
  async openOnto(repo: RepoHandle, onto: string, from?: string): Promise<RebaseOntoResult> {
    const engine = this.engineFor(repo);
    if (!engine) {
      return {
        opened: false,
        severity: 'error',
        message: vscode.l10n.t('Interactive rebase is not available in this repository.'),
      };
    }
    const notARevision = (rev: string): RebaseOntoResult => ({
      opened: false,
      severity: 'error',
      message: vscode.l10n.t('“{0}” is not a revision in this repository.', rev),
    });
    const base = await this.revParse(repo, onto);
    if (base === undefined) return notARevision(onto);
    const fromRef = from?.trim() ?? '';
    const upstream = fromRef.length > 0 ? await this.revParse(repo, fromRef) : base;
    if (upstream === undefined) return notARevision(fromRef);

    if (await engine.hasMergesInRange(upstream)) {
      return {
        opened: false,
        severity: 'error',
        message: vscode.l10n.t(
          'The commits to rebase include merge commits, which Geet cannot rebase interactively yet.',
        ),
      };
    }
    const rows = await this.loadRows(repo, upstream);
    if (rows.length === 0) {
      const branch = repo.model.snapshot.headRef ?? 'HEAD';
      return {
        opened: false,
        severity: 'info',
        message:
          fromRef.length > 0
            ? vscode.l10n.t('Nothing to rebase: {0} has no commits after {1}.', branch, fromRef)
            : vscode.l10n.t('Nothing to rebase: every commit on {0} is already on {1}.', branch, onto),
      };
    }
    await this.openSession(repo, base, rows, upstream === base ? undefined : upstream);
    return { opened: true };
  }

  private async openSession(
    repo: RepoHandle,
    base: string,
    rows: RebaseRowDto[],
    upstream: string | undefined,
  ): Promise<void> {
    const oldest = rows[0];
    const published = oldest !== undefined && (await isPublished(repo, oldest.sha));

    this.disposeSession();
    this.session = {
      repo,
      monitorSubs: [],
      ...(upstream !== undefined ? { upstream } : {}),
      state: {
        repoRoot: repo.root,
        branch: repo.model.snapshot.headRef ?? 'HEAD',
        baseSha: base,
        baseShort: base.slice(0, 7),
        rows,
        published,
        phase: 'edit',
        log: [],
      },
    };
    this.hookMonitor();
    this.showPanel();
    this.pushState();
    this.debugTrail.push(
      `open ${base.slice(0, 7)}${upstream !== undefined ? ` from ${upstream.slice(0, 7)}` : ''} rows=${rows.length} published=${String(published)}`,
    );
  }

  /** The RPC start handler's body — also the integration-test entry. */
  async startRebase(params: RebaseStartParamsDto): Promise<{ ok: boolean; error?: string }> {
    const session = this.session;
    if (!session || session.state.phase !== 'edit') return { ok: false, error: 'no-edit-session' };
    if (session.state.published && !params.forceAcknowledged) {
      return { ok: false, error: 'published-not-acknowledged' };
    }
    const plan: RebasePlan = {
      baseSha: session.state.baseSha,
      ...(session.upstream !== undefined ? { upstreamSha: session.upstream } : {}),
      entries: params.entries.map((e) =>
        e.message === undefined
          ? { sha: e.sha, action: e.action }
          : { sha: e.sha, action: e.action, message: e.message },
      ),
    };
    const issues = validatePlan(plan);
    if (issues.length > 0) return { ok: false, error: issues.join(' ') };

    const engine = this.engineFor(session.repo);
    if (!engine) return { ok: false, error: 'no-engine' };

    session.state.phase = 'running';
    session.state.log = [vscode.l10n.t('Rebasing {0} commits onto {1}…', plan.entries.length, session.state.baseShort)];
    this.pushState();

    const outcome = await engine.start(plan);
    this.applyOutcome(outcome.status, outcome.stderr);
    return { ok: true };
  }

  private async continueRebase(): Promise<void> {
    const engine = this.session ? this.engineFor(this.session.repo) : undefined;
    if (!engine) return;
    const outcome = await engine.continueRebase();
    this.applyOutcome(outcome.status, outcome.stderr);
  }

  private async skip(): Promise<void> {
    const engine = this.session ? this.engineFor(this.session.repo) : undefined;
    if (!engine) return;
    const outcome = await engine.skip();
    this.applyOutcome(outcome.status, outcome.stderr);
  }

  private async abort(): Promise<void> {
    const engine = this.session ? this.engineFor(this.session.repo) : undefined;
    if (!engine || !this.session) return;
    await engine.abort();
    this.session.state.phase = 'done';
    this.session.state.outcome = 'aborted';
    this.session.state.log.push(vscode.l10n.t('Rebase aborted — pre-rebase state restored.'));
    this.pushState();
    notifySuccess(vscode.l10n.t('Abort rebase succeeded'));
  }

  private applyOutcome(
    status: 'completed' | 'paused' | 'refused-merges' | 'failed',
    stderr: string | undefined,
  ): void {
    const session = this.session;
    if (!session) return;
    if (status === 'completed') {
      session.state.phase = 'done';
      session.state.outcome = 'completed';
      session.state.conflicts = [];
      session.state.log.push(vscode.l10n.t('Rebase completed.'));
      notifySuccess(vscode.l10n.t('Rebase successful'));
    } else if (status === 'paused') {
      session.state.phase = 'paused';
      const first = stderr?.split('\n').find((l) => l.trim().length > 0);
      if (first !== undefined) session.state.log.push(first);
    } else {
      session.state.phase = 'done';
      session.state.outcome = status === 'refused-merges' ? 'refused-merges' : 'failed';
      const first = stderr?.split('\n').find((l) => l.trim().length > 0);
      if (first !== undefined) session.state.log.push(first);
    }
    this.pushState();
    this.debugTrail.push(`outcome ${status}`);
  }

  private hookMonitor(): void {
    const session = this.session;
    if (!session) return;
    const monitor = this.monitorFor(session.repo);
    if (!monitor) return;
    session.monitorSubs.push(
      monitor.onDidChangeProgress((e) => {
        const progress: { step?: number; total?: number } = {};
        if (e.step !== undefined) progress.step = e.step;
        if (e.total !== undefined) progress.total = e.total;
        session.state.progress = progress;
        if (e.step !== undefined && e.total !== undefined) {
          session.state.log.push(vscode.l10n.t('Step {0}/{1}', e.step, e.total));
        }
        this.pushState();
      }),
      monitor.onDidPause((e) => {
        session.state.phase = 'paused';
        session.state.conflicts = e.conflictedPaths;
        session.state.log.push(
          vscode.l10n.t('Conflicts in: {0}', e.conflictedPaths.join(', ')),
        );
        this.pushState();
      }),
    );
  }

  private showPanel(): void {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Active);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      RebaseViewController.viewType,
      vscode.l10n.t('Interactive Rebase'),
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        localResourceRoots: webviewResourceRoots(this.context.extensionUri),
      },
    );
    this.panel = panel;
    panel.webview.html = buildWebviewHtml({
      app: 'rebase',
      webview: panel.webview,
      extensionUri: this.context.extensionUri,
      title: vscode.l10n.t('Interactive Rebase'),
    });
    const rpc = new WebviewRpcHost(panel.webview, (l) => this.core.output.appendLine(`[webview] ${l}`));
    this.rpc = rpc;
    rpc.on(REBASE_METHODS.init, () => this.session?.state);
    rpc.on(REBASE_METHODS.start, (params) => this.startRebase(params as RebaseStartParamsDto));
    rpc.on(REBASE_METHODS.cancel, () => {
      // Only the edit phase closes silently; running rebases keep the panel.
      if (this.session?.state.phase === 'edit' || this.session?.state.phase === 'done') {
        this.panel?.dispose();
      }
      return { ok: true };
    });
    rpc.on(REBASE_METHODS.continue, async () => {
      await this.continueRebase();
      return { ok: true };
    });
    rpc.on(REBASE_METHODS.skip, async () => {
      await this.skip();
      return { ok: true };
    });
    rpc.on(REBASE_METHODS.abort, async () => {
      await this.abort();
      return { ok: true };
    });
    panel.onDidChangeViewState((e) => {
      if (e.webviewPanel.visible) {
        rpc.rehydrate();
        this.pushState();
      }
    });
    panel.onDidDispose(() => {
      rpc.dispose();
      this.rpc = undefined;
      this.panel = undefined;
      this.disposeSession();
    });
  }

  private pushState(): void {
    if (this.session) this.rpc?.notify(REBASE_METHODS.evtState, this.session.state);
  }

  /** Context-menu "Reset Action": tell the dialog to set the row to pick. */
  resetRowAction(sha: string): void {
    this.rpc?.notify(REBASE_METHODS.evtResetAction, { sha });
  }

  private async revParse(repo: RepoHandle, rev: string): Promise<string | undefined> {
    const result = await repo.queue.enqueue({
      label: 'rebase editor rev-parse',
      kind: 'read',
      run: (git, token) =>
        git.exec(repo.root, ['rev-parse', '--verify', `${rev}^{commit}`], {
          structured: true,
          noOptionalLocks: true,
          allowNonZeroExit: true,
          token,
        }),
    });
    if (result.exitCode !== 0) return undefined;
    const sha = result.stdout.trim();
    return /^[0-9a-f]{40,64}$/.test(sha) ? sha : undefined;
  }

  /** `base..HEAD` oldest-first with full messages (NUL/RS framed). */
  private async loadRows(repo: RepoHandle, base: string): Promise<RebaseRowDto[]> {
    const result = await repo.queue.enqueue({
      label: 'rebase editor range',
      kind: 'read',
      run: (git, token) =>
        git.exec(
          repo.root,
          [
            'log',
            '--reverse',
            '--format=%H%x00%h%x00%an%x00%at%x00%B%x1e',
            `${base}..HEAD`,
          ],
          { structured: true, noOptionalLocks: true, token },
        ),
    });
    const rows: RebaseRowDto[] = [];
    for (const record of result.stdout.split('\x1e')) {
      const cleaned = record.replace(/^[\n\r]+/, '');
      if (cleaned.trim().length === 0) continue;
      const [sha, shortSha, authorName, at, message] = cleaned.split('\x00');
      if (sha === undefined || shortSha === undefined || message === undefined) continue;
      const fullMessage = message.replace(/\n+$/, '');
      rows.push({
        sha,
        shortSha,
        authorName: authorName ?? '',
        authorTime: Number.parseInt(at ?? '0', 10) || 0,
        subject: fullMessage.split('\n')[0] ?? '',
        message: fullMessage,
        action: 'pick',
      });
    }
    return rows;
  }

  private disposeSession(): void {
    if (this.session) {
      for (const sub of this.session.monitorSubs) sub.dispose();
      this.session = undefined;
    }
  }

  dispose(): void {
    this.disposeSession();
    this.panel?.dispose();
  }
}

/** Oldest of a linear multi-selection = the common ancestor of the set. */
export async function oldestOf(repo: RepoHandle, shas: readonly string[]): Promise<string | undefined> {
  if (shas.length === 0) return undefined;
  const first = shas[0];
  if (shas.length === 1) return first;
  const result = await repo.queue.enqueue({
    label: 'rebase editor oldest-of',
    kind: 'read',
    run: (git, token) =>
      git.exec(repo.root, ['merge-base', ...shas], {
        structured: true,
        noOptionalLocks: true,
        allowNonZeroExit: true,
        token,
      }),
  });
  if (result.exitCode !== 0) return first;
  const sha = result.stdout.trim();
  return /^[0-9a-f]{40,64}$/.test(sha) ? sha : first;
}
