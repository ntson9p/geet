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
import {
  LOG_METHODS,
  type CommitDetailsDto,
  type CommitFileDto,
  type LogFilterDto,
  type LogInitDto,
  type LogPageDto,
  type LogRowDto,
} from '../shared/protocol';
import { buildWebviewHtml, webviewResourceRoots, WebviewRpcHost } from '../ui/webviewHost';
import { makeRevUri } from '../core/vdocs/revContentProvider';
import { statusColorOverrides } from '../ui/statusColors';
import { BranchesPaneBridge } from './branchesPaneBridge';
import { GraphLayout } from './graphLayout/layout';
import { intelliSort } from './graphLayout/intelliSort';
import { DEFAULT_FILTER, type LogFilter } from './logFilter';
import { LogService, type LogRow } from './logService';

const LANE_WIDTH = 12;

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
  private refsSub: vscode.Disposable | undefined;
  /** Boot breadcrumbs (integration-test observability). */
  readonly debugTrail: string[] = [];

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

  private activeRepo(): RepoHandle | undefined {
    const uri = vscode.window.activeTextEditor?.document.uri;
    return (uri && this.core.repoForUri(uri)) ?? this.session?.repo ?? this.core.repos[0];
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
      if (view.visible) this.rpc?.rehydrate();
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
    rpc.on(LOG_METHODS.pickBranches, () => this.pickBranches());
    rpc.on(LOG_METHODS.pickAuthors, () => this.pickAuthors());
    rpc.on(LOG_METHODS.pickDates, () => this.pickDates());
    rpc.on(LOG_METHODS.pickPaths, () => this.pickPaths());
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
        return {
          files:
            details?.files.map((f) => ({
              status: f.status,
              path: f.path,
              ...(f.origPath !== undefined ? { origPath: f.origPath } : {}),
            })) ?? [],
          newest: shas[0]!,
        };
      }
      // Selection order is click order; the range is graph order.
      const order = new Map(session.rows.map((r, i) => [r.sha, i] as const));
      const sorted = [...shas].sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
      const newest = sorted[0]!;
      const oldest = sorted[sorted.length - 1]!;
      const aggregate = await session.service.getAggregateFiles(oldest, newest);
      return { files: aggregate.files, newest, base: aggregate.base };
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
      await this.revealCommit(resolved.stdout.trim());
      return { ok: true };
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
    rpc.on(LOG_METHODS.branchAction, async (params) => {
      const repo = this.session?.repo ?? this.activeRepo();
      if (!repo) return { ok: false };
      await this.branchesBridge.dispatch(
        repo,
        params as { action: string; name?: string; type?: 'local' | 'remote' | 'tag' },
      );
      return { ok: true };
    });

    view.onDidDispose(() => {
      rpc.dispose();
      this.rpc = undefined;
      this.view = undefined;
      this.refsSub?.dispose();
      this.refsSub = undefined;
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

  private startSession(filterDto: LogFilterDto): LogInitDto {
    const repo = this.activeRepo();
    if (!repo) {
      return {
        repoRoot: '',
        repoLabel: vscode.l10n.t('No repository'),
        filter: filterDto,
        laneWidth: LANE_WIDTH,
        graphPalette: this.graphPalette(),
        colors: statusColorOverrides(),
      };
    }
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
    const modelSub = repo.model.onDidChange(notifyRefs);
    const favSub = this.branchesBridge.refServiceFor(repo)?.onDidChangeFavorites(notifyRefs);
    this.refsSub = new vscode.Disposable(() => {
      modelSub.dispose();
      favSub?.dispose();
    });
    return {
      repoRoot: repo.root,
      repoLabel: path.basename(repo.root),
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

  private applyFilter(filterDto: LogFilterDto): void {
    const init = this.startSession(filterDto);
    this.rpc?.notify(LOG_METHODS.evtReset, init);
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

  async revealCommit(sha: string, repoRoot?: string): Promise<void> {
    await vscode.commands.executeCommand('gittree.log.focus');
    // Wait for the view to resolve (first open).
    for (let i = 0; i < 50 && !this.rpc; i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    const session = this.session;
    if (!session || !this.rpc) return;
    if (repoRoot !== undefined && canonicalKey(repoRoot) !== canonicalKey(session.repo.root)) {
      this.applyFilter(session.filter);
    }
    // Load pages until the sha is in the row store (bounded).
    let guard = 0;
    while (!this.session!.rows.some((r) => r.sha === sha) && !this.session!.eof && guard < 25) {
      await this.sendPage(this.session!.nextPage);
      guard++;
    }
    this.rpc.notify(LOG_METHODS.evtReveal, { sha });
  }

  async setFilter(filter: LogFilter): Promise<void> {
    await vscode.commands.executeCommand('gittree.log.focus');
    for (let i = 0; i < 50 && !this.rpc; i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    this.applyFilter(filter);
  }

  refresh(): void {
    const session = this.session;
    if (!session) return;
    session.service.invalidate();
    void this.applyFilter(session.filter);
  }

  get currentSession(): { repoRoot: string; filter: LogFilter; rowCount: number } | undefined {
    return this.session
      ? { repoRoot: this.session.repo.root, filter: this.session.filter, rowCount: this.session.rows.length }
      : undefined;
  }

  // ---- pickers (host-side QuickPicks/InputBoxes) ----------------------------

  private async pickBranches(): Promise<{ ok: boolean }> {
    const session = this.session;
    if (!session) return { ok: false };
    const refs = session.repo.model.snapshot.refs.filter((r) => r.type !== 'tag');
    interface Item extends vscode.QuickPickItem {
      value?: string;
      preset?: 'ALL' | 'HEAD';
    }
    const items: Item[] = [
      { label: vscode.l10n.t('$(list-flat) All branches'), preset: 'ALL' },
      { label: vscode.l10n.t('$(target) HEAD only'), preset: 'HEAD' },
      { label: '', kind: vscode.QuickPickItemKind.Separator },
      ...refs.map((r) => ({
        label: `$(git-branch) ${r.name}`,
        value: r.name,
        picked: Array.isArray(session.filter.refs) && session.filter.refs.includes(r.name),
      })),
    ];
    const picked = await vscode.window.showQuickPick(items, {
      canPickMany: true,
      placeHolder: vscode.l10n.t('Filter by branches (presets override selections)'),
    });
    if (!picked) return { ok: false };
    const preset = picked.find((p) => p.preset !== undefined)?.preset;
    const values = picked.map((p) => p.value).filter((v): v is string => v !== undefined);
    const next: LogFilter = { ...session.filter };
    delete next.range;
    next.refs = preset ?? (values.length > 0 ? values : 'HEAD');
    this.applyFilter(next);
    return { ok: true };
  }

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

  private async pickPaths(): Promise<{ ok: boolean }> {
    const session = this.session;
    if (!session) return { ok: false };
    const browse = vscode.l10n.t('$(folder) Browseâ€¦');
    const manual = vscode.l10n.t('$(edit) Enter path or globâ€¦');
    const picked = await vscode.window.showQuickPick([browse, manual], {
      placeHolder: vscode.l10n.t('Filter by path'),
    });
    if (picked === undefined) return { ok: false };
    const next: LogFilter = { ...session.filter };
    if (picked === browse) {
      const uris = await vscode.window.showOpenDialog({
        canSelectFiles: true,
        canSelectFolders: true,
        canSelectMany: true,
        defaultUri: vscode.Uri.file(session.repo.root),
        openLabel: vscode.l10n.t('Filter'),
      });
      if (!uris || uris.length === 0) return { ok: false };
      next.paths = uris
        .map((u) => path.relative(session.repo.root, u.fsPath).replace(/\\/g, '/'))
        .filter((p) => p.length > 0 && !p.startsWith('..'));
    } else {
      const value = await vscode.window.showInputBox({
        prompt: vscode.l10n.t('Repo-relative path or glob (e.g. src/**/*.ts)'),
        ignoreFocusOut: true,
      });
      if (value === undefined || value.trim().length === 0) return { ok: false };
      next.paths = [value.trim()];
    }
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
    const title = `${path.posix.basename(file.path)} (${
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
    await vscode.commands.executeCommand(
      'vscode.diff',
      makeRevUri(repoRoot, file.origPath ?? file.path, base),
      makeRevUri(repoRoot, file.path, sha),
      title,
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
