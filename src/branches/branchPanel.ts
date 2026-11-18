/**
 * The side bar's Repositories and Branches panels (new-way-4; one panel, titled
 * Repositories, until POST-P14co split it in two): together they answer, for
 * every repository at once, "where am I, what is waiting, and where can I go".
 *
 * - **Repositories** (`gittree.repositoryList`): a filter of them by name and
 *   Fetch (every repository) beside it (POST-P14cp), then every repository the
 *   filter matches, with what it has checked out, its counts, its buttons and
 *   its menu; a click picks it. Only with several repositories
 *   (`gittree.multiRepo`).
 * - **Branches** (`gittree.branches`, the old panel's id, so a layout or a
 *   keybinding made before keeps working): the filter (whose `@` picks
 *   repositories), New Branch and the rest of the toolbar, then the branches
 *   under their tabs. With one repository it starts with its current branch,
 *   and its toolbar has Fetch.
 *
 * **The host owns the facts; the webviews own the view.** This side builds one
 * state object from the snapshots the status refresher keeps, plus the two
 * things that cost git — the recent branches (the reflog) and which branches
 * are merged — and pushes it to both panels whenever any repository moves.
 * Filtering, folding and the open card are a page's: none of them needs git, so
 * none of them waits on a round trip. The repositories picked are kept here
 * since POST-P14ce (`reposInView.ts`), because the Commit window follows them:
 * a page changes its copy at once and tells this side, which tells the other
 * panel, and both of a pick made elsewhere.
 *
 * Actions come from the shared registry through `panelActions.ts`; a card's
 * extra facts (author, how the branch stands against HEAD) are read when the
 * card opens, since they cost git per branch and nobody wants them for all.
 */
import * as vscode from 'vscode';
import { writeSetting } from '../ui/writeSetting';
import type { Core, RepoHandle } from '../core/core';
import { canonicalKey } from '../core/repoDiscovery';
import { repoLabels, sortRootsByLabel } from '../core/util/repoLabels';
import { rootColorIndices } from '../log/graphLayout/colors';
import {
  BRANCHES_METHODS,
  type BranchPanelCreateDto,
  type BranchPanelCreateResultDto,
  type BranchPanelDetailsDto,
  type BranchPanelInitialStateDto,
  type BranchPanelMenuItemDto,
  type BranchPanelRepoDetailsDto,
  type BranchPanelRole,
  type BranchPanelRunDto,
  type BranchPanelSettingKey,
  type BranchPanelStateDto,
  type BranchPanelTargetDto,
} from '../shared/protocol';
import { buildWebviewHtml, webviewResourceRoots, WebviewRpcHost } from '../ui/webviewHost';
import type { BranchAction } from './branchActions';
import { createBranches } from './createBranches';
import {
  branchMenu,
  cardButtons,
  headName,
  refIn,
  reposOf,
  repositoryMenu,
  runPanel,
  type PanelActionDeps,
} from './panelActions';
import { buildRepoDto, mainBranchOf, mergedArgs, mergedBranches } from './panelState';
import type { RefService } from './refService';
import type { ReposInView } from './reposInView';
import { showTagsSetting } from './showTags';
import { INTELLIJ_KEYMAP_SETTING } from '../ui/accelerators';

export interface BranchPanelDeps {
  readonly core: Core;
  readonly context: vscode.ExtensionContext;
  readonly refServiceFor: (repo: RepoHandle) => RefService;
  readonly actions: readonly BranchAction[];
  /** The drop prompt the branch trees use: merge, rebase or compare. */
  readonly onDrop: (repo: RepoHandle, source: string, target: string) => Promise<void>;
  /** POST-P14ce: the repositories picked, which the Commit window follows too. */
  readonly reposInView: ReposInView;
}

/** Bursts of model events (a checkout fires several) become one push. */
const PUSH_DEBOUNCE_MS = 80;

const SETTING_KEYS: Record<BranchPanelSettingKey, string> = {
  showTags: 'showTags',
  showIncomingOutgoing: 'showIncomingOutgoing',
  groupByFolder: 'groupByFolder',
  showRepositoryDots: 'showRepositoryDots',
};

