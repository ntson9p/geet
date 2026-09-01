/**
 * Log tool-window host (P4-T3/T4): WebviewViewProvider for `gittree.log` in
 * the bottom panel. Owns the LogService/GraphLayout session, streams pages to
 * the webview, runs the chip pickers (QuickPicks host-side), opens diffs, and
 * exposes revealCommit/setFilter for blame click-through, file history and
 * the P2 compare upgrade.
 */
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { Core, RepoHandle } from '../core/core';
import { parseDecorations } from '../core/git/parsers/logFormat';
import { canonicalKey } from '../core/repoDiscovery';
import { repoRelative } from '../core/util/paths';
import {
  LOG_METHODS,
  type CommitDetailsDto,
  type CommitFileDto,
  type LogFilterDto,
  type LogInitDto,
  type LogPageDto,
  type LogRootDto,
  type LogRowDto,
  type LogWorktreeActionParamsDto,
} from '../shared/protocol';
import { buildWebviewHtml, webviewResourceRoots, WebviewRpcHost } from '../ui/webviewHost';
import { makeRevUri } from '../core/vdocs/revContentProvider';
import type { DiffEntry } from '../diff/diffSession';
import { statusColorOverrides } from '../ui/statusColors';
import { BranchesPaneBridge } from './branchesPaneBridge';
import { WorktreesPaneBridge } from './worktreesPaneBridge';
import { PALETTE_SIZE } from './graphLayout/colors';
import { GraphLayout } from './graphLayout/layout';
import { intelliSort } from './graphLayout/intelliSort';
import { DEFAULT_FILTER, isUnfiltered, type LogFilter } from './logFilter';
import { LogService, type LogRow } from './logService';
import { buildPathTree, mergeTreeSelection } from './pathTree';

const LANE_WIDTH = 12;

/**
 * Auto-refresh coalescing window. A rebase, a pull or a multi-repo commit
 * moves `refs` once per step, and each re-page is a §13 ≤600 ms read at 100k
 * commits — one per burst is the whole point of the wait. Long enough to
 * swallow a multi-step rewrite, short enough that a single commit still lands
 * in the graph while the user is still looking at it.
 */
const AUTO_REFRESH_DEBOUNCE_MS = 300;

/** Which repository the log is showing, remembered across restarts. */
const ROOT_MEMENTO_KEY = 'gittree.log.root';

interface Session {
  repo: RepoHandle;
  service: LogService;
  filter: LogFilter;
  layout: GraphLayout;
  /** All rows sent so far (replayed on rehydrate). */
  rows: LogRowDto[];
  nextPage: number;
  eof: boolean;
}

export class LogViewProvider implements vscode.WebviewViewProvider {
  static readonly viewId = 'gittree.log';
  private view: vscode.WebviewView | undefined;
  private rpc: WebviewRpcHost | undefined;
  private session: Session | undefined;
  private readonly services = new Map<string, LogService>();
  /** P12-T1: the host-side selection model (`log/select`). */
  private selected: string[] = [];
  /** P12-T2: refs data + shared-registry dispatch for the Branches pane. */
  readonly branchesBridge: BranchesPaneBridge;
  /** POST-P14k: the Worktrees tab's list + `gittree.worktree.*` dispatch. */
  readonly worktreesBridge: WorktreesPaneBridge;
  private refsSub: vscode.Disposable | undefined;
  /** Keeps `Paths ▾ · Roots` current as folders join and leave the workspace. */
  private rootsSub: vscode.Disposable | undefined;
  /** P12-T8: throttled Console change ping. */
  private consoleSub: vscode.Disposable | undefined;
  /** POST-P14k: per-repo ref watches behind the Worktrees tab's refresh ping. */
  private worktreesSub: vscode.Disposable | undefined;
  /** Boot breadcrumbs (integration-test observability). */
  readonly debugTrail: string[] = [];
  /**
   * P14-T7: the Changed Files pane's current contents, which double as the
   * diff *sequence* — clicking a file opens it as position i of N so "next
   * change" can leave it for the next file instead of wrapping to its top.
   */
  private lastChangedFiles: CommitFileDto[] = [];
  /** Auto-refresh: coalescing timer, and the deferral for a hidden panel. */
  private autoRefreshTimer: NodeJS.Timeout | undefined;
  private autoRefreshPending = false;
  /**
   * The HEAD the current rows were paged at. `sections.has('head')` is too
   * coarse to gate on — it also fires for ahead/behind and lastFetchAt, which
   * change nothing the graph draws — so the sha is compared directly.
   */
  private lastHeadSha: string | undefined;
  /** Auto-refreshes actually executed (integration-test observability). */
  autoRefreshCount = 0;

  /** Multi-select in webview order — what commit actions operate on. */
  get selectedCommits(): readonly string[] {
    return this.selected;
  }

