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
import { repoLabels } from '../core/util/repoLabels';
import {
  DEFAULT_LOG_PRESENTATION,
  LOG_METHODS,
  type CommitDetailsDto,
  type CommitFileDto,
  type LogFilterDto,
  type LogInitDto,
  type LogPageDto,
  type LogPresentationDto,
  type LogRootDto,
  type LogRowDto,
  type LogTab,
  type LogTabsDto,
  type LogWorktreeActionParamsDto,
} from '../shared/protocol';
import { buildWebviewHtml, webviewResourceRoots, WebviewRpcHost } from '../ui/webviewHost';
import { makeRevUri } from '../core/vdocs/revContentProvider';
import type { DiffEntry, DiffSessionRegistry } from '../diff/diffSession';
import { hasIdenticalSides } from '../diff/navigationStep';
import { statusColorOverrides } from '../ui/statusColors';
import { BranchesPaneBridge } from './branchesPaneBridge';
import { WorktreesPaneBridge } from './worktreesPaneBridge';
import { rootColorIndices } from './graphLayout/colors';
import { GraphLayout } from './graphLayout/layout';
import { intelliSort } from './graphLayout/intelliSort';
import {
  DEFAULT_FILTER,
  graphParents,
  graphSort,
  hidesCommit,
  isUnfiltered,
  type LogFilter,
} from './logFilter';
import { LogService, type LogRow } from './logService';
import { zipChanges } from './zipChanges';
import { committedByOther, userName } from './vcsUser';
import {
  MAIN_LOG_TAB,
  activateTab,
  closeTabs,
  findTab,
  isClosable,
  openTab,
  restoreTabsState,
  updateTab,
  type LogTabRecord,
  type LogTabsState,
} from './logTabs';
import { buildPathTree, mergeTreeSelection } from './pathTree';
import {
  PRESENTATION_SETTINGS,
  presentationPatch,
  writeScope,
  type PresentationKey,
} from './presentation';

const LANE_WIDTH = 12;
/** IntelliJ's cap on the commits a selection acts on (`VcsLogUtil.MAX_SELECTED_COMMITS`). */
const MAX_SELECTED_COMMITS = 1000;

/**
 * Auto-refresh coalescing window. A rebase, a pull or a multi-repo commit
 * moves `refs` once per step, and each re-page is a §13 ≤600 ms read at 100k
 * commits — one per burst is the whole point of the wait. Long enough to
 * swallow a multi-step rewrite, short enough that a single commit still lands
 * in the graph while the user is still looking at it.
 */
const AUTO_REFRESH_DEBOUNCE_MS = 300;
/**
 * The longest an auto-refresh waits for the repository's running git
 * operation to finish. A cherry-pick of several commits, a push and its
 * follow-up refresh, a rebase — each moves history several times; re-reading
 * once at the end is one repaint instead of one per step. A long operation
 * (a slow fetch) still lets the graph catch up after this long.
 */
const AUTO_REFRESH_MAX_WAIT_MS = 5000;

/** Which repository the log is showing, remembered across restarts. */
const ROOT_MEMENTO_KEY = 'gittree.log.root';
/** The Log tabs (`LogTabsState`), so they come back after a restart. */
const TABS_MEMENTO_KEY = 'gittree.log.tabs';

/** The Log tab a request or event is about: its `logTab`, or the main tab. */
function tabOf(params: unknown): string {
  const tab = (params as { logTab?: unknown } | undefined)?.logTab;
  return typeof tab === 'string' ? tab : MAIN_LOG_TAB;
}

/** One Log tab's paging state. A tab has none until it is first shown. */
interface Session {
  tab: string;
  repo: RepoHandle;
  service: LogService;
  filter: LogFilter;
  layout: GraphLayout;
  /** All rows sent so far (replayed on rehydrate). */
  rows: LogRowDto[];
  nextPage: number;
  eof: boolean;
  /**
   * The HEAD the rows were paged at. `sections.has('head')` is too coarse to
   * gate on — it also fires for ahead/behind and lastFetchAt, which change
   * nothing the graph draws — so the sha is compared directly.
   */
  lastHeadSha: string | undefined;
  /**
   * History moved since the rows were paged. Only the tab on show re-pages;
   * the others wait until they are brought forward, so ten open tabs cost
   * one `git log` per commit, not ten.
   */
  dirty: boolean;
  /** The repository watches: refs for the Branches pane, history for the rows. */
  sub: vscode.Disposable | undefined;
}

export class LogViewProvider implements vscode.WebviewViewProvider {
  static readonly viewId = 'gittree.log';
  private view: vscode.WebviewView | undefined;
  private rpc: WebviewRpcHost | undefined;
  /** One session per Log tab that has been shown, keyed by tab id. */
  private readonly sessions = new Map<string, Session>();
  /** The Log tabs: which exist, what each filters, which one is active. */
  private tabsState: LogTabsState;
  /** Whether `tabsState` has ever been stored (else the webview's old filter seeds the main tab). */
  private tabsStored: boolean;
  private readonly services = new Map<string, LogService>();
  /** P12-T1: the host-side selection model (`log/select`), per tab. */
  private readonly selections = new Map<string, string[]>();
  /** P12-T2: refs data + shared-registry dispatch for the Branches pane. */
  readonly branchesBridge: BranchesPaneBridge;
  /** POST-P14k: the Worktrees tab's list + `gittree.worktree.*` dispatch. */
  readonly worktreesBridge: WorktreesPaneBridge;
  /** Keeps `Paths ▾ · Roots` current as folders join and leave the workspace. */
  private rootsSub: vscode.Disposable | undefined;
  /** P12-T8: throttled Console change ping. */
  private consoleSub: vscode.Disposable | undefined;
  /** POST-P14k: per-repo ref watches behind the Worktrees tab's refresh ping. */
  private worktreesSub: vscode.Disposable | undefined;
  /** Boot breadcrumbs (integration-test observability). */
  readonly debugTrail: string[] = [];
  /** Auto-refresh: coalescing timer, and the deferral for a hidden panel. */
  private autoRefreshTimer: NodeJS.Timeout | undefined;
  private autoRefreshPending = false;
  /** Auto-refreshes actually executed (integration-test observability). */
  autoRefreshCount = 0;
  /** When an auto-refresh started waiting for a running git operation. */
  private autoRefreshWaitStart: number | undefined;
  /** POST-P14af: a tab asked for while the view was still starting — see `showTab`. */
  private pendingTab: LogTab | undefined;