function isTarget(value: unknown): value is BranchPanelTargetDto {
  if (typeof value !== 'object' || value === null) return false;
  const t = value as Partial<BranchPanelTargetDto>;
  return (
    (t.kind === 'local' || t.kind === 'remote' || t.kind === 'tag') &&
    typeof t.name === 'string' &&
    Array.isArray(t.roots) &&
    t.roots.every((r) => typeof r === 'string')
  );
}

/** The repositories in view, as the webview sends them; anything else is no scope. */
function scopeOf(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const roots = raw.filter((r): r is string => typeof r === 'string');
  return roots.length > 0 ? roots : undefined;
}

/** One of the two panels' pages, as this side holds it. */
interface PanelPage {
  readonly role: BranchPanelRole;
  view: vscode.WebviewView | undefined;
  rpc: WebviewRpcHost | undefined;
  /** The webview has asked for its first state, so it is listening for events. */
  ready: boolean;
  /** What the webview should do once it is listening: a form asked for before it was. */
  pending: Array<{ method: string; params: unknown }>;
}

function newPage(role: BranchPanelRole): PanelPage {
  return { role, view: undefined, rpc: undefined, ready: false, pending: [] };
}

export class BranchPanelProvider {
  /** The Branches panel: the old one-panel id, kept so layouts and keybindings carry over. */
  static readonly viewType = 'gittree.branches';
  /** POST-P14co: the Repositories panel. */
  static readonly repositoriesViewType = 'gittree.repositoryList';

  /** The view each panel is drawn in. */
  static viewTypeOf(role: BranchPanelRole): string {
    return role === 'repositories' ? BranchPanelProvider.repositoriesViewType : BranchPanelProvider.viewType;
  }

  private readonly pages: Readonly<Record<BranchPanelRole, PanelPage>> = {
    repositories: newPage('repositories'),
    branches: newPage('branches'),
  };
  private readonly watches = new Map<string, vscode.Disposable>();
  private readonly subs: vscode.Disposable[] = [];
  /** Roots (canonical keys) with a fetch from this panel running. */
  private readonly fetching = new Set<string>();
  private fetchingAll = false;
  private pushTimer: ReturnType<typeof setTimeout> | undefined;
  private generation = 0;

  private readonly recentCache = new Map<string, { key: string; names: readonly string[] }>();
  private readonly mergedCache = new Map<
    string,
    { key: string; main: string | undefined; names: readonly string[] }
  >();
  private readonly detailsCache = new Map<string, BranchPanelRepoDetailsDto>();
  /** The last state built: what menus and buttons read merged-ness and favourites from. */
  private last: BranchPanelStateDto | undefined;