  /** Test seam: whether the host answers this webview→host method (P11-T3 pattern). */
  hasHandler(method: string): boolean {
    return this.rpc?.hasHandler(method) ?? false;
  }

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly core: Core,
  ) {
    this.branchesBridge = new BranchesPaneBridge(core);
    this.worktreesBridge = new WorktreesPaneBridge(core, (command, ...args) =>
      vscode.commands.executeCommand(command, ...args),
    );
  }

  private serviceFor(repo: RepoHandle): LogService {
    const key = canonicalKey(repo.root);
    let s = this.services.get(key);
    if (!s) {
      s = new LogService(repo, this.context.workspaceState, (l) => this.core.output.appendLine(`[log] ${l}`));
      this.services.set(key, s);
      repo.disposables.add({ dispose: () => this.services.delete(key) });
    }
    return s;
  }

  /**
   * The repository the log shows.
   *
   * It used to be re-derived from the focused editor on *every* re-init, and
   * `startSession` runs on every filter change, refresh and rehydrate — so
   * changing a filter while a file from another repository happened to be
   * focused silently moved the log to that repository and re-ran the filter
   * there. A `paths` filter is repo-relative and a `refs` filter names that
   * repository's branches, so the move either emptied the log or failed the
   * page read outright. The reference has no equivalent: it shows every root
   * at once and never has to guess.
   *
   * So the choice is made once and then held: the focused editor seeds it the
   * first time, and after that only an explicit act moves it — picking a row
   * under `Paths ▾ · Roots`, or a command that names its repository
   * (`revealCommit`, `showFileHistory`, `compareInLog`). The choice survives a
   * restart, which is why it is a memento and not a field.
   */
  private activeRepo(): RepoHandle | undefined {
    const pinned = this.pinnedRoot();
    if (pinned) return pinned;
    const uri = vscode.window.activeTextEditor?.document.uri;
    return (uri && this.core.repoForUri(uri)) ?? this.session?.repo ?? this.core.repos[0];
  }

  /** The remembered repository, or undefined once it leaves the workspace. */
  private pinnedRoot(): RepoHandle | undefined {
    const key = this.context.workspaceState.get<string>(ROOT_MEMENTO_KEY);
    if (key === undefined) return undefined;
    const repo = this.core.getRepo(key);
    if (repo) return repo;
    void this.context.workspaceState.update(ROOT_MEMENTO_KEY, undefined);
    return undefined;
  }

  private pinRoot(root: string): void {
    void this.context.workspaceState.update(ROOT_MEMENTO_KEY, canonicalKey(root));
  }

  /**
   * The `Roots` section: every repository the workspace has. Two repositories
   * can share a basename (`web/api` and `mobile/api`), which would render as
   * two identical rows, so a colliding label grows its parent directory.
   */
  private roots(): LogRootDto[] {
    const repos = [...this.core.repos].sort((a, b) => a.root.localeCompare(b.root));
    const basenames = new Map<string, number>();
    for (const repo of repos) {
      const base = path.basename(repo.root);
      basenames.set(base, (basenames.get(base) ?? 0) + 1);
    }
    return repos.map((repo, idx) => {
      const base = path.basename(repo.root);
      const label =
        (basenames.get(base) ?? 0) > 1
          ? `${path.basename(path.dirname(repo.root))}/${base}`
          : base;
      return { root: repo.root, label, colorIdx: idx % PALETTE_SIZE };
    });
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.debugTrail.push('resolveWebviewView');
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: webviewResourceRoots(this.context.extensionUri),
    };
    view.webview.html = buildWebviewHtml({
      app: 'log',
      webview: view.webview,
      extensionUri: this.context.extensionUri,
      title: vscode.l10n.t('Git Log'),
    });
    // The one allowed retainContextWhenHidden instance is configured via the
    // package.json view options; still rehydrate on visibility for safety.
    view.onDidChangeVisibility(() => {
      if (!view.visible) return;
      this.rpc?.rehydrate();
      // History that moved while the panel was closed is caught up here, so a
      // hidden log costs no git at all — the whole point of the deferral.
      if (this.autoRefreshPending) this.runAutoRefresh();
    });

    const rpc = new WebviewRpcHost(view.webview, (l) => this.core.output.appendLine(`[webview] ${l}`));
    this.rpc = rpc;

    rpc.on(LOG_METHODS.init, (params) => {
      this.debugTrail.push('rpc:init');
      const requested = (params as { filter?: LogFilterDto } | undefined)?.filter;
      return this.startSession(requested ?? this.session?.filter ?? DEFAULT_FILTER);
    });
    rpc.on(LOG_METHODS.page, async (params) => {
      const { page } = params as { page: number };
      this.debugTrail.push(`rpc:page ${page}`);
      await this.sendPage(page);
      return { ok: true };
    });
    rpc.on(LOG_METHODS.details, async (params) => {
      const { sha } = params as { sha: string };
      return this.getDetails(sha);
    });
    rpc.on(LOG_METHODS.setFilter, (params) => {
      const { filter } = params as { filter: LogFilterDto };
      this.applyFilter(filter);
      return { ok: true };
    });
    rpc.on(LOG_METHODS.pickAuthors, () => this.pickAuthors());
    rpc.on(LOG_METHODS.pickDates, () => this.pickDates());
    rpc.on(LOG_METHODS.pickPaths, () => this.pickPaths());
    rpc.on(LOG_METHODS.pickPathsInTree, () => this.pickPathsInTree());
    rpc.on(LOG_METHODS.setRoot, (params) => {
      const { root } = params as { root: string };
      return { ok: typeof root === 'string' && this.showRoot(root) };
    });
    rpc.on(LOG_METHODS.openFileDiff, async (params) => {
      const { sha, file, base } = params as { sha: string; file: CommitFileDto; base?: string };
      await this.openFileDiff(sha, file, base);
      return { ok: true };
    });
    rpc.on(LOG_METHODS.openAllDiffs, async (params) => {
      const { sha } = params as { sha: string };
      await this.openAllDiffs(sha);
      return { ok: true };
    });
    rpc.on(LOG_METHODS.copy, async (params) => {
      const { text } = params as { text: string };
      await vscode.env.clipboard.writeText(text);
      return { ok: true };
    });
    // P12-T1: the selection lives host-side so "Compare", "Squash", "Push all
    // up to here" and the panes all read one model instead of racing copies.
    rpc.on(LOG_METHODS.select, (params) => {
      const { shas } = params as { shas: string[] };
      this.selected = Array.isArray(shas) ? shas.filter((s) => typeof s === 'string') : [];
      return { ok: true };
    });
    // P12-T3: the Changed Files pane — one commit's files, or the aggregate
    // change set of a multi-selection (how "Compare Versions" reads).
    rpc.on(LOG_METHODS.changedFiles, async (params) => {
      const { shas } = params as { shas: string[] };
      const session = this.session;
      if (!session || !Array.isArray(shas) || shas.length === 0) return { files: [] };
      if (shas.length === 1) {
        const details = await session.service.getCommitDetails(shas[0]!);
        const files =
          details?.files.map((f) => ({
            status: f.status,
            path: f.path,
            ...(f.origPath !== undefined ? { origPath: f.origPath } : {}),
          })) ?? [];
        // P14-T7: the pane's contents are the diff sequence.
        this.lastChangedFiles = files;
        return { files, newest: shas[0]! };
      }
      // Selection order is click order; the range is graph order.
      const order = new Map(session.rows.map((r, i) => [r.sha, i] as const));
      const sorted = [...shas].sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
      const newest = sorted[0]!;
      const oldest = sorted[sorted.length - 1]!;
      const aggregate = await session.service.getAggregateFiles(oldest, newest);
      this.lastChangedFiles = aggregate.files;
      return { files: aggregate.files, newest, base: aggregate.base };
    });

    // P12-T8: the Console tab — a delta read over the redacted command ring,
    // with a throttled change ping so bursts (a status refresh runs many
    // gits) cost one repaint, not one per command.
    rpc.on(LOG_METHODS.consoleEntries, (params) => {
      const { afterSeq } = params as { afterSeq?: number };
      return {
        entries:
          afterSeq !== undefined
            ? this.core.commandLog.entriesAfter(afterSeq)
            : [...this.core.commandLog.entries()],
      };
    });
    rpc.on(LOG_METHODS.consoleClear, () => {
      this.core.commandLog.clear();
      return { ok: true };
    });
    this.consoleSub?.dispose();
    let consolePing: NodeJS.Timeout | undefined;
    const cmdSub = this.core.commandLog.onDidChange(() => {
      if (consolePing !== undefined) return;
      consolePing = setTimeout(() => {
        consolePing = undefined;
        this.rpc?.notify(LOG_METHODS.evtConsole, {});
      }, 200);
    });
    this.consoleSub = new vscode.Disposable(() => {
      cmdSub.dispose();
      if (consolePing !== undefined) clearTimeout(consolePing);
    });

    // P12-T4: lazy on purpose — `branch --contains` walks history and would
    // cost a traversal per selection; it runs only when the link is clicked.
    rpc.on(LOG_METHODS.containedBranches, async (params) => {
      const { sha } = params as { sha: string };
      const session = this.session;
      if (!session) return { branches: [] };
      return { branches: await session.service.getContainingBranches(sha) };
    });

    rpc.on(LOG_METHODS.goTo, async (params) => {
      const { sha } = params as { sha: string };
      await this.revealCommit(sha);
      return { ok: true };
    });

    // P12-T5: the rewritten filter row's data + toolbar actions.
    rpc.on(LOG_METHODS.authors, async () => {
      const session = this.session;
      if (!session) return { authors: [] };
      return { authors: await session.service.getAuthors() };
    });

    rpc.on(LOG_METHODS.refresh, () => {
      this.refresh();
      return { ok: true };
    });

    rpc.on(LOG_METHODS.goToRef, async (params) => {
      const { ref } = params as { ref?: string };
      const session = this.session;
      if (!session) return { ok: false };
      const target =
        ref !== undefined && ref.trim().length > 0
          ? ref.trim()
          : await vscode.window.showInputBox({
              prompt: vscode.l10n.t('Go to hash, branch or tag'),
              ignoreFocusOut: true,
            });
      if (target === undefined || target.length === 0) return { ok: false };
      const resolved = await session.repo.queue.enqueue({
        label: `resolve ${target}`,
        kind: 'read',
        run: (git, token) =>
          git.exec(session.repo.root, ['rev-parse', '--verify', `${target}^{commit}`], {
            structured: true,
            noOptionalLocks: true,
            allowNonZeroExit: true,
            token,
          }),
      });
      if (resolved.exitCode !== 0) {
        void vscode.window.showWarningMessage(
          vscode.l10n.t('"{0}" is not a commit, branch or tag here.', target),
        );
        return { ok: false };
      }
      // `ok` is whether the commit is now on screen, not merely whether the
      // ref parsed. Reporting the parse as success is what let this box tell
      // the user their ref was real and then show them nothing.
      return { ok: await this.revealCommit(resolved.stdout.trim()) };
    });

    rpc.on(LOG_METHODS.savePreset, async (params) => {
      const { filter, name } = params as { filter: LogFilterDto; name?: string };
      const chosen =
        name ??
        (await vscode.window.showInputBox({
          prompt: vscode.l10n.t('Preset name'),
          ignoreFocusOut: true,
        }));
      if (chosen === undefined || chosen.trim().length === 0) return { ok: false };
      const config = vscode.workspace.getConfiguration('gittree.log');
      const presets = [
        ...(config.get<Array<{ name: string; filter: LogFilterDto }>>('filterPresets') ?? []).filter(
          (p) => p.name !== chosen.trim(),
        ),
        { name: chosen.trim(), filter },
      ];
      await config.update('filterPresets', presets, vscode.ConfigurationTarget.Workspace);
      return { ok: true };
    });

    rpc.on(LOG_METHODS.deletePreset, async (params) => {
      const { name } = params as { name: string };
      const config = vscode.workspace.getConfiguration('gittree.log');
      const presets = (
        config.get<Array<{ name: string; filter: LogFilterDto }>>('filterPresets') ?? []
      ).filter((p) => p.name !== name);
      await config.update('filterPresets', presets, vscode.ConfigurationTarget.Workspace);
      return { ok: true };
    });

    rpc.on(LOG_METHODS.showFileHistory, async (params) => {
      const { path: relPath } = params as { path: string };
      const session = this.session;
      if (!session || typeof relPath !== 'string') return { ok: false };
      await vscode.commands.executeCommand(
        'gittree.showFileHistory',
        vscode.Uri.file(path.join(session.repo.root, relPath)),
      );
      return { ok: true };
    });

    // P12-T2: the Branches pane.
    rpc.on(LOG_METHODS.branches, async () => {
      const repo = this.session?.repo ?? this.activeRepo();
      if (!repo) return { detached: false, locals: [], remotes: [], tags: [] };
      return this.branchesBridge.buildBranches(repo);
    });
    rpc.on(LOG_METHODS.worktrees, () => this.worktreesBridge.buildState());
    rpc.on(LOG_METHODS.worktreeAction, async (params) => {
      await this.worktreesBridge.dispatch(params as LogWorktreeActionParamsDto);
      // The command may have created or removed one; the pane re-reads rather
      // than guessing what changed.
      this.rpc?.notify(LOG_METHODS.evtWorktrees, {});
      return { ok: true };
    });
    rpc.on(LOG_METHODS.branchAction, async (params) => {
      const repo = this.session?.repo ?? this.activeRepo();
      if (!repo) return { ok: false };
      await this.branchesBridge.dispatch(
        repo,
        params as { action: string; name?: string; type?: 'local' | 'remote' | 'tag' },
      );
      return { ok: true };
    });

    // A repository joining or leaving the workspace changes the `Roots` list
    // and nothing else, so it is pushed on its own — `evtReset` would restart
    // paging and drop the selection over a list of repository names.
    this.rootsSub?.dispose();
    const notifyRoots = (): void => this.rpc?.notify(LOG_METHODS.evtRoots, { roots: this.roots() });
    const addSub = this.core.onDidAddRepo(notifyRoots);
    const removeSub = this.core.onDidRemoveRepo(notifyRoots);
    this.rootsSub = new vscode.Disposable(() => {
      addSub.dispose();
      removeSub.dispose();
    });

    // POST-P14k: the Worktrees tab lists every repository, so its ping cannot
    // hang off the session's single repo the way the Branches pane's does.
    // `refs` is the cheap proxy the tree view already used: adding, removing
    // or pruning a worktree moves a ref in the repo that owns it.
    this.worktreesSub?.dispose();
    const notifyWorktrees = (): void => this.rpc?.notify(LOG_METHODS.evtWorktrees, {});
    const worktreeSubs: vscode.Disposable[] = [];
    const watchRepo = (repo: RepoHandle): void => {
      worktreeSubs.push(
        repo.model.onDidChange((sections) => {
          if (sections.has('refs')) notifyWorktrees();
        }),
      );
    };
    for (const repo of this.core.repos) watchRepo(repo);
    const wtAddSub = this.core.onDidAddRepo((repo) => {
      watchRepo(repo);
      notifyWorktrees();
    });
    const wtRemoveSub = this.core.onDidRemoveRepo(notifyWorktrees);
    this.worktreesSub = new vscode.Disposable(() => {
      for (const sub of worktreeSubs) sub.dispose();
      worktreeSubs.length = 0;
      wtAddSub.dispose();
      wtRemoveSub.dispose();
    });

    view.onDidDispose(() => {
      rpc.dispose();
      this.rpc = undefined;
      this.view = undefined;
      this.refsSub?.dispose();
      this.refsSub = undefined;
      this.rootsSub?.dispose();
      this.rootsSub = undefined;
      this.consoleSub?.dispose();
      this.consoleSub = undefined;
      this.worktreesSub?.dispose();
      this.worktreesSub = undefined;
      if (this.autoRefreshTimer !== undefined) {
        clearTimeout(this.autoRefreshTimer);
        this.autoRefreshTimer = undefined;
      }
    });
  }

  // ---- session -------------------------------------------------------------

  private graphPalette(): 'default' | 'colorBlind' {
    const v = vscode.workspace.getConfiguration('gittree.log').get<string>('graphPalette', 'default');
    return v === 'colorBlind' ? 'colorBlind' : 'default';
  }

  /** P12-T4: issue-key linkification config for the details body. */
  private issueConfig(): { pattern: string; url: string } | undefined {
    const config = vscode.workspace.getConfiguration('gittree.log');
    const pattern = config.get<string>('issuePattern', '').trim();
    const url = config.get<string>('issueUrl', '').trim();
    if (pattern.length === 0 || url.length === 0) return undefined;
    try {
      new RegExp(pattern, 'g');
    } catch {
      return undefined; // an invalid pattern must not break the whole view
    }
    return { pattern, url };
  }

  /** P10-T2: keyboard parity — move focus into the filter search box. */
  focusFilter(): void {
    this.rpc?.notify(LOG_METHODS.evtFocusFilter, {});
  }

  /**
   * @param repoRoot the repository to show. Naming one is the *explicit act*
   * that moves the log; omitting it keeps whatever the log is already showing.
   */
  private startSession(filterDto: LogFilterDto, repoRoot?: string): LogInitDto {
    const named = repoRoot !== undefined ? this.core.getRepo(repoRoot) : undefined;
    const repo = named ?? this.activeRepo();
    if (!repo) {
      if (this.view) this.view.description = undefined;
      return {
        repoRoot: '',
        repoLabel: vscode.l10n.t('No repository'),
        roots: [],
        filter: filterDto,
        laneWidth: LANE_WIDTH,
        graphPalette: this.graphPalette(),
        colors: statusColorOverrides(),
      };
    }
    // Seeded from the focused editor the first time, held from then on.
    this.pinRoot(repo.root);
    if (this.view) this.view.description = path.basename(repo.root);
    this.debugTrail.push(`session repo=${repo.root}`);
    this.session = {
      repo,
      service: this.serviceFor(repo),
      filter: filterDto,
      layout: new GraphLayout(),
      rows: [],
      nextPage: 0,
      eof: false,
    };
    void this.session.service.maybeMaintain();
    // P12-T2: refs move (branch created, favorite toggled, checkout…) → the
    // Branches pane re-requests. The event carries no payload on purpose: the
    // webview's own request dedups bursts naturally.
    this.refsSub?.dispose();
    const notifyRefs = (): void => this.rpc?.notify(LOG_METHODS.evtBranches, {});
    this.lastHeadSha = repo.model.snapshot.headSha;
    const modelSub = repo.model.onDidChange((sections) => {
      notifyRefs();
      // Only history moving re-pages the graph. `status` fires on every save
      // and every stage — re-paging on it would cost a `git log` per keypress
      // in a watched file. `refs` covers heads/remotes/tags, so it catches any
      // commit that moved a branch; the sha comparison catches the rest, which
      // is a commit on a detached HEAD (only HEAD moves, no ref does).
      const headMoved = repo.model.snapshot.headSha !== this.lastHeadSha;
      if (!sections.has('refs') && !headMoved) return;
      this.lastHeadSha = repo.model.snapshot.headSha;
      this.scheduleAutoRefresh();
    });
    const favSub = this.branchesBridge.refServiceFor(repo)?.onDidChangeFavorites(notifyRefs);
    this.refsSub = new vscode.Disposable(() => {
      modelSub.dispose();
      favSub?.dispose();
    });
    return {
      repoRoot: repo.root,
      repoLabel: path.basename(repo.root),
      roots: this.roots(),
      filter: filterDto,
      laneWidth: LANE_WIDTH,
      graphPalette: this.graphPalette(),
      colors: statusColorOverrides(),
      ...(this.issueConfig() !== undefined ? { issue: this.issueConfig() } : {}),
      presets: vscode.workspace.getConfiguration('gittree.log').get('filterPresets') ?? [],
    };
  }

  /** Test seam (P12-T3): the per-repo LogService the session pages through. */
  logServiceFor(repo: RepoHandle): LogService {
    return this.serviceFor(repo);
  }

  /** P12-T7 Go to Child: the nearest LOADED row listing `sha` as a parent. */
  findLoadedChild(sha: string): string | undefined {
    const rows = this.session?.rows ?? [];
    for (let i = rows.length - 1; i >= 0; i--) {
      // Newest-first rows: walk from the bottom up so the NEAREST child (the
      // last one above the commit) wins over distant descendants.
      const row = rows[i]!;
      if (row.parents.includes(sha)) return row.sha;
    }
    return undefined;
  }

  private toDto(row: LogRow, session: Session): LogRowDto {
    const graphRows = session.layout.appendPage([{ sha: row.sha, parents: row.parents }]);
    const graph = graphRows[0]!;
    const { headTarget, decorations } = parseDecorations(row.refs);
    return {
      sha: row.sha,
      subject: row.subject,
      authorName: row.authorName,
      authorTime: row.authorTime,
      parents: row.parents,
      refs: decorations.map((d) => ({
        name: d.name,
        type: d.type,
        ...(d.name === headTarget ? { isHeadTarget: true } : {}),
      })),
      ...(row.side !== undefined ? { side: row.side } : {}),
      graph: {
        nodeLane: graph.nodeLane,
        colorIdx: graph.colorIdx,
        lanesBefore: graph.lanesBefore,
        joins: graph.joins,
        forks: graph.forks,
        continues: graph.continues,
      },
    };
  }

  private async sendPage(page: number): Promise<void> {
    const session = this.session;
    if (!session || !this.rpc) return;
    if (page < session.nextPage) {
      // Rehydrate replay: resend everything we already have as page 0-style.
      this.rpc.notify(LOG_METHODS.evtRows, {
        page: 0,
        rows: session.rows,
        eof: session.eof,
      } satisfies LogPageDto);
      return;
    }
    let result;
    try {
      result = await session.service.getPage(session.filter, page);
    } catch (err) {
      this.debugTrail.push(`page ${page} failed: ${String(err)}`);
      throw err;
    }
    // The session can be replaced while this read is in flight, and now that
    // history moving re-pages on its own that is the common case, not a rare
    // one: the OperationQueue CANCELS AND REQUEUES in-flight readers when a
    // mutation arrives, so a page read started before a commit resolves after
    // it — after the auto-refresh has already built the next session. Landing
    // these rows would grow a dead row store, advance a dead layout, and (the
    // visible harm) arrive at the webview as another `page: 0`, which it
    // treats as a replacement — overwriting the fresh page with the stale one.
    if (this.session !== session) {
      this.debugTrail.push(`page ${page} dropped (stale session)`);
      return;
    }
    const ordered = session.filter.sort === 'intelli' ? intelliSort(result.rows) : result.rows;
    const dtoRows = ordered.map((r) => this.toDto(r, session));
    this.debugTrail.push(`page ${page} sent ${dtoRows.length}`);
    session.rows.push(...dtoRows);
    session.nextPage = page + 1;
    session.eof = result.eof;
    this.rpc.notify(LOG_METHODS.evtRows, {
      page,
      rows: dtoRows,
      eof: result.eof,
    } satisfies LogPageDto);
  }

  private applyFilter(
    filterDto: LogFilterDto,
    repoRoot?: string,
    opts?: { preserve?: boolean },
  ): void {
    const init = this.startSession(filterDto, repoRoot);
    this.rpc?.notify(LOG_METHODS.evtReset, {
      ...init,
      ...(opts?.preserve === true ? { preserve: true } : {}),
    } satisfies LogInitDto);
  }

  /** P10-T2: re-init with the current filter (palette/config changes). */
  refreshInit(): void {
    const session = this.session;
    if (session) this.applyFilter(session.filter);
  }

  private async getDetails(sha: string): Promise<CommitDetailsDto | undefined> {
    const session = this.session;
    if (!session) return undefined;
    const details = await session.service.getCommitDetails(sha);
    if (!details) return undefined;
    return {
      ...details,
      files: details.files.map((f) => ({
        status: f.status,
        path: f.path,
        ...(f.origPath !== undefined ? { origPath: f.origPath } : {}),
      })),
    };
  }

  // ---- public API (blame, file history, compare upgrade) --------------------

  /** @returns whether the commit ended up selected in the graph. */
  async revealCommit(sha: string, repoRoot?: string): Promise<boolean> {
    await vscode.commands.executeCommand('gittree.log.focus');
    // Wait for the view to resolve (first open).
    for (let i = 0; i < 50 && !this.rpc; i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    const session = this.session;
    if (!session || !this.rpc) return false;
    if (repoRoot !== undefined && canonicalKey(repoRoot) !== canonicalKey(session.repo.root)) {
      // The re-init used to drop `repoRoot` on the floor and re-resolve from the
      // focused editor, so "show this commit" landed in whatever repository the
      // editor was in and then paged 25 times looking for a sha that was never
      // going to be there. The caller named a repository; honour it.
      //
      // Only the sort survives the move. Reveal within one repository respects
      // that repository's filter, but there is no filter for a repository the
      // log has not been showing — and carrying another one's author or text
      // query over would routinely hide the very commit that was asked for.
      this.applyFilter({ sort: session.filter.sort, refs: 'ALL' }, repoRoot);
    }
    if (await this.pageUntilLoaded(sha)) {
      this.rpc.notify(LOG_METHODS.evtReveal, { sha });
      return true;
    }
    // The reveal used to fire `evtReveal` here regardless, and the webview
    // answers a sha it cannot find with `if (idx !== -1)` and no else — so a
    // miss was discarded at the far end of the RPC, where nothing could report
    // it. Six gestures land here (blame's Show in Log and its status bar, Go
    // to Parent, Go to Child, Go to Hash/Branch/Tag, the rebase row action)
    // and every one of them did nothing at all, silently, whenever the commit
    // was outside the *filter* — which is not exotic: the default filter is
    // `refs: 'HEAD'`, so any commit on an unmerged branch qualifies, and under
    // `Show File History` every parent that did not touch the file does too.
    this.debugTrail.push(`reveal ${sha.slice(0, 7)} not in view`);
    this.reportRevealMiss(sha);
    return false;
  }

  /** Pages forward until `sha` is loaded. Bounded; true when it landed. */
  private async pageUntilLoaded(sha: string): Promise<boolean> {
    let guard = 0;
    while (!this.session!.rows.some((r) => r.sha === sha) && !this.session!.eof && guard < 25) {
      await this.sendPage(this.session!.nextPage);
      guard++;
    }
    return this.session!.rows.some((r) => r.sha === sha);
  }

  /**
   * Says why nothing happened, and offers the one thing that would fix it.
   *
   * Deliberately not awaited: the caller's job is done either way, and a
   * command that blocks on a notification the user may never click would hang
   * `Go to Parent` on a keypress. The retry runs on its own.
   */
  private reportRevealMiss(sha: string): void {
    const short = sha.slice(0, 7);
    const session = this.session;
    if (session === undefined || isUnfiltered(session.filter)) {
      // Nothing left to widen: the view already shows every ref, so the commit
      // is genuinely unreachable — a dangling sha from before an amend or a
      // reset, which is exactly what a stale blame annotation hands over.
      void vscode.window.showWarningMessage(
        vscode.l10n.t('{0} is not reachable from any branch or tag here.', short),
      );
      return;
    }
    const widen = vscode.l10n.t('Show All Branches');
    void vscode.window
      .showWarningMessage(
        vscode.l10n.t("{0} is not in the log's current filter.", short),
        widen,
      )
      .then(async (picked) => {
        if (picked !== widen) return;
        // The notification outlives the view: a click after the panel closed
        // would page into a dead rpc and then blame the repository for it.
        if (!this.rpc) return;
        // Only the sort survives, on the same rule the cross-repository move
        // above follows: an author or path query written for another view
        // would routinely hide the very commit that was just asked for.
        this.applyFilter({ sort: session.filter.sort, refs: 'ALL' });
        if (await this.pageUntilLoaded(sha)) {
          this.rpc?.notify(LOG_METHODS.evtReveal, { sha });
        } else {
          void vscode.window.showWarningMessage(
            vscode.l10n.t('{0} is not reachable from any branch or tag here.', short),
          );
        }
      });
  }

  /**
   * @param repoRoot the repository the filter is written for. `paths` are
   * repo-relative and `refs` name one repository's branches, so a caller that
   * built either MUST say where — `showFileHistory` and `compareInLog` both
   * used to omit it and have their filter land in the focused editor's
   * repository instead.
   */
  async setFilter(filter: LogFilter, repoRoot?: string): Promise<void> {
    await vscode.commands.executeCommand('gittree.log.focus');
    for (let i = 0; i < 50 && !this.rpc; i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    this.applyFilter(filter, repoRoot);
  }

  /** `Paths ▾ · Roots` — show a different workspace repository. */
  showRoot(repoRoot: string): boolean {
    const target = this.core.getRepo(repoRoot);
    if (!target) return false;
    const current = this.session?.repo.root;
    if (current !== undefined && canonicalKey(current) === canonicalKey(target.root)) return true;
    this.applyFilter(rootAgnostic(this.session?.filter ?? DEFAULT_FILTER), target.root);
    return true;
  }

  /**
   * @param opts.preserve the reset was raised by the host because history
   * moved, not asked for by the user — the webview keeps its place across it.
   */
  refresh(opts?: { preserve?: boolean }): void {
    const session = this.session;
    if (!session) return;
    // The page cache is keyed on `headSha` alone, so a ref that moved without
    // HEAD moving (a fetch, a branch or tag created elsewhere) would be served
    // from cache with its old decorations. Dropping it is what makes a refresh
    // mean "re-read", and it is why auto-refresh fixes the chips too.
    session.service.invalidate();
    this.applyFilter(session.filter, undefined, opts);
  }

  /**
   * History moved: re-page once the burst settles. Nothing runs while the
   * panel is hidden — the flag is flushed when it next becomes visible.
   */
  private scheduleAutoRefresh(): void {
    if (this.autoRefreshTimer !== undefined) clearTimeout(this.autoRefreshTimer);
    this.autoRefreshTimer = setTimeout(() => {
      this.autoRefreshTimer = undefined;
      this.runAutoRefresh();
    }, AUTO_REFRESH_DEBOUNCE_MS);
    this.autoRefreshTimer.unref?.();
  }

  private runAutoRefresh(): void {
    // Reachable from the timer AND from the visibility flush; whichever gets
    // here first cancels the other so a burst never costs two reads.
    if (this.autoRefreshTimer !== undefined) {
      clearTimeout(this.autoRefreshTimer);
      this.autoRefreshTimer = undefined;
    }
    if (this.view?.visible !== true) {
      this.autoRefreshPending = true;
      return;
    }
    this.autoRefreshPending = false;
    // No session yet means the webview has not sent `init`; the session it is
    // about to build reads current history anyway, so there is nothing to do.
    if (!this.session) return;
    this.autoRefreshCount++;
    this.debugTrail.push('auto-refresh');
    this.refresh({ preserve: true });
  }

  get currentSession():
    | { repoRoot: string; filter: LogFilter; rowCount: number; roots: LogRootDto[] }
    | undefined {
    return this.session
      ? {
          repoRoot: this.session.repo.root,
          filter: this.session.filter,
          rowCount: this.session.rows.length,
          roots: this.roots(),
        }
      : undefined;
  }

  // ---- pickers (host-side QuickPicks/InputBoxes) ----------------------------
  // P12-T5 replaced the branch chip with the in-webview `Branch ▾` dropdown,
  // which owns both presets (`HEAD (Current)`, `All branches`); the QuickPick
  // that used to back it had no callers left and is gone.

  private async pickAuthors(): Promise<{ ok: boolean }> {
    const session = this.session;
    if (!session) return { ok: false };
    const authors = await session.service.getAuthors();
    const me = await session.repo.queue.enqueue({
      label: 'read user.email',
      kind: 'read',
      run: (git, token) =>
        git.exec(session.repo.root, ['config', '--get', 'user.email'], {
          structured: true,
          allowNonZeroExit: true,
          noOptionalLocks: true,
          token,
        }),
    });
    interface Item extends vscode.QuickPickItem {
      value?: string;
      me?: boolean;
    }
    const items: Item[] = [];
    if (me.exitCode === 0 && me.stdout.trim().length > 0) {
      items.push({ label: vscode.l10n.t('$(account) Me ({0})', me.stdout.trim()), me: true });
      items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
    }
    items.push(
      ...authors.map((a) => ({
        label: a,
        value: a,
        picked: session.filter.authors?.includes(a) === true,
      })),
    );
    const picked = await vscode.window.showQuickPick(items, {
      canPickMany: true,
      placeHolder: vscode.l10n.t('Filter by author'),
    });
    if (!picked) return { ok: false };
    const values = picked.map((p) => (p.me === true ? me.stdout.trim() : p.value)).filter(
      (v): v is string => v !== undefined && v.length > 0,
    );
    const next: LogFilter = { ...session.filter };
    if (values.length > 0) next.authors = values;
    else delete next.authors;
    this.applyFilter(next);
    return { ok: true };
  }

  private async pickDates(): Promise<{ ok: boolean }> {
    const session = this.session;
    if (!session) return { ok: false };
    const custom = vscode.l10n.t('Custom rangeâ€¦');
    const presets: Array<{ label: string; from?: () => string }> = [
      { label: vscode.l10n.t('Today'), from: () => isoDaysAgo(0) },
      { label: vscode.l10n.t('Yesterday'), from: () => isoDaysAgo(1) },
      { label: vscode.l10n.t('Last 7 days'), from: () => isoDaysAgo(7) },
      { label: vscode.l10n.t('Last 30 days'), from: () => isoDaysAgo(30) },
      { label: custom },
    ];
    const picked = await vscode.window.showQuickPick(
      presets.map((p) => p.label),
      { placeHolder: vscode.l10n.t('Filter by date') },
    );
    if (picked === undefined) return { ok: false };
    const next: LogFilter = { ...session.filter };
    if (picked === custom) {
      const validate = (v: string): string | undefined =>
        v.length === 0 || /^\d{4}-\d{2}-\d{2}$/.test(v) ? undefined : vscode.l10n.t('Use YYYY-MM-DD');
      const from = await vscode.window.showInputBox({
        prompt: vscode.l10n.t('From (YYYY-MM-DD, empty = open)'),
        validateInput: validate,
        ignoreFocusOut: true,
      });
      if (from === undefined) return { ok: false };
      const to = await vscode.window.showInputBox({
        prompt: vscode.l10n.t('Until (YYYY-MM-DD, empty = open)'),
        validateInput: validate,
        ignoreFocusOut: true,
      });
      if (to === undefined) return { ok: false };
      const range: { from?: string; to?: string } = {};
      if (from.length > 0) range.from = from;
      if (to.length > 0) range.to = to;
      if (range.from !== undefined || range.to !== undefined) next.dateRange = range;
      else delete next.dateRange;
    } else {
      const preset = presets.find((p) => p.label === picked);
      if (preset?.from) next.dateRange = { from: preset.from() };
    }
    this.applyFilter(next);
    return { ok: true };
  }

  /** `Paths ▾ · Select…` — the reference's file chooser. */
  private async pickPaths(): Promise<{ ok: boolean }> {
    const session = this.session;
    if (!session) return { ok: false };
    const browse = vscode.l10n.t('$(folder) Browseâ€¦');
    const manual = vscode.l10n.t('$(edit) Enter path or globâ€¦');
    const picked = await vscode.window.showQuickPick([browse, manual], {
      placeHolder: vscode.l10n.t('Filter by path'),
    });
    if (picked === undefined) return { ok: false };
    let chosen: string[];
    if (picked === browse) {
      const uris = await vscode.window.showOpenDialog({
        canSelectFiles: true,
        canSelectFolders: true,
        canSelectMany: true,
        defaultUri: vscode.Uri.file(session.repo.root),
        openLabel: vscode.l10n.t('Filter'),
      });
      if (!uris || uris.length === 0) return { ok: false };
      chosen = [];
      const outside: string[] = [];
      for (const uri of uris) {
        const rel = repoRelative(session.repo.root, uri.fsPath);
        if (rel === undefined) outside.push(path.basename(uri.fsPath));
        else chosen.push(rel);
      }
      // A path outside the repository used to be dropped in silence, and if
      // every pick was outside the filter silently *widened* to unfiltered.
      // Say so — in a multi-root workspace browsing into the wrong repository
      // is the easy mistake, and the log only shows one at a time.
      if (outside.length > 0) {
        void vscode.window.showWarningMessage(
          vscode.l10n.t(
            '{0} is not inside {1}. The log filters one repository at a time — switch it under Paths ▾ · Roots.',
            outside.join(', '),
            path.basename(session.repo.root),
          ),
        );
      }
      if (chosen.length === 0) return { ok: false };
    } else {
      const value = await vscode.window.showInputBox({
        prompt: vscode.l10n.t('Repo-relative path or glob (e.g. src/**/*.ts)'),
        ignoreFocusOut: true,
      });
      if (value === undefined || value.trim().length === 0) return { ok: false };
      chosen = [value.trim()];
    }
    // Adds, like the panel's own text box — the two used to disagree, this one
    // replacing the whole selection where typing appended to it.
    const next: LogFilter = { ...session.filter };
    next.paths = [...new Set([...(session.filter.paths ?? []), ...chosen])];
    delete next.follow;
    this.applyFilter(next);
    return { ok: true };
  }

  /**
   * `Paths ▾ · Select in Tree…` — tick paths out of the repository's own tree.
   *
   * A QuickPick cannot expand nodes, so `buildPathTree` supplies tree *order*
   * and depth and the label indents by it; typing filters the whole tree,
   * which is what the chooser is for anyway.
   */
  private async pickPathsInTree(): Promise<{ ok: boolean }> {
    const session = this.session;
    if (!session) return { ok: false };
    const listed = await session.repo.queue.enqueue({
      label: 'ls-files (path filter)',
      kind: 'read',
      run: (git, token) =>
        git.exec(session.repo.root, ['ls-files', '-z'], {
          structured: true,
          noOptionalLocks: true,
          allowNonZeroExit: true,
          token,
        }),
    });
    if (listed.exitCode !== 0) {
      void vscode.window.showWarningMessage(
        vscode.l10n.t('Could not read the tracked files of {0}.', path.basename(session.repo.root)),
      );
      return { ok: false };
    }
    const tree = buildPathTree(listed.stdout.split('\0').filter((p) => p.length > 0));
    if (tree.items.length === 0) {
      void vscode.window.showInformationMessage(
        vscode.l10n.t('{0} has no tracked files yet.', path.basename(session.repo.root)),
      );
      return { ok: false };
    }

    const current = new Set(session.filter.paths ?? []);
    interface Item extends vscode.QuickPickItem {
      value: string;
    }
    // Non-breaking spaces: a QuickPick label is rendered as HTML text, which
    // collapses a run of ordinary spaces to one and would flatten the tree.
    // The full path rides in the description so typing still finds a row
    // whatever its depth (`matchOnDescription`).
    const indent = '\u00a0\u00a0\u00a0';
    const items: Item[] = tree.items.map((node) => ({
      label: `${indent.repeat(node.depth)}$(${node.kind === 'dir' ? 'folder' : 'file'}) ${node.name}`,
      description: node.depth > 0 ? node.path : undefined,
      value: node.path,
      picked: current.has(node.path),
    }));
    const title =
      tree.mode === 'full'
        ? vscode.l10n.t('Select in Tree — {0}', path.basename(session.repo.root))
        : tree.mode === 'dirsOnly'
          ? vscode.l10n.t(
              'Select in Tree — {0} folders ({1} paths: files omitted, add them under Select…)',
              String(tree.items.length),
              String(tree.total),
            )
          : vscode.l10n.t(
              'Select in Tree — first {0} of {1} folders',
              String(tree.items.length),
              String(tree.total),
            );
    const picked = await vscode.window.showQuickPick(items, {
      canPickMany: true,
      title,
      placeHolder: vscode.l10n.t('Filter by path'),
      matchOnDescription: true,
    });
    if (picked === undefined) return { ok: false };

    const next: LogFilter = { ...session.filter };
    const paths = mergeTreeSelection(
      session.filter.paths ?? [],
      tree.items.map((node) => node.path),
      picked.map((p) => p.value),
    );
    if (paths.length === 0) delete next.paths;
    else next.paths = paths;
    delete next.follow;
    this.applyFilter(next);
    return { ok: true };
  }

  // ---- diffs ----------------------------------------------------------------

  private async openFileDiff(sha: string, file: CommitFileDto, baseRev?: string): Promise<void> {
    const session = this.session;
    if (!session) return;
    const repoRoot = session.repo.root;
    // P12-T3: an aggregate selection diffs the whole range, not one commit.
    const base = baseRev ?? `${sha}^`;
    const titleOf = (f: CommitFileDto): string =>
      `${path.posix.basename(f.path)} (${
        baseRev !== undefined ? `${baseRev.slice(0, 7)}..` : ''
      }${sha.slice(0, 7)})`;
    if (file.status.startsWith('A')) {
      await vscode.window.showTextDocument(makeRevUri(repoRoot, file.path, sha), { preview: true });
      return;
    }
    if (file.status.startsWith('D')) {
      await vscode.window.showTextDocument(makeRevUri(repoRoot, file.path, base), { preview: true });
      return;
    }

    // P14-T7: open through the sequence, not as a standalone pair. The pane the
    // user clicked in IS the sequence, so "next change" can leave this file for
    // the next one instead of wrapping to the top of it. Added and deleted
    // files open as plain documents (there is nothing to diff), so they are
    // excluded from the sequence rather than being dead stops inside it.
    const p14 = this.core.debugRegistry.get('phase14') as
      | { sessions: { open(entries: readonly DiffEntry[], index: number): Promise<void> } }
      | undefined;
    const diffable = this.lastChangedFiles.filter(
      (f) => !f.status.startsWith('A') && !f.status.startsWith('D'),
    );
    const entries: DiffEntry[] = (diffable.length > 0 ? diffable : [file]).map((f) => ({
      original: makeRevUri(repoRoot, f.origPath ?? f.path, base),
      modified: makeRevUri(repoRoot, f.path, sha),
      title: titleOf(f),
    }));
    const index = Math.max(
      0,
      entries.findIndex((e) => e.modified.toString() === makeRevUri(repoRoot, file.path, sha).toString()),
    );
    if (p14) {
      await p14.sessions.open(entries, index);
      return;
    }
    await vscode.commands.executeCommand(
      'vscode.diff',
      entries[index]!.original,
      entries[index]!.modified,
      entries[index]!.title,
    );
  }

  private async openAllDiffs(sha: string): Promise<void> {
    const session = this.session;
    if (!session) return;
    const details = await session.service.getCommitDetails(sha);
    if (!details) return;
    const repoRoot = session.repo.root;
    const changes: [vscode.Uri, vscode.Uri | undefined, vscode.Uri | undefined][] = details.files.map((f) => {
      const fileUri = vscode.Uri.file(path.join(repoRoot, f.path));
      const left = f.status.startsWith('A') ? undefined : makeRevUri(repoRoot, f.origPath ?? f.path, `${sha}^`);
      const right = f.status.startsWith('D') ? undefined : makeRevUri(repoRoot, f.path, sha);
      return [fileUri, left, right];
    });
    await vscode.commands.executeCommand('vscode.changes', vscode.l10n.t('Commit {0}', sha.slice(0, 7)), changes);
  }
}

function isoDaysAgo(days: number): string {
  const d = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}

/**
 * The part of a filter that still means something in a *different* repository.
 *
 * `paths` are repo-relative; an explicit `refs` list and a `range` name one
 * repository's branches. Carried across a root switch the first empties the
 * log and the second fails the page read on `unknown revision`, both of which
 * read to the user as "this repository has no history". Authors, dates, the
 * text query and the sort order are portable, so they survive.
 */
function rootAgnostic(filter: LogFilter): LogFilter {
  const next: LogFilter = { ...filter };
  delete next.paths;
  delete next.follow;
  delete next.range;
  if (Array.isArray(next.refs)) next.refs = 'HEAD';
  return next;
}