  /** The active Log tab's session: what commands and the public API act on. */
  private get session(): Session | undefined {
    return this.sessions.get(this.tabsState.active);
  }

  /** The active tab's multi-select in webview order — what commit actions operate on. */
  get selectedCommits(): readonly string[] {
    return this.selections.get(this.tabsState.active) ?? [];
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
    const stored = context.workspaceState.get<unknown>(TABS_MEMENTO_KEY);
    this.tabsStored = stored !== undefined;
    this.tabsState = restoreTabsState(stored);
  }

  // ---- Log tabs --------------------------------------------------------------

  private saveTabs(): void {
    this.tabsStored = true;
    const { tabs, active, next } = this.tabsState;
    void this.context.workspaceState.update(TABS_MEMENTO_KEY, { tabs, active, next });
  }

  private tabsDto(show?: string): LogTabsDto {
    // Each tab shows one repository (D24); with several in the workspace, the
    // strip may have to say which, in the names `Roots` uses.
    const labels = this.core.repos.length > 1 ? repoLabels(this.core.repos.map((r) => r.root)) : undefined;
    const repoOf = (tab: LogTabRecord): string | undefined => {
      if (labels === undefined) return undefined;
      const root = this.rootOfTab(tab);
      const repo = root !== undefined ? this.core.getRepo(root) : undefined;
      return repo !== undefined ? labels.get(repo.root) : undefined;
    };
    return {
      tabs: this.tabsState.tabs.map((tab) => {
        const repo = repoOf(tab);
        return {
          id: tab.id,
          filter: this.sessions.get(tab.id)?.filter ?? tab.filter,
          closable: isClosable(tab.id),
          ...(repo !== undefined ? { repo } : {}),
        };
      }),
      active: this.tabsState.active,
      ...(show !== undefined ? { show } : {}),
    };
  }

  /** @param show a tab to bring forward — one a command opened or picked. */
  private notifyTabs(show?: string): void {
    this.rpc?.notify(LOG_METHODS.evtTabs, this.tabsDto(show));
  }

  private record(tab: string): LogTabRecord | undefined {
    return this.tabsState.tabs.find((t) => t.id === tab);
  }

  /** The repository a tab shows: its session's, else what it remembers. */
  private rootOfTab(tab: LogTabRecord): string | undefined {
    const live = this.sessions.get(tab.id)?.repo.root;
    if (live !== undefined) return live;
    return tab.id === MAIN_LOG_TAB ? this.pinnedRoot()?.root : tab.root;
  }

  /**
   * A tab was brought forward: commands act on it from now on, the panel
   * names its repository, and rows that went stale while it was behind
   * another tab are re-paged now, not before.
   */
  private onActivated(tab: string): void {
    const session = this.sessions.get(tab);
    if (session && this.view) this.view.description = path.basename(session.repo.root);
    if (session?.dirty === true && this.view?.visible === true) {
      this.autoRefreshCount++;
      this.debugTrail.push(`auto-refresh on activate ${tab}`);
      this.refresh(tab);
    }
  }

  private dropSession(tab: string): void {
    this.sessions.get(tab)?.sub?.dispose();
    this.sessions.delete(tab);
    this.selections.delete(tab);
  }