  constructor(private readonly deps: BranchPanelDeps) {
    this.rewatch();
    const { core } = deps;
    this.subs.push(
      toDisposable(core.onDidAddRepo(() => this.onRepos())),
      toDisposable(core.onDidRemoveRepo(() => this.onRepos())),
      // POST-P14ce: a pick made elsewhere (the Commit window's Show all, Show
      // Only This Repository; POST-P14co: the other panel). A panel already
      // shows a pick it made itself. Before a page listens, its first state
      // carries the pick instead.
      toDisposable(
        deps.reposInView.onDidChange((source) => {
          for (const page of this.listening()) {
            if (page.role === source) continue;
            page.rpc?.notify(BRANCHES_METHODS.evtScope, { roots: deps.reposInView.picked });
          }
        }),
      ),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (
          e.affectsConfiguration('gittree.branches') ||
          e.affectsConfiguration('gittree.log.graphPalette') ||
          e.affectsConfiguration(`gittree.${INTELLIJ_KEYMAP_SETTING}`)
        ) {
          this.schedulePush();
        }
      }),
    );
  }

  private onRepos(): void {
    this.rewatch();
    this.schedulePush();
  }

  private rewatch(): void {
    const live = new Set(this.deps.core.repos.map((r) => r.root));
    for (const [root, sub] of [...this.watches]) {
      if (live.has(root)) continue;
      sub.dispose();
      this.watches.delete(root);
      this.recentCache.delete(root);
      this.mergedCache.delete(root);
    }
    for (const repo of this.deps.core.repos) {
      if (this.watches.has(repo.root)) continue;
      // Every section moves something the panel shows: refs and head the
      // rows, status the change counts, op the in-progress banner.
      const modelSub = repo.model.onDidChange(() => this.schedulePush());
      const favSub = this.deps.refServiceFor(repo).onDidChangeFavorites(() => this.schedulePush());
      this.watches.set(repo.root, {
        dispose: () => {
          modelSub.dispose();
          favSub.dispose();
        },
      });
    }
  }

  // ---- the views -----------------------------------------------------------

  /**
   * What VS Code calls to draw one of the two panels (POST-P14co). Both are the
   * same webview app, told which panel it is by its page.
   */
  providerFor(role: BranchPanelRole): vscode.WebviewViewProvider {
    return { resolveWebviewView: (view) => this.resolve(role, view) };
  }

  private resolve(role: BranchPanelRole, view: vscode.WebviewView): void {
    const page = this.pages[role];
    page.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: webviewResourceRoots(this.deps.context.extensionUri),
    };
    view.webview.html = buildWebviewHtml({
      app: 'branches',
      webview: view.webview,
      extensionUri: this.deps.context.extensionUri,
      title: role === 'repositories' ? vscode.l10n.t('Repositories') : vscode.l10n.t('Branches'),
      initialState: { role } satisfies BranchPanelInitialStateDto,
    });
    const rpc = new WebviewRpcHost(view.webview, (l) => this.deps.core.output.appendLine(`[${role}] ${l}`));
    page.rpc = rpc;
    this.wire(rpc, page);
    view.onDidDispose(() => {
      rpc.dispose();
      page.rpc = undefined;
      page.view = undefined;
      page.ready = false;
    });
    view.onDidChangeVisibility(() => {
      if (!view.visible) return;
      rpc.rehydrate();
      this.schedulePush();
    });
  }

  /** The pages that have asked for their first state, and so hear events. */
  private listening(): PanelPage[] {
    return Object.values(this.pages).filter((page) => page.rpc !== undefined && page.ready);
  }

  private schedulePush(): void {
    if (this.pushTimer !== undefined) clearTimeout(this.pushTimer);
    this.pushTimer = setTimeout(() => {
      this.pushTimer = undefined;
      void this.push();
    }, PUSH_DEBOUNCE_MS);
  }

  /** One state, built once, for every panel on screen; a hidden one gets it when it shows. */
  private async push(): Promise<void> {
    const shown = Object.values(this.pages).filter((page) => page.rpc !== undefined && page.view?.visible === true);
    if (shown.length === 0) return;
    const mine = ++this.generation;
    const state = await this.buildState();
    // A newer build started while this one waited on git: it wins.
    if (mine !== this.generation) return;
    for (const page of shown) page.rpc?.notify(BRANCHES_METHODS.evtState, state);
  }

  // ---- state ---------------------------------------------------------------

  /** The whole panel's facts, as of now. Public for the integration tests. */
  async buildState(): Promise<BranchPanelStateDto> {
    const { core } = this.deps;
    const roots = core.repos.map((r) => r.root);
    const labels = repoLabels(roots);
    const colors = rootColorIndices(roots);
    const repos = await Promise.all(
      sortRootsByLabel(roots).map(async (root) => {
        const repo = core.getRepo(root)!;
        const [favorites, recent, merged] = await Promise.all([
          this.deps
            .refServiceFor(repo)
            .getFavorites()
            .catch(() => new Set<string>()),
          this.recentOf(repo),
          this.mergedOf(repo),
        ]);
        return buildRepoDto({
          root,
          label: labels.get(root) ?? root,
          colorIdx: colors.get(root) ?? 0,
          snapshot: repo.model.snapshot,
          recent,
          favorites,
          ...(merged.main !== undefined ? { mainBranch: merged.main } : {}),
          merged: merged.names,
          fetching: this.fetching.has(canonicalKey(root)),
        });
      }),
    );
    const cfg = vscode.workspace.getConfiguration('gittree.branches');
    const state: BranchPanelStateDto = {
      repos,
      showTags: showTagsSetting(),
      showInOut: cfg.get<boolean>('showIncomingOutgoing', true),
      groupByFolder: cfg.get<boolean>('groupByFolder', true),
      showRepositoryDots: cfg.get<boolean>('showRepositoryDots', false),
      fetchingAll: this.fetchingAll,
      now: Math.floor(Date.now() / 1000),
      palette:
        vscode.workspace.getConfiguration('gittree.log').get<string>('graphPalette') === 'colorBlind'
          ? 'colorBlind'
          : 'default',
      intellijKeymap: vscode.workspace.getConfiguration('gittree').get<boolean>(INTELLIJ_KEYMAP_SETTING, false),
      // Read once the awaits above are over, so a push built across a pick
      // carries the pick as it is when it is sent, never as it was.
      scope: this.deps.reposInView.picked,
    };
    this.last = state;
    return state;
  }

  /** Reflog reads are cached until HEAD or a ref moves — a checkout is what changes them. */
  private async recentOf(repo: RepoHandle): Promise<readonly string[]> {
    const snap = repo.model.snapshot;
    const key = `${snap.headRef ?? ''}|${snap.headSha ?? ''}|${repo.model.refsGeneration}`;
    const cached = this.recentCache.get(repo.root);
    if (cached?.key === key) return cached.names;
    let names: readonly string[] = [];
    try {
      names = await this.deps.refServiceFor(repo).getRecentBranches();
    } catch {
      // A repository with no reflog yet has no recent branches; nothing to say.
    }
    this.recentCache.set(repo.root, { key, names });
    return names;
  }

  /** Which local branches have reached the main branch; re-read when refs move. */
  private async mergedOf(
    repo: RepoHandle,
  ): Promise<{ main: string | undefined; names: readonly string[] }> {
    const snap = repo.model.snapshot;
    const main = mainBranchOf(snap.refs);
    const key = `${repo.model.refsGeneration}|${main ?? ''}`;
    const cached = this.mergedCache.get(repo.root);
    if (cached?.key === key) return cached;
    let names: readonly string[] = [];
    if (main !== undefined) {
      try {
        const res = await repo.queue.enqueue({
          label: 'merged branches',
          kind: 'read',
          run: (git, token) =>
            git.exec(repo.root, mergedArgs(main), {
              structured: true,
              noOptionalLocks: true,
              allowNonZeroExit: true,
              token,
            }),
        });
        if (res.exitCode === 0) names = mergedBranches(res.stdout, snap.refs, main);
      } catch {
        // Cancelled by a mutation: the push after it asks again.
      }
    }
    const entry = { key, main, names };
    this.mergedCache.set(repo.root, entry);
    return entry;
  }

  private actionDeps(): PanelActionDeps {
    const byRoot = new Map((this.last?.repos ?? []).map((r) => [canonicalKey(r.root), r]));
    const labels = repoLabels(this.deps.core.repos.map((r) => r.root));
    return {
      core: this.deps.core,
      actions: this.deps.actions,
      labelOf: (root) => labels.get(root) ?? root,
      mergedIn: (root) => new Set(byRoot.get(canonicalKey(root))?.merged ?? []),
      isFavorite: (root, branch) =>
        byRoot.get(canonicalKey(root))?.favorites.includes(branch) ?? false,
    };
  }

  // ---- a card's facts --------------------------------------------------------

  /** The author and HEAD-relation of a ref in each of its repositories, and the card's buttons. */
  async details(target: BranchPanelTargetDto, scope?: readonly string[]): Promise<BranchPanelDetailsDto> {
    if (this.last === undefined) await this.buildState();
    const repos = await Promise.all(
      reposOf(this.deps.core, target.roots).map((repo) => this.repoDetails(repo, target)),
    );
    return {
      repos: repos.filter((r): r is BranchPanelRepoDetailsDto => r !== undefined),
      buttons: cardButtons(this.actionDeps(), target, scope),
    };
  }

  private async repoDetails(
    repo: RepoHandle,
    target: BranchPanelTargetDto,
  ): Promise<BranchPanelRepoDetailsDto | undefined> {
    const ref = refIn(repo, target.kind, target.name);
    if (!ref) return undefined;
    const snap = repo.model.snapshot;
    // Which local branch tracks a remote one changes without either moving:
    // read it fresh, it is in the snapshot already.
    const trackedBy =
      ref.type === 'remote'
        ? snap.refs.find((r) => r.type === 'head' && r.upstream === ref.name)?.name
        : undefined;
    const withTracking = (d: BranchPanelRepoDetailsDto): BranchPanelRepoDetailsDto =>
      trackedBy !== undefined ? { ...d, trackedBy } : d;
    // HEAD's name is in the key as well as its sha: two branches can share a commit.
    const key = `${repo.root}|${ref.fullName}|${ref.sha}|${snap.headSha ?? ''}|${snap.headRef ?? ''}`;
    const cached = this.detailsCache.get(key);
    if (cached) return withTracking(cached);
    const isCurrent = ref.type === 'head' && ref.isHead;
    const read = (args: string[]) =>
      repo.queue.enqueue({
        label: 'branch card',
        kind: 'read',
        run: (git, token) =>
          git.exec(repo.root, args, {
            structured: true,
            noOptionalLocks: true,
            allowNonZeroExit: true,
            token,
          }),
      });
    try {
      const [log, counts] = await Promise.all([
        read(['log', '-1', '--format=%an%x00%ct', ref.sha]),
        isCurrent || snap.initial || snap.headSha === undefined
          ? Promise.resolve(undefined)
          : read(['rev-list', '--left-right', '--count', `HEAD...${ref.sha}`]),
      ]);
      const [author, ct] = log.exitCode === 0 ? log.stdout.trim().split('\0') : [];
      const date = Number.parseInt(ct ?? '', 10);
      let vsHead: BranchPanelRepoDetailsDto['vsHead'];
      if (counts?.exitCode === 0) {
        const [behind, ahead] = counts.stdout.trim().split(/\s+/u).map((n) => Number.parseInt(n, 10));
        if (Number.isFinite(ahead) && Number.isFinite(behind)) {
          vsHead = { head: headName(repo), ahead: ahead!, behind: behind! };
        }
      }
      const details: BranchPanelRepoDetailsDto = {
        root: repo.root,
        ...(author !== undefined && author.length > 0 ? { author } : {}),
        ...(Number.isFinite(date) ? { date } : {}),
        ...(vsHead !== undefined ? { vsHead } : {}),
      };
      this.detailsCache.set(key, details);
      if (this.detailsCache.size > 200) {
        const oldest = this.detailsCache.keys().next().value;
        if (oldest !== undefined) this.detailsCache.delete(oldest);
      }
      return withTracking(details);
    } catch {
      // A mutation cancelled the read; the card shows what it has.
      return withTracking({ root: repo.root });
    }
  }

  // ---- gestures --------------------------------------------------------------

  private wire(rpc: WebviewRpcHost, page: PanelPage): void {
    rpc.on(BRANCHES_METHODS.init, async (params) => {
      // POST-P14ce: the pick the panel kept itself until now, adopted once.
      this.deps.reposInView.adoptLegacy((params as { scope?: unknown } | undefined)?.scope);
      const state = await this.buildState();
      // Asked for before the webview listened: deliver once it can hear —
      // after this answer, which is posted first.
      page.ready = true;
      const queued = page.pending;
      page.pending = [];
      setTimeout(() => {
        for (const { method, params } of queued) page.rpc?.notify(method, params);
      }, 0);
      return state;
    });

    rpc.on(BRANCHES_METHODS.details, async (params) => {
      const p = params as { target?: unknown; scope?: unknown } | undefined;
      return isTarget(p?.target) ? this.details(p.target, scopeOf(p.scope)) : { repos: [], buttons: [] };
    });

    rpc.on(BRANCHES_METHODS.menu, async (params) => {
      const p = params as { target?: unknown; root?: unknown; scope?: unknown } | undefined;
      if (isTarget(p?.target)) return this.menu({ target: p.target, scope: scopeOf(p.scope) });
      if (typeof p?.root === 'string') return this.menu({ root: p.root });
      return [];
    });

    rpc.on(BRANCHES_METHODS.run, async (params) => {
      const run = (params as { run?: BranchPanelRunDto } | undefined)?.run;
      if (run === undefined || typeof run !== 'object') return null;
      await this.run(run);
      return null;
    });

    rpc.on(BRANCHES_METHODS.favorite, async (params) => {
      const p = params as { target?: unknown; on?: unknown } | undefined;
      if (!isTarget(p?.target) || p.target.kind !== 'local' || typeof p.on !== 'boolean') return null;
      for (const repo of reposOf(this.deps.core, p.target.roots)) {
        const service = this.deps.refServiceFor(repo);
        const favorites = await service.getFavorites();
        if (favorites.has(p.target.name) !== p.on) await service.toggleFavorite(p.target.name);
      }
      return null;
    });

    rpc.on(BRANCHES_METHODS.create, async (params) => {
      const p = params as Partial<BranchPanelCreateDto> | undefined;
      if (
        typeof p?.name !== 'string' ||
        typeof p.from !== 'string' ||
        !Array.isArray(p.roots) ||
        typeof p.checkout !== 'boolean'
      ) {
        return { ok: false, error: vscode.l10n.t('The form was incomplete.') };
      }
      return this.create({
        name: p.name,
        from: p.from,
        roots: p.roots.filter((r): r is string => typeof r === 'string'),
        checkout: p.checkout,
      });
    });

    rpc.on(BRANCHES_METHODS.setting, async (params) => {
      const p = params as { key?: unknown; value?: unknown } | undefined;
      const key = typeof p?.key === 'string' ? SETTING_KEYS[p.key as BranchPanelSettingKey] : undefined;
      if (key === undefined || typeof p?.value !== 'boolean') return null;
      await writeSetting('gittree.branches', key, p.value);
      return null;
    });

    rpc.on(BRANCHES_METHODS.fetchAll, async () => {
      await this.fetchAll();
      return null;
    });

    rpc.on(BRANCHES_METHODS.drop, async (params) => {
      const p = params as { source?: unknown; target?: unknown } | undefined;
      if (!isTarget(p?.source) || !isTarget(p.target)) return null;
      await this.drop(p.source, p.target);
      return null;
    });

    // POST-P14ce: a click, Ctrl+click, Show Only This Repository or Show all in
    // the panel; POST-P14co: the Branches panel's `@` picker and pill. Kept for
    // the Commit window and the other panel, which follow it; answered with the
    // pick as kept (every open repository picked is none).
    rpc.on(BRANCHES_METHODS.setScope, (params) => {
      const roots = (params as { roots?: unknown } | undefined)?.roots;
      if (Array.isArray(roots)) this.deps.reposInView.set(roots, page.role);
      return { roots: this.deps.reposInView.picked };
    });
  }

  /** The New Branch form, submitted. */
  async create(request: BranchPanelCreateDto): Promise<BranchPanelCreateResultDto> {
    const labels = repoLabels(this.deps.core.repos.map((r) => r.root));
    return createBranches(this.deps.core, request, (root) => labels.get(root) ?? root);
  }

  /** A branch's menu, or a repository's: what right-click and `⋯` show. Public for the tests. */
  async menu(
    of: { target: BranchPanelTargetDto; scope?: readonly string[] } | { root: string },
  ): Promise<BranchPanelMenuItemDto[]> {
    if (this.last === undefined) await this.buildState();
    if ('target' in of) return branchMenu(this.actionDeps(), of.target, of.scope);
    return this.deps.core.getRepo(of.root) ? repositoryMenu(of.root, this.deps.core.repos.length) : [];
  }

  /** Runs what a menu entry, a card button or a row button asked for. */
  async run(run: BranchPanelRunDto): Promise<void> {
    if (run.type === 'command' && run.command === 'gittree.fetch' && run.root !== undefined) {
      // Not awaited by the request: a fetch outlasts its timeout, and the row
      // shows its own progress.
      void this.fetchRepository(run.root);
      return;
    }
    if (run.type === 'newBranch') {
      // POST-P14co: asked in the Repositories panel (a repository's New
      // Branch…), which has no form: the Branches panel's opens. The Branches
      // panel opens its own without asking.
      await this.openNewBranchForm(run.from, run.roots);
      return;
    }
    try {
      await runPanel(this.actionDeps(), run);
    } catch (err) {
      // Elsewhere VS Code reports a failed command; here the failure would stop
      // at the webview, which can only stop its button turning. Not awaited: the
      // answer tells that button the action is over, and a toast stays open.
      const reason = (err instanceof Error ? err.message : String(err)).split('\n', 1)[0] ?? '';
      void vscode.window.showErrorMessage(reason);
    }
  }

  /** One repository's fetch; its row spins until it is done. A second click is dropped. */
  private async fetchRepository(root: string): Promise<void> {
    const key = canonicalKey(root);
    if (this.fetching.has(key)) return;
    this.fetching.add(key);
    this.schedulePush();
    try {
      await vscode.commands.executeCommand('gittree.fetch', root);
    } catch (err) {
      this.deps.core.output.appendLine(`[branches] fetch ${root} failed: ${String(err)}`);
    } finally {
      this.fetching.delete(key);
      this.schedulePush();
    }
  }

  /**
   * Every repository's fetch: the Fetch button's, beside the Repositories
   * panel's filter (POST-P14cp), or with one repository in the Branches panel's toolbar.
   */
  async fetchAll(): Promise<void> {
    if (this.fetchingAll) return;
    this.fetchingAll = true;
    this.schedulePush();
    try {
      await vscode.commands.executeCommand('gittree.fetch');
    } catch (err) {
      this.deps.core.output.appendLine(`[branches] fetch all failed: ${String(err)}`);
    } finally {
      this.fetchingAll = false;
      this.schedulePush();
    }
  }

  /**
   * A branch dropped on another: the merge / rebase / compare prompt the
   * branch trees use, in the one repository both are in. Where they share
   * several, the user says which — merging in every repository at once is an
   * operation for the menu, which says so in its label, not for a drag.
   */
  private async drop(source: BranchPanelTargetDto, target: BranchPanelTargetDto): Promise<void> {
    if (source.kind !== 'local' || target.kind !== 'local' || source.name === target.name) return;
    const shared = target.roots.filter((r) => source.roots.some((s) => canonicalKey(s) === canonicalKey(r)));
    const repos = reposOf(this.deps.core, shared);
    if (repos.length === 0) return;
    let repo = repos[0]!;
    if (repos.length > 1) {
      const labels = repoLabels(this.deps.core.repos.map((r) => r.root));
      const picked = await vscode.window.showQuickPick(
        repos.map((r) => ({ label: labels.get(r.root) ?? r.root, repo: r })),
        { placeHolder: vscode.l10n.t('Which repository?') },
      );
      if (!picked) return;
      repo = picked.repo;
    }
    await this.deps.onDrop(repo, source.name, target.name);
  }

  /** Opens the Branches panel's New Branch form, from `from` in `roots` (the scope, when absent). */
  async openNewBranchForm(from?: string, roots?: readonly string[]): Promise<void> {
    await this.notifyWhenListening('branches', BRANCHES_METHODS.evtNewBranch, {
      ...(from !== undefined ? { from } : {}),
      ...(roots !== undefined ? { roots } : {}),
    });
  }

  /** Puts the cursor in the Branches panel's filter field: the Filter Branches command. */
  async focusFilter(): Promise<void> {
    await this.notifyWhenListening('branches', BRANCHES_METHODS.evtFocusFilter, {});
  }

  /**
   * POST-P14ce: a name on the Commit window's filter bar. The Repositories
   * panel comes into view with the keyboard on that repository's row; what is
   * picked stays as it is. (POST-P14cb's *Select in Repositories Panel*, which
   * also picked it, is now *Show Only This Repository*, and picks without
   * moving the keyboard.) The bar names repositories only while there are
   * several, which is when the Repositories panel is there.
   */
  async revealRepository(root: string): Promise<void> {
    await this.notifyWhenListening('repositories', BRANCHES_METHODS.evtRevealRepo, { root });
  }

  private async notifyWhenListening(role: BranchPanelRole, method: string, params: unknown): Promise<void> {
    try {
      await vscode.commands.executeCommand(`${BranchPanelProvider.viewTypeOf(role)}.focus`);
    } catch (err) {
      // A panel its `when` clause hides (Repositories, with one repository) has
      // nothing to bring into view; whatever it was asked waits for it.
      this.deps.core.output.appendLine(`[${role}] could not show the panel: ${String(err)}`);
    }
    const page = this.pages[role];
    if (page.rpc && page.ready) page.rpc.notify(method, params);
    else page.pending.push({ method, params });
  }

  dispose(): void {
    if (this.pushTimer !== undefined) clearTimeout(this.pushTimer);
    for (const sub of this.watches.values()) sub.dispose();
    this.watches.clear();
    for (const sub of this.subs) sub.dispose();
    this.subs.length = 0;
  }
}

function toDisposable(sub: { dispose(): void }): vscode.Disposable {
  return new vscode.Disposable(() => sub.dispose());
}