  /** Waits for the webview to start `tab`'s session (a tab just opened or shown). */
  private async waitForSession(tab: string): Promise<Session | undefined> {
    for (let i = 0; i < 100 && !this.sessions.has(tab); i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    return this.sessions.get(tab);
  }

  private serviceFor(repo: RepoHandle): LogService {
    const key = canonicalKey(repo.root);
    let s = this.services.get(key);
    if (!s) {
      s = new LogService(repo, this.context.workspaceState, (l) => this.core.output.appendLine(`[log] ${l}`));
      this.services.set(key, s);
      const service = s;
      repo.disposables.add({
        dispose: () => {
          this.services.delete(key);
          service.dispose();
        },
      });
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
   * The `Roots` section: every repository the workspace has. The naming rule
   * (a colliding basename grows its parent directory) moved to
   * `core/util/repoLabels` when POST-P14u gave the sidebar two more lists of
   * the same repositories — a root called one thing here and another thing
   * there is a root the user cannot match across the two.
   */
  private roots(): LogRootDto[] {
    const repos = [...this.core.repos].sort((a, b) => a.root.localeCompare(b.root));
    const labels = repoLabels(repos.map((r) => r.root));
    const colors = rootColorIndices(repos.map((r) => r.root));
    return repos.map((repo) => ({
      root: repo.root,
      label: labels.get(repo.root) ?? path.basename(repo.root),
      colorIdx: colors.get(repo.root) ?? 0,
    }));
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

    // ---- Log tabs: the strip's list, `+`, ×, and which tab is in front ----
    rpc.on(LOG_METHODS.tabs, () => {
      // A tab asked for before this view could hear `evtShowTab` (see `showTab`).
      const asked = this.pendingTab;
      this.pendingTab = undefined;
      return this.tabsDto(asked === 'log' ? this.tabsState.active : asked);
    });
    rpc.on(LOG_METHODS.openTab, (params) => {
      // IntelliJ's `Open Another Log Tab`: a new tab "matching your filters".
      const from = (params as { from?: unknown } | undefined)?.from;
      const source = this.record(typeof from === 'string' ? from : this.tabsState.active);
      const live = source !== undefined ? this.sessions.get(source.id) : undefined;
      const filter = live?.filter ?? source?.filter ?? DEFAULT_FILTER;
      const root = live?.repo.root ?? (source !== undefined ? this.rootOfTab(source) : undefined);
      const opened = openTab(this.tabsState, filter, root);
      this.tabsState = opened.state;
      this.saveTabs();
      this.debugTrail.push(`tab opened ${opened.id}`);
      this.notifyTabs();
      return { logTab: opened.id };
    });
    rpc.on(LOG_METHODS.closeTabs, (params) => {
      const ids = (params as { tabs?: unknown } | undefined)?.tabs;
      const closing = Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : [];
      return { ok: this.closeLogTabs(closing) };
    });
    rpc.on(LOG_METHODS.activateTab, (params) => {
      const tab = tabOf(params);
      const next = activateTab(this.tabsState, tab);
      if (next !== this.tabsState) {
        this.tabsState = next;
        this.saveTabs();
      }
      this.onActivated(this.tabsState.active);
      return { ok: true };
    });

    rpc.on(LOG_METHODS.init, (params) => {
      this.debugTrail.push('rpc:init');
      const tab = tabOf(params);
      const record = this.record(tab);
      // A tab closed while its view was starting: nothing to start.
      if (record === undefined) return undefined;
      // The single log used to keep its filter in the webview's own state; that
      // filter seeds the main tab once, until the tabs have been stored here.
      const requested = (params as { filter?: LogFilterDto } | undefined)?.filter;
      const filter =
        tab === MAIN_LOG_TAB && !this.tabsStored && requested !== undefined ? requested : record.filter;
      const init = this.startSession(tab, filter, tab === MAIN_LOG_TAB ? undefined : record.root);
      // The strip titled the tab from the stored filter; tell it about the seeded one.
      if (filter !== record.filter) this.notifyTabs();
      return init;
    });
    rpc.on(LOG_METHODS.page, async (params) => {
      const { page } = params as { page: number };
      const tab = tabOf(params);
      this.debugTrail.push(`rpc:page ${page}${tab === MAIN_LOG_TAB ? '' : ` ${tab}`}`);
      await this.sendPage(tab, page);
      return { ok: true };
    });
    rpc.on(LOG_METHODS.details, async (params) => {
      const { sha } = params as { sha: string };
      return this.getDetails(tabOf(params), sha);
    });
    rpc.on(LOG_METHODS.commitMessage, async (params) => {
      const { sha } = params as { sha: string };
      const session = this.sessions.get(tabOf(params));
      if (!session || typeof sha !== 'string') return { message: undefined };
      return { message: await session.service.getCommitMessage(sha) };
    });
    rpc.on(LOG_METHODS.setFilter, (params) => {
      const { filter } = params as { filter: LogFilterDto };
      this.applyFilter(tabOf(params), filter);
      return { ok: true };
    });
    rpc.on(LOG_METHODS.pickAuthors, (params) => this.pickAuthors(tabOf(params)));
    rpc.on(LOG_METHODS.pickDates, (params) => this.pickDates(tabOf(params)));
    rpc.on(LOG_METHODS.pickPaths, (params) => this.pickPaths(tabOf(params)));
    rpc.on(LOG_METHODS.pickPathsInTree, (params) => this.pickPathsInTree(tabOf(params)));
    rpc.on(LOG_METHODS.setRoot, (params) => {
      const { root } = params as { root: string };
      return { ok: typeof root === 'string' && this.showRoot(root, tabOf(params)) };
    });
    rpc.on(LOG_METHODS.openFileDiff, async (params) => {
      const { sha, file, files, browsing } = params as {
        sha: string;
        file: CommitFileDto;
        files?: CommitFileDto[];
        browsing?: boolean;
      };
      await this.openFileDiff(tabOf(params), sha, file, files ?? [file], browsing === true);
      return { ok: true };
    });
    rpc.on(LOG_METHODS.openAllDiffs, async (params) => {
      const { sha, shas } = params as { sha: string; shas?: unknown };
      const many = Array.isArray(shas) ? shas.filter((s): s is string => typeof s === 'string') : [];
      await this.openAllDiffs(tabOf(params), sha, many);
      return { ok: true };
    });
    rpc.on(LOG_METHODS.copy, async (params) => {
      const { text } = params as { text: string };
      await vscode.env.clipboard.writeText(text);
      return { ok: true };
    });
    rpc.on(LOG_METHODS.rangeCounts, async (params) => {
      const session = this.sessions.get(tabOf(params));
      const range = session?.filter.range;
      if (!session || !range) return undefined;
      return session.service.getRangeCounts(range.a, range.b);
    });
    rpc.on(LOG_METHODS.showFilesDiff, async (params) => {
      const session = this.sessions.get(tabOf(params));
      const range = session?.filter.range;
      if (!session || !range) return { ok: false };
      await vscode.commands.executeCommand(
        'gittree.compare.showFilesDiff',
        session.repo.root,
        range.a,
        range.b,
      );
      return { ok: true };
    });
    // P12-T1: the selection lives host-side so "Compare", "Squash", "Push all
    // up to here" and the panes all read one model instead of racing copies.
    rpc.on(LOG_METHODS.select, (params) => {
      const { shas } = params as { shas: string[] };
      this.selections.set(
        tabOf(params),
        Array.isArray(shas) ? shas.filter((s) => typeof s === 'string') : [],
      );
      return { ok: true };
    });
    // P12-T3: the Changed Files pane — one commit's files, or for several the
    // merge of exactly their changes, as IntelliJ shows it.
    rpc.on(LOG_METHODS.changedFiles, async (params) => {
      const { shas } = params as { shas: string[] };
      const session = this.sessions.get(tabOf(params));
      if (!session || !Array.isArray(shas) || shas.length === 0) return { files: [] };
      if (shas.length === 1) {
        const details = await session.service.getCommitDetails(shas[0]!);
        const files =
          details?.files.map((f) => ({
            status: f.status,
            path: f.path,
            ...(f.origPath !== undefined ? { origPath: f.origPath } : {}),
          })) ?? [];
        return { files, newest: shas[0]! };
      }
      const sorted = this.newestFirst(session, shas);
      const files = await this.zippedFiles(session, sorted);
      return { files, newest: sorted[0]!, shas: sorted };
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
      const session = this.sessions.get(tabOf(params));
      if (!session) return { branches: [] };
      return { branches: await session.service.getContainingBranches(sha) };
    });

    rpc.on(LOG_METHODS.goTo, async (params) => {
      const { sha } = params as { sha: string };
      await this.revealIn(tabOf(params), sha);
      return { ok: true };
    });

    // P12-T5: the rewritten filter row's data + toolbar actions.
    rpc.on(LOG_METHODS.authors, async (params) => {
      const session = this.sessions.get(tabOf(params));
      if (!session) return { authors: [] };
      return { authors: await session.service.getAuthors() };
    });

    // `ok: false` — nothing to re-read (no session yet): the button stops
    // turning on the answer instead of waiting for rows that are not coming.
    rpc.on(LOG_METHODS.refresh, (params) => ({ ok: this.refresh(tabOf(params)) }));

    rpc.on(LOG_METHODS.goToRef, async (params) => {
      const { ref } = params as { ref?: string };
      const tab = tabOf(params);
      const session = this.sessions.get(tab);
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
      return { ok: await this.revealIn(tab, resolved.stdout.trim()) };
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

    // `Presentation Settings ▾` and `Branches Pane Settings`. The answer is
    // what the settings say once written, so a write that did not take (a
    // scope that cannot be written) puts the checkbox back rather than leaving
    // it claiming a state the view does not have.
    rpc.on(LOG_METHODS.setPresentation, async (params) => {
      await this.writePresentation(presentationPatch(params));
      return this.presentation();
    });

    rpc.on(LOG_METHODS.showFileHistory, async (params) => {
      const { path: relPath } = params as { path: string };
      const session = this.sessions.get(tabOf(params));
      if (!session || typeof relPath !== 'string') return { ok: false };
      await vscode.commands.executeCommand(
        'gittree.showFileHistory',
        vscode.Uri.file(path.join(session.repo.root, relPath)),
      );
      return { ok: true };
    });

    // P12-T2: the Branches pane.
    rpc.on(LOG_METHODS.branches, async (params) => {
      const repo = this.repoOfTab(tabOf(params));
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
      const repo = this.repoOfTab(tabOf(params));
      if (!repo) return { ok: false };
      await this.branchesBridge.dispatch(
        repo,
        params as { action: string; name?: string; type?: 'local' | 'remote' | 'tag' },
      );
      return { ok: true };
    });

    // A repository joining or leaving the workspace changes the `Roots` list
    // and nothing else, so it is pushed on its own — `evtReset` would restart
    // paging and drop the selection over a list of repository names. The tabs
    // go too: whether they name their repositories, and by what, can change.
    this.rootsSub?.dispose();
    const notifyRoots = (): void => {
      this.rpc?.notify(LOG_METHODS.evtRoots, { roots: this.roots() });
      this.notifyTabs();
    };
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
      // The tabs themselves are kept (and stored); their sessions restart when
      // a view next asks for them.
      for (const tab of [...this.sessions.keys()]) this.dropSession(tab);
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

  /** How rows and refs are drawn: every setting in `PRESENTATION_SETTINGS`. */
  private presentation(): LogPresentationDto {
    const out: LogPresentationDto = { ...DEFAULT_LOG_PRESENTATION };
    for (const name of Object.keys(PRESENTATION_SETTINGS) as PresentationKey[]) {
      const { section, key } = PRESENTATION_SETTINGS[name];
      const value = vscode.workspace.getConfiguration(section).get<unknown>(key);
      if (typeof value === 'boolean') out[name] = value;
    }
    return out;
  }

  private async writePresentation(patch: Partial<LogPresentationDto>): Promise<void> {
    const hasWorkspace = (vscode.workspace.workspaceFolders?.length ?? 0) > 0;
    for (const name of Object.keys(patch) as PresentationKey[]) {
      const value = patch[name];
      if (value === undefined) continue;
      const { section, key, scope } = PRESENTATION_SETTINGS[name];
      const config = vscode.workspace.getConfiguration(section);
      const target =
        writeScope(config.inspect(key), scope, hasWorkspace) === 'workspace'
          ? vscode.ConfigurationTarget.Workspace
          : vscode.ConfigurationTarget.Global;
      try {
        await config.update(key, value, target);
      } catch (err) {
        this.core.output.appendLine(`[log] could not write ${section}.${key}: ${String(err)}`);
      }
    }
  }

  /**
   * A presentation setting changed. The view redraws its rows and Branches pane
   * from what it already holds; nothing is re-paged.
   */
  pushPresentation(): void {
    this.rpc?.notify(LOG_METHODS.evtPresentation, this.presentation());
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

  /** P10-T2: keyboard parity — move focus into the filter search box of the tab on show. */
  focusFilter(): void {
    this.rpc?.notify(LOG_METHODS.evtFocusFilter, { logTab: this.tabsState.active });
  }

  /**
   * POST-P14af: opens the Git tool window on one of its tabs — IntelliJ's
   * "Show details in console" after a failed or rejected push. `log` is the
   * active Log tab.
   *
   * A view that is already up takes the event. One that the focus below is
   * only now creating may not be listening yet, so the tab also rides on its
   * first `log/tabs` — kept for that case alone, or some later, unrelated
   * start would open on the Console too.
   */
  async showTab(tab: LogTab): Promise<void> {
    if (!this.rpc) this.pendingTab = tab;
    await vscode.commands.executeCommand('gittree.log.focus');
    for (let i = 0; i < 50 && !this.rpc; i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    this.rpc?.notify(LOG_METHODS.evtShowTab, { tab: tab === 'log' ? this.tabsState.active : tab });
  }

  /** The repository a tab shows, or would show once started. */
  private repoOfTab(tab: string): RepoHandle | undefined {
    const live = this.sessions.get(tab)?.repo;
    if (live) return live;
    const record = this.record(tab);
    const root = record !== undefined && tab !== MAIN_LOG_TAB ? record.root : undefined;
    return (root !== undefined ? this.core.getRepo(root) : undefined) ?? this.activeRepo();
  }

  /**
   * Starts (or restarts) one Log tab's session: a fresh row store and graph
   * layout over `filterDto`, and the watches that keep it current.
   *
   * @param repoRoot the repository to show. Naming one is the *explicit act*
   * that moves the tab; omitting it keeps whatever the tab is already showing.
   */
  private startSession(tab: string, filterDto: LogFilterDto, repoRoot?: string): LogInitDto {
    const named = repoRoot !== undefined ? this.core.getRepo(repoRoot) : undefined;
    const repo = named ?? this.repoOfTab(tab);
    const active = tab === this.tabsState.active;
    this.sessions.get(tab)?.sub?.dispose();
    if (!repo) {
      this.sessions.delete(tab);
      if (this.view && active) this.view.description = undefined;
      return {
        repoRoot: '',
        repoLabel: vscode.l10n.t('No repository'),
        roots: [],
        filter: filterDto,
        laneWidth: LANE_WIDTH,
        graphPalette: this.graphPalette(),
        colors: statusColorOverrides(),
        presentation: this.presentation(),
        logTab: tab,
      };
    }
    // The main tab's repository is seeded from the focused editor the first
    // time and held from then on; an extra tab keeps its own in the tab list.
    if (tab === MAIN_LOG_TAB) this.pinRoot(repo.root);
    if (this.view && active) this.view.description = path.basename(repo.root);
    this.debugTrail.push(`session repo=${repo.root}${tab === MAIN_LOG_TAB ? '' : ` tab=${tab}`}`);
    const session: Session = {
      tab,
      repo,
      service: this.serviceFor(repo),
      filter: filterDto,
      layout: new GraphLayout(),
      rows: [],
      nextPage: 0,
      eof: false,
      lastHeadSha: repo.model.snapshot.headSha,
      dirty: false,
      sub: undefined,
    };
    this.sessions.set(tab, session);
    this.tabsState = updateTab(this.tabsState, tab, filterDto, tab === MAIN_LOG_TAB ? undefined : repo.root);
    this.saveTabs();
    void session.service.maybeMaintain(this.core.git);
    // P12-T2: refs move (branch created, favorite toggled, checkout…) → the
    // tab's Branches pane re-requests. The event carries only the tab: the
    // webview's own request dedups bursts naturally.
    const notifyRefs = (): void => this.rpc?.notify(LOG_METHODS.evtBranches, { logTab: tab });
    const modelSub = repo.model.onDidChange((sections) => {
      notifyRefs();
      // Only history moving re-pages the graph. `status` fires on every save
      // and every stage — re-paging on it would cost a `git log` per keypress
      // in a watched file. `refs` covers heads/remotes/tags, so it catches any
      // commit that moved a branch; the sha comparison catches the rest, which
      // is a commit on a detached HEAD (only HEAD moves, no ref does).
      const headMoved = repo.model.snapshot.headSha !== session.lastHeadSha;
      if (!sections.has('refs') && !headMoved) return;
      session.lastHeadSha = repo.model.snapshot.headSha;
      session.dirty = true;
      this.scheduleAutoRefresh();
    });
    const favSub = this.branchesBridge.refServiceFor(repo)?.onDidChangeFavorites(notifyRefs);
    session.sub = new vscode.Disposable(() => {
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
      presentation: this.presentation(),
      logTab: tab,
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
    const graphRows = session.layout.appendPage([
      { sha: row.sha, parents: [...graphParents(session.filter, row.parents)] },
    ]);
    const graph = graphRows[0]!;
    const { headTarget, decorations } = parseDecorations(row.refs);
    return {
      sha: row.sha,
      subject: row.subject,
      // IntelliJ's Author column: the name, else the email's local part.
      authorName: userName(row.authorName, row.authorEmail),
      authorTime: row.authorTime,
      parents: row.parents,
      refs: decorations.map((d) => ({
        name: d.name,
        type: d.type,
        ...(d.type === 'branch' && d.name === headTarget ? { isHeadTarget: true } : {}),
      })),
      ...(committedByOther(row.authorName, row.authorEmail, row.committerName)
        ? { committedByOther: true }
        : {}),
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

  private async sendPage(tab: string, page: number): Promise<void> {
    const session = this.sessions.get(tab);
    if (!session || !this.rpc) return;
    if (page < session.nextPage) {
      // Rehydrate replay: resend everything we already have as page 0-style.
      this.rpc.notify(LOG_METHODS.evtRows, {
        page: 0,
        rows: session.rows,
        eof: session.eof,
        logTab: tab,
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
    if (this.sessions.get(tab) !== session) {
      this.debugTrail.push(`page ${page} dropped (stale session)`);
      return;
    }
    const ordered = graphSort(session.filter) === 'intelli' ? intelliSort(result.rows) : result.rows;
    const dtoRows: LogRowDto[] = [];
    for (const r of ordered) {
      // No Merges: the merge still passes through the layout, so the lines
      // that were waiting for it carry on to its first parent.
      if (hidesCommit(session.filter, r.parents)) session.layout.hide(r);
      else dtoRows.push(this.toDto(r, session));
    }
    session.nextPage = page + 1;
    session.eof = result.eof;
    if (dtoRows.length === 0 && !result.eof) {
      // A page that was all hidden merges. The webview pages on scrolling, and
      // an empty list has nothing to scroll, so read on rather than strand it
      // on a blank log. Its answer names the last page read, which is where
      // its next request must start.
      this.debugTrail.push(`page ${page} hid every row`);
      return this.sendPage(tab, page + 1);
    }
    this.debugTrail.push(`page ${page} sent ${dtoRows.length}`);
    session.rows.push(...dtoRows);
    this.rpc?.notify(LOG_METHODS.evtRows, {
      page,
      rows: dtoRows,
      eof: result.eof,
      logTab: tab,
    } satisfies LogPageDto);
  }

  private applyFilter(
    tab: string,
    filterDto: LogFilterDto,
    repoRoot?: string,
    opts?: { preserve?: boolean },
  ): void {
    const init = this.startSession(tab, filterDto, repoRoot);
    this.rpc?.notify(LOG_METHODS.evtReset, {
      ...init,
      ...(opts?.preserve === true ? { preserve: true } : {}),
    } satisfies LogInitDto);
    // The tab's title is made from its filter.
    this.notifyTabs();
  }

  /**
   * P10-T2: re-init with the current filter (palette/config changes). The tab
   * on show re-pages now; the others when they are next brought forward.
   */
  refreshInit(): void {
    for (const session of this.sessions.values()) session.dirty = true;
    const session = this.session;
    if (session) {
      session.dirty = false;
      this.applyFilter(session.tab, session.filter);
    }
  }

  private async getDetails(tab: string, sha: string): Promise<CommitDetailsDto | undefined> {
    const session = this.sessions.get(tab);
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

  /**
   * Selects `sha` in the active Log tab — a navigation, so it never opens a
   * tab of its own (blame's Show in Log, Go to Parent/Child, Go to Hash).
   * @returns whether the commit ended up selected in the graph.
   */
  async revealCommit(sha: string, repoRoot?: string): Promise<boolean> {
    await vscode.commands.executeCommand('gittree.log.focus');
    // Wait for the view to resolve (first open).
    for (let i = 0; i < 50 && !this.rpc; i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    const tab = this.tabsState.active;
    await this.waitForSession(tab);
    return this.revealIn(tab, sha, repoRoot);
  }

  private async revealIn(tab: string, sha: string, repoRoot?: string): Promise<boolean> {
    const session = this.sessions.get(tab);
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
      this.applyFilter(tab, { sort: session.filter.sort, refs: 'ALL' }, repoRoot);
    }
    if (await this.pageUntilLoaded(tab, sha)) {
      this.rpc.notify(LOG_METHODS.evtReveal, { sha, logTab: tab });
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
    this.reportRevealMiss(tab, sha);
    return false;
  }

  /** Pages `tab` forward until `sha` is loaded. Bounded; true when it landed. */
  private async pageUntilLoaded(tab: string, sha: string): Promise<boolean> {
    let guard = 0;
    // Read afresh each time: a reset while paging replaces the session.
    const current = (): Session | undefined => this.sessions.get(tab);
    while (current() && !current()!.rows.some((r) => r.sha === sha) && !current()!.eof && guard < 25) {
      await this.sendPage(tab, current()!.nextPage);
      guard++;
    }
    return current()?.rows.some((r) => r.sha === sha) === true;
  }

  /**
   * Says why nothing happened, and offers the one thing that would fix it.
   *
   * Deliberately not awaited: the caller's job is done either way, and a
   * command that blocks on a notification the user may never click would hang
   * `Go to Parent` on a keypress. The retry runs on its own.
   */
  private reportRevealMiss(tab: string, sha: string): void {
    const short = sha.slice(0, 7);
    const session = this.sessions.get(tab);
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
        // The notification outlives the view, and the tab: a click after either
        // closed would page into nothing and then blame the repository for it.
        if (!this.rpc || this.record(tab) === undefined) return;
        // Only the sort survives, on the same rule the cross-repository move
        // above follows: an author or path query written for another view
        // would routinely hide the very commit that was just asked for.
        this.applyFilter(tab, { sort: session.filter.sort, refs: 'ALL' });
        if (await this.pageUntilLoaded(tab, sha)) {
          this.rpc?.notify(LOG_METHODS.evtReveal, { sha, logTab: tab });
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
    this.applyFilter(this.tabsState.active, filter, repoRoot);
  }

  /**
   * Shows `filter` in a Log tab of its own, so the filters the user set up in
   * theirs survive: File History, Compare with Current and an update's Show in
   * Log. A tab already showing exactly that (the sort aside) is brought
   * forward instead of opening another, so running File History on one file
   * twice lands on the same tab.
   *
   * @param repoRoot as for `setFilter`: the repository `filter` is written for.
   */
  async openTab(filter: LogFilter, repoRoot?: string): Promise<void> {
    await vscode.commands.executeCommand('gittree.log.focus');
    for (let i = 0; i < 50 && !this.rpc; i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    const root =
      (repoRoot !== undefined ? this.core.getRepo(repoRoot)?.root : undefined) ??
      this.repoOfTab(this.tabsState.active)?.root;
    const existing = findTab(
      this.tabsState,
      filter,
      root,
      (tab) => this.rootOfTab(tab),
      (a, b) => canonicalKey(a) === canonicalKey(b),
    );
    if (existing !== undefined) {
      this.debugTrail.push(`tab reused ${existing}`);
      this.showLogTab(existing);
      return;
    }
    const opened = openTab(this.tabsState, filter, root);
    this.tabsState = opened.state;
    this.saveTabs();
    this.debugTrail.push(`tab opened ${opened.id}`);
    // The webview starts the session when it shows the tab.
    this.notifyTabs(opened.id);
  }

  /** `Paths ▾ · Roots` — show a different workspace repository in `tab`. */
  showRoot(repoRoot: string, tab: string = this.tabsState.active): boolean {
    const target = this.core.getRepo(repoRoot);
    if (!target) return false;
    const session = this.sessions.get(tab);
    const current = session?.repo.root;
    if (current !== undefined && canonicalKey(current) === canonicalKey(target.root)) return true;
    this.applyFilter(tab, rootAgnostic(session?.filter ?? DEFAULT_FILTER), target.root);
    return true;
  }

  /**
   * Re-reads a tab's history in place: the webview keeps the graph, its
   * scroll position and the selection on screen until the new rows replace
   * them, as IntelliJ's Refresh does — whether history moved under it (an
   * auto-refresh) or the user asked. Only a change of view (a filter, a root)
   * starts the list over.
   * @param tab the Log tab to re-read; the active one by default.
   * @returns false when the tab has nothing to re-read yet.
   */
  refresh(tab: string = this.tabsState.active): boolean {
    const session = this.sessions.get(tab);
    if (!session) return false;
    session.dirty = false;
    // Dropping the page cache is what makes a refresh mean "re-read": the key
    // follows HEAD and the refs the model has seen, not what changed on disk
    // behind the watcher's back.
    session.service.invalidate();
    this.applyFilter(tab, session.filter, undefined, { preserve: true });
    return true;
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
    // Only the tab on show re-pages: the others are `dirty` and re-page when
    // they are brought forward (`onActivated`).
    const session = this.session;
    if (!session?.dirty) return;
    // A git operation is still running in this repository: wait for it to
    // finish, so its several history moves are one re-read, not a flicker each.
    if (session.repo.queue.isMutationActive) {
      this.autoRefreshWaitStart ??= Date.now();
      if (Date.now() - this.autoRefreshWaitStart < AUTO_REFRESH_MAX_WAIT_MS) {
        this.scheduleAutoRefresh();
        return;
      }
    }
    this.autoRefreshWaitStart = undefined;
    this.autoRefreshCount++;
    this.debugTrail.push('auto-refresh');
    this.refresh(session.tab);
  }

  /** The active Log tab, as the integration tests and commit actions read it. */
  get currentSession():
    | { repoRoot: string; filter: LogFilter; rowCount: number; roots: LogRootDto[]; logTab: string }
    | undefined {
    return this.session
      ? {
          repoRoot: this.session.repo.root,
          filter: this.session.filter,
          rowCount: this.session.rows.length,
          roots: this.roots(),
          logTab: this.session.tab,
        }
      : undefined;
  }

  /**
   * The Log tabs, as the integration tests read them: their ids, the active
   * one, and the repository each one names when the strip has to say.
   */
  get logTabs(): { tabs: readonly string[]; active: string; repos: Readonly<Record<string, string>> } {
    const repos: Record<string, string> = {};
    for (const tab of this.tabsDto().tabs) if (tab.repo !== undefined) repos[tab.id] = tab.repo;
    return { tabs: this.tabsState.tabs.map((tab) => tab.id), active: this.tabsState.active, repos };
  }

  /**
   * Brings a Log tab forward: commands act on it from now on, and the strip
   * shows it. A command finding its tab already open, and a test putting the
   * Log back as it found it.
   * @returns false when there is no such tab.
   */
  showLogTab(id: string): boolean {
    if (!this.tabsState.tabs.some((tab) => tab.id === id)) return false;
    this.tabsState = activateTab(this.tabsState, id);
    this.saveTabs();
    this.notifyTabs(id);
    this.onActivated(id);
    return true;
  }

  /**
   * Closes extra Log tabs: the strip's `×` and Close Tab, and a test putting
   * the Log back as it found it. The main tab never closes; if the active
   * tab goes, the main tab is active.
   * @returns false when none of `ids` was a tab that could close.
   */
  closeLogTabs(ids: readonly string[]): boolean {
    const next = closeTabs(this.tabsState, ids);
    if (next === this.tabsState) return false;
    for (const id of ids) if (isClosable(id)) this.dropSession(id);
    this.tabsState = next;
    this.saveTabs();
    this.debugTrail.push(`tabs closed ${ids.join(',')}`);
    // No `onActivated` here: the strip says which tab it brings forward next
    // (`activateTab`), and re-paging the fallback first would be wasted.
    this.notifyTabs();
    return true;
  }

  // ---- pickers (host-side QuickPicks/InputBoxes) ----------------------------
  // P12-T5 replaced the branch chip with the in-webview `Branch ▾` dropdown,
  // which owns both presets (`HEAD (Current)`, `All branches`); the QuickPick
  // that used to back it had no callers left and is gone.

  private async pickAuthors(tab: string): Promise<{ ok: boolean }> {
    const session = this.sessions.get(tab);
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
    this.applyFilter(tab, next);
    return { ok: true };
  }

  private async pickDates(tab: string): Promise<{ ok: boolean }> {
    const session = this.sessions.get(tab);
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
    this.applyFilter(tab, next);
    return { ok: true };
  }

  /** `Paths ▾ · Select…` — the reference's file chooser. */
  private async pickPaths(tab: string): Promise<{ ok: boolean }> {
    const session = this.sessions.get(tab);
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
    this.applyFilter(tab, next);
    return { ok: true };
  }

  /**
   * `Paths ▾ · Select in Tree…` — tick paths out of the repository's own tree.
   *
   * A QuickPick cannot expand nodes, so `buildPathTree` supplies tree *order*
   * and depth and the label indents by it; typing filters the whole tree,
   * which is what the chooser is for anyway.
   */
  private async pickPathsInTree(tab: string): Promise<{ ok: boolean }> {
    const session = this.sessions.get(tab);
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
    this.applyFilter(tab, next);
    return { ok: true };
  }

  // ---- diffs ----------------------------------------------------------------

  /**
   * `shas` newest first, as the graph shows them. Commits no longer loaded
   * keep their relative order behind the loaded ones.
   */
  private newestFirst(session: Session, shas: readonly string[]): string[] {
    const order = new Map(session.rows.map((r, i) => [r.sha, i] as const));
    return [...new Set(shas)].sort(
      (a, b) => (order.get(a) ?? Number.MAX_SAFE_INTEGER) - (order.get(b) ?? Number.MAX_SAFE_INTEGER),
    );
  }

  /**
   * The Changed Files of several commits: IntelliJ's merge of their own
   * changes (`zipChanges`), oldest commit first. The first thousand commits
   * count, IntelliJ's `MAX_SELECTED_COMMITS`.
   */
  private async zippedFiles(session: Session, newestFirst: readonly string[]): Promise<CommitFileDto[]> {
    const shas = newestFirst.slice(0, MAX_SELECTED_COMMITS);
    const perCommit = await session.service.getCommitsFiles([...shas].reverse());
    return zipChanges(perCommit).map((f) => ({
      status: f.status,
      path: f.path,
      ...(f.origPath !== undefined ? { origPath: f.origPath } : {}),
      ...(f.before !== undefined ? { before: f.before } : {}),
      ...(f.after !== undefined ? { after: f.after } : {}),
    }));
  }

  private async openFileDiff(
    tab: string,
    sha: string,
    file: CommitFileDto,
    files: readonly CommitFileDto[],
    browsing: boolean,
  ): Promise<void> {
    const session = this.sessions.get(tab);
    if (!session) return;
    const repoRoot = session.repo.root;
    // One commit diffs against its parent. A file from several selected
    // commits carries its own two ends: before the earliest of them that
    // touched it, after the latest.
    const beforeOf = (f: CommitFileDto): string => f.before ?? `${sha}^`;
    const afterOf = (f: CommitFileDto): string => f.after ?? sha;
    const short = (rev: string): string => (rev.endsWith('^') ? `${rev.slice(0, 7)}^` : rev.slice(0, 7));
    const titleOf = (f: CommitFileDto): string =>
      `${path.posix.basename(f.path)} (${
        f.before !== undefined || f.after !== undefined
          ? `${short(beforeOf(f))}..${short(afterOf(f))}`
          : sha.slice(0, 7)
      })`;
    // P14-T7: open through the sequence, not as a standalone pair. The pane the
    // user clicked in IS the sequence, so "next change" can leave this file for
    // the next one instead of wrapping to the top of it. An added or a deleted
    // file is a stop like any other: the side it lacks reads as empty, and a
    // plain document would have no next-change button to carry on with.
    const p14 = this.core.debugRegistry.get('phase14') as
      | { sessions: Pick<DiffSessionRegistry, 'open'> }
      | undefined;
    const entries: DiffEntry[] = files.map((f) => ({
      original: makeRevUri(repoRoot, f.origPath ?? f.path, beforeOf(f)),
      modified: makeRevUri(repoRoot, f.path, afterOf(f)),
      title: titleOf(f),
      label: f.path,
      identical: hasIdenticalSides(f.status),
      onShown: () => {
        this.rpc?.notify(LOG_METHODS.evtDiffFile, { logTab: tab, sha, path: f.path });
      },
    }));
    const index = Math.max(
      0,
      files.findIndex((f) => f.path === file.path),
    );
    if (p14) {
      await p14.sessions.open(entries, index, { preserveFocus: browsing });
      return;
    }
    await vscode.commands.executeCommand(
      'vscode.diff',
      entries[index]!.original,
      entries[index]!.modified,
      entries[index]!.title,
    );
  }

  private async openAllDiffs(tab: string, sha: string, shas: readonly string[] = []): Promise<void> {
    const session = this.sessions.get(tab);
    if (!session) return;
    if (shas.length > 1) {
      // Several commits: the same merged changes the pane lists, in one editor.
      const sorted = this.newestFirst(session, shas);
      const files = await this.zippedFiles(session, sorted);
      const root = session.repo.root;
      const changes: [vscode.Uri, vscode.Uri | undefined, vscode.Uri | undefined][] = files.map((f) => [
        vscode.Uri.file(path.join(root, f.path)),
        f.before !== undefined ? makeRevUri(root, f.origPath ?? f.path, f.before) : undefined,
        f.after !== undefined ? makeRevUri(root, f.path, f.after) : undefined,
      ]);
      await vscode.commands.executeCommand(
        'vscode.changes',
        vscode.l10n.t('{0} Commits', sorted.length),
        changes,
      );
      return;
    }
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
 * text query, the sort order and the Graph Options are portable, so they
 * survive.
 */
function rootAgnostic(filter: LogFilter): LogFilter {
  const next: LogFilter = { ...filter };
  delete next.paths;
  delete next.follow;
  delete next.range;
  if (Array.isArray(next.refs)) next.refs = 'HEAD';
  return next;
}
