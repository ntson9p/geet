/**
 * The Repositories panel (new-way-4; once titled Branches).
 *
 * Top to bottom: a toolbar (the filter, Fetch, New Branch, more); the New
 * Branch form while it is open; then, with several repositories, two panes
 * (new-way-6): REPOSITORIES, every repository with what it has checked out,
 * and BRANCHES, tabs over the branches — Recent (the starred and recently
 * used), Local, Remote and Tags, one kind at a time. Each pane folds at its
 * header and scrolls on its own, and the divider between them is dragged to
 * share the height; the REPOSITORIES header names the repositories picked,
 * folded or not. With one repository there is one list: its current branch,
 * then the tabs. The tabs stay at the top once the list scrolls past them,
 * and step aside while the filter searches every kind.
 *
 * **A click never changes anything.** Clicking a branch opens its card — the
 * last commit, where it stands against what it tracks and against what is
 * checked out, and the two or three actions its state calls for — and the
 * row's own buttons (on hover) and its menu (right-click, `⋯`) do the rest.
 * Clicking a repository narrows the list to it; Ctrl+click adds or removes
 * one; the scope's `×` widens it again.
 *
 * The host sends facts (`branches/state`); everything this file decides —
 * the scope, what is open, the filter — lives here, so none of it waits on a
 * round trip.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from 'react';
import {
  BRANCHES_METHODS,
  type BranchPanelButtonDto,
  type BranchPanelCreateDto,
  type BranchPanelCreateResultDto,
  type BranchPanelDetailsDto,
  type BranchPanelMenuItemDto,
  type BranchPanelRepoDto,
  type BranchPanelRunDto,
  type BranchPanelSettingKey,
  type BranchPanelStateDto,
  type BranchPanelTargetDto,
} from '../../../src/shared/protocol';
import { Menu, type MenuItem } from '../lib/Menu';
import { RpcClient } from '../lib/rpc';
import { useBusy } from '../lib/useBusy';
import { useElementSize } from '../lib/useElementSize';
import { useVsCodeTheme } from '../lib/useVsCodeTheme';
import { getVsCodeApi } from '../lib/vscodeApi';
import { laneColor } from '../log/GraphCanvas';
import {
  buildPanel,
  collapsedAll,
  scopeReposOf,
  TABS_ID,
  tabsLabel,
  targetOf,
  type BranchEntry,
  type BranchTab,
  type CardLine,
  type PanelRow,
  type PanelUiState,
  type QuickAction,
} from './model';
import { NewBranchForm, type NewBranchRequest } from './NewBranchForm';
import { PanelList, type PanelListHandle } from './PanelList';
import { PaneHeader, Sash } from './Panes';
import {
  PANE_HEADER,
  paneLayout,
  paneOpen,
  selectedRepos,
  selectionTitle,
  withPane,
  type PaneId,
} from './paneLayout';
import {
  BranchCard,
  BranchRow,
  Codicon,
  GroupRow,
  HeadRow,
  INDENT,
  OperationRow,
  RepoRow,
  RowButton,
  SectionRow,
  TabsRow,
} from './Rows';

const rpc = new RpcClient();

/** A fetch of every repository, or a checkout behind a dialog, can take minutes. */
const LONG_MS = 10 * 60_000;
/** Cards remembered; their facts cost git, and the panel re-asks when the refs move. */
const DETAILS_KEPT = 40;
const DRAG_MIME = 'application/x-gittree-branch';

interface Persisted {
  readonly scope?: readonly string[];
  readonly toggled?: readonly string[];
  /** The branch tab picked, kept until another is. */
  readonly tab?: BranchTab;
  /** The REPOSITORIES pane's height the divider was dragged to; none: the automatic one. */
  readonly reposSize?: number;
}

/** The two lists of the panes; with one repository, `branches` is the one list. */
type ListId = 'repos' | 'branches';

const TAB_ORDER: readonly BranchTab[] = ['recent', 'local', 'remote', 'tags'];

/**
 * The Repository Dots button's icon: the rows' filled and ringed dots, two by
 * two — the branches-by-repositories grid they make. A row of three would read
 * as `⋯`, the More Actions button beside it.
 */
function RepositoryDotsGlyph() {
  return (
    <svg className="gtp-dots-glyph" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
      <circle cx="4.5" cy="4.5" r="2.2" fill="currentColor" />
      <circle cx="11.5" cy="4.5" r="1.9" fill="none" stroke="currentColor" strokeWidth="1.2" />
      <circle cx="4.5" cy="11.5" r="1.9" fill="none" stroke="currentColor" strokeWidth="1.2" />
      <circle cx="11.5" cy="11.5" r="2.2" fill="currentColor" />
    </svg>
  );
}

interface OpenMenu {
  readonly items: MenuItem[];
  readonly at: { readonly x: number; readonly y: number };
  readonly label: string;
  readonly runs: ReadonlyMap<string, () => void>;
}

/** What a card's facts depend on: when any of it moves, the card asks again. */
function detailsKey(entry: BranchEntry, scope: readonly string[]): string {
  return `${entry.key}|${scope.join(',')}|${entry.presence
    .map(
      (p) =>
        `${p.repo.root}@${p.ref.sha}:${p.repo.headSha ?? ''}:${p.repo.head ?? ''}:${p.ref.current === true ? 1 : 0}:${
          p.repo.merged.includes(entry.name) ? 1 : 0
        }:${p.ref.gone === true ? 1 : 0}:${p.ref.upstream ?? ''}`,
    )
    .join(',')}`;
}

/** No group opened: one set, so the model is not rebuilt for a new empty one. */
const NO_GROUPS: ReadonlySet<string> = new Set();

function rowRect(id: string): DOMRect | undefined {
  return document.querySelector(`[data-row-id="${CSS.escape(id)}"]`)?.getBoundingClientRect();
}

export function App() {
  const api = useMemo(() => getVsCodeApi(), []);
  const saved = useMemo(() => (api.getState() as Persisted | undefined) ?? {}, [api]);

  const [state, setState] = useState<BranchPanelStateDto | null>(null);
  const [query, setQuery] = useState('');
  const [scope, setScope] = useState<readonly string[]>(() => saved.scope ?? []);
  const [toggled, setToggled] = useState<ReadonlySet<string>>(() => new Set(saved.toggled ?? []));
  const [tab, setTab] = useState<BranchTab | undefined>(() =>
    saved.tab !== undefined && TAB_ORDER.includes(saved.tab) ? saved.tab : undefined,
  );
  const [openCard, setOpenCard] = useState<string | undefined>(undefined);
  /**
   * Groups opened to list their repositories, and the card they belong to. A
   * card however it opens (the filter's Enter included) starts with none: the
   * keys are what a group's repositories say, which another card can share.
   */
  const [groupsOpen, setGroupsOpen] = useState<
    { readonly card: string; readonly keys: ReadonlySet<string> } | undefined
  >(undefined);
  const openGroups = useMemo(
    () => (groupsOpen !== undefined && groupsOpen.card === openCard ? groupsOpen.keys : NO_GROUPS),
    [groupsOpen, openCard],
  );
  /** Each list's keyboard row, kept while the other list has the focus. */
  const [repoFocusId, setRepoFocusId] = useState<string | undefined>(undefined);
  const [branchFocusId, setBranchFocusId] = useState<string | undefined>(undefined);
  /** The list the keyboard was in last: where Escape in the filter goes back to. */
  const [lastList, setLastList] = useState<ListId | undefined>(undefined);
  const [reposSize, setReposSize] = useState<number | undefined>(() =>
    typeof saved.reposSize === 'number' && Number.isFinite(saved.reposSize) ? saved.reposSize : undefined,
  );
  /** The REPOSITORIES list's height while the divider is dragged; kept once it is let go. */
  const [dragSize, setDragSize] = useState<number | undefined>(undefined);
  const dragBase = useRef(0);
  const [details, setDetails] = useState<ReadonlyMap<string, BranchPanelDetailsDto>>(new Map());
  const [menu, setMenu] = useState<OpenMenu | null>(null);
  const [form, setForm] = useState<NewBranchRequest | null>(null);
  const [dropOver, setDropOver] = useState<string | undefined>(undefined);
  /** `<card row id>|<button label>` of a card button whose action is running. */
  const [runningButton, setRunningButton] = useState<string | undefined>(undefined);
  const [fetching, trackFetch] = useBusy();

  const searchRef = useRef<HTMLInputElement | null>(null);
  const reposListRef = useRef<PanelListHandle | null>(null);
  /** The BRANCHES pane's list, or with one repository the one list. */
  const branchesListRef = useRef<PanelListHandle | null>(null);
  const reposHeaderRef = useRef<HTMLDivElement | null>(null);
  const branchesHeaderRef = useRef<HTMLDivElement | null>(null);
  const [listHost, listSize] = useElementSize<HTMLDivElement>();
  const [splitHost, splitSize] = useElementSize<HTMLDivElement>();
  const theme = useVsCodeTheme();
  const dark = theme === 'dark' || theme === 'high-contrast';

  useEffect(() => {
    api.setState({
      scope: [...scope],
      toggled: [...toggled],
      ...(tab !== undefined ? { tab } : {}),
      ...(reposSize !== undefined ? { reposSize } : {}),
    } satisfies Persisted);
  }, [api, reposSize, scope, tab, toggled]);

  // The repositories in view, as the model works them out: what a card's facts are asked for in.
  const scopeRoots = useMemo(
    () => (state ? scopeReposOf(state.repos, scope).map((r) => r.root) : []),
    [state, scope],
  );
  // A card's facts decide how its repositories group, so the model sizes the card with them.
  const detailsOf = useCallback(
    (entry: BranchEntry) => details.get(detailsKey(entry, scopeRoots)),
    [details, scopeRoots],
  );
  const ui: PanelUiState = useMemo(
    () => ({
      query,
      scope,
      toggled,
      ...(openCard !== undefined ? { openCard } : {}),
      ...(tab !== undefined ? { tab } : {}),
      detailsOf,
      openGroups,
    }),
    [detailsOf, openCard, openGroups, query, scope, tab, toggled],
  );
  const model = useMemo(() => (state ? buildPanel(state, ui) : undefined), [state, ui]);
  const searching = query.trim().length > 0;
  const reposOpen = paneOpen(toggled, 'repos');
  const branchesOpen = paneOpen(toggled, 'branches');

  const setPane = useCallback((pane: PaneId, open: boolean) => {
    setToggled((prev) => withPane(prev, pane, open));
  }, []);

  // A search's matches are in BRANCHES: a folded one opens to show them.
  useEffect(() => {
    if (searching) setPane('branches', true);
  }, [searching, setPane]);

  // The latest model, for handlers registered once.
  const modelRef = useRef(model);
  modelRef.current = model;
  const repoCount = state?.repos.length ?? 0;

  const colorOf = useCallback(
    (repo: BranchPanelRepoDto) => laneColor(repo.colorIdx, dark, state?.palette ?? 'default'),
    [dark, state?.palette],
  );

  const openForm = useCallback((request: Partial<NewBranchRequest>) => {
    setMenu(null);
    setForm({
      from: request.from ?? 'HEAD',
      roots: request.roots ?? (modelRef.current?.scopeRepos ?? []).map((r) => r.root),
      ...(request.name !== undefined ? { name: request.name } : {}),
    });
  }, []);

  const focusSearch = useCallback((text?: string) => {
    const el = searchRef.current;
    if (!el) return;
    if (text !== undefined) setQuery((q) => q + text);
    requestAnimationFrame(() => {
      el.focus();
      if (text === undefined) el.select();
    });
  }, []);

  // ---- the host ---------------------------------------------------------------
  useEffect(() => {
    const offState = rpc.onEvent(BRANCHES_METHODS.evtState, (p) => setState(p as BranchPanelStateDto));
    const offNew = rpc.onEvent(BRANCHES_METHODS.evtNewBranch, (p) => {
      const params = (p ?? {}) as { from?: string; roots?: string[] };
      openForm({
        ...(params.from !== undefined ? { from: params.from } : {}),
        ...(params.roots !== undefined ? { roots: params.roots } : {}),
      });
    });
    const offFocus = rpc.onEvent(BRANCHES_METHODS.evtFocusFilter, () => focusSearch());
    void rpc.request<BranchPanelStateDto>(BRANCHES_METHODS.init).then(
      (s) => setState(s),
      () => undefined,
    );
    return () => {
      offState();
      offNew();
      offFocus();
    };
  }, [focusSearch, openForm]);

  const run = useCallback(
    (what: BranchPanelRunDto) => {
      if (what.type === 'newBranch') {
        openForm({ from: what.from, roots: what.roots });
        return;
      }
      void rpc.request(BRANCHES_METHODS.run, { run: what }, LONG_MS).catch(() => undefined);
    },
    [openForm],
  );

  const runCommand = useCallback(
    (command: string, root?: string) =>
      run({ type: 'command', command, ...(root !== undefined ? { root } : {}) }),
    [run],
  );

  const fetchAll = useCallback(() => {
    trackFetch(() => rpc.request(BRANCHES_METHODS.fetchAll, {}, LONG_MS).catch(() => undefined));
  }, [trackFetch]);

  const setSetting = useCallback((key: BranchPanelSettingKey, value: boolean) => {
    void rpc.request(BRANCHES_METHODS.setting, { key, value }).catch(() => undefined);
  }, []);

  const create = useCallback(
    (dto: BranchPanelCreateDto) =>
      rpc.request<BranchPanelCreateResultDto>(BRANCHES_METHODS.create, dto, LONG_MS),
    [],
  );

  // ---- a card's facts ---------------------------------------------------------
  const openRow = model?.rows.find((r) => r.id === openCard);
  const openEntry =
    openRow?.kind === 'branch' ? openRow.entry : openRow?.kind === 'head' ? openRow.entry : undefined;
  const scopeRef = useRef(scopeRoots);
  scopeRef.current = scopeRoots;
  const openKey = openEntry !== undefined ? detailsKey(openEntry, scopeRoots) : undefined;
  const openEntryRef = useRef(openEntry);
  openEntryRef.current = openEntry;
  useEffect(() => {
    const entry = openEntryRef.current;
    if (entry === undefined || openKey === undefined || details.has(openKey)) return undefined;
    let live = true;
    void rpc
      .request<BranchPanelDetailsDto>(BRANCHES_METHODS.details, { target: targetOf(entry), scope: scopeRef.current })
      .then(
      (d) => {
        if (!live) return;
        setDetails((prev) => {
          const next = new Map(prev);
          next.set(openKey, d);
          while (next.size > DETAILS_KEPT) {
            const oldest = next.keys().next().value;
            if (oldest === undefined) break;
            next.delete(oldest);
          }
          return next;
        });
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [details, openKey]);

  // ---- menus ------------------------------------------------------------------
  const showMenu = useCallback(
    (
      dto: readonly BranchPanelMenuItemDto[],
      at: { x: number; y: number },
      label: string,
      lead: ReadonlyArray<{ label: string; icon?: string; run: () => void }> = [],
    ) => {
      const runs = new Map<string, () => void>();
      let n = 0;
      const convert = (list: readonly BranchPanelMenuItemDto[]): MenuItem[] =>
        list.map((item): MenuItem => {
          switch (item.kind) {
            case 'separator':
              return { kind: 'separator', id: `s${n++}` };
            case 'header':
              return { kind: 'header', id: `h${n++}`, label: item.label };
            case 'submenu':
              return {
                kind: 'submenu',
                id: `m${n++}`,
                label: item.label,
                ...(item.icon !== undefined ? { icon: item.icon } : {}),
                items: convert(item.items),
              };
            case 'item': {
              const id = `i${n++}`;
              runs.set(id, () => run(item.run));
              return {
                kind: 'item',
                id,
                label: item.label,
                ...(item.icon !== undefined ? { icon: item.icon } : {}),
                ...(item.accelerator !== undefined ? { accelerator: item.accelerator } : {}),
              };
            }
          }
        });
      const items: MenuItem[] = [];
      for (const extra of lead) {
        const id = `x${n++}`;
        runs.set(id, extra.run);
        items.push({
          kind: 'item',
          id,
          label: extra.label,
          ...(extra.icon !== undefined ? { icon: extra.icon } : {}),
        });
      }
      const rest = convert(dto);
      if (items.length > 0 && rest.length > 0) items.push({ kind: 'separator', id: `s${n++}` });
      items.push(...rest);
      if (items.length > 0) setMenu({ items, at, label, runs });
    },
    [run],
  );

  const openBranchMenu = useCallback(
    (entry: BranchEntry, at: { x: number; y: number }) => {
      void rpc
        .request<BranchPanelMenuItemDto[]>(BRANCHES_METHODS.menu, { target: targetOf(entry), scope: scopeRef.current })
        .then(
          (items) => showMenu(items ?? [], at, `Actions for ${entry.name}`),
          () => undefined,
        );
    },
    [showMenu],
  );

  const toggleScope = useCallback(
    (root: string, additive: boolean) => {
      setScope((prev) => {
        if (!additive) return prev.length === 1 && prev[0] === root ? [] : [root];
        const base = prev.length === 0 ? [] : prev;
        const next = base.includes(root) ? base.filter((r) => r !== root) : [...base, root];
        return next.length >= repoCount ? [] : next;
      });
      // The open card may belong to a branch that is now out of view.
      setOpenCard(undefined);
    },
    [repoCount],
  );

  const openRepoMenu = useCallback(
    (repo: BranchPanelRepoDto, at: { x: number; y: number }) => {
      const narrowedToIt = scope.length === 1 && scope[0] === repo.root;
      const lead =
        repoCount > 1
          ? [
              narrowedToIt
                ? { label: 'Show All Repositories', icon: 'list-flat', run: () => setScope([]) }
                : { label: 'Show Only This Repository', icon: 'filter', run: () => setScope([repo.root]) },
            ]
          : [];
      void rpc.request<BranchPanelMenuItemDto[]>(BRANCHES_METHODS.menu, { root: repo.root }).then(
        (items) => showMenu(items ?? [], at, `Actions for ${repo.label}`, lead),
        () => undefined,
      );
    },
    [repoCount, scope, showMenu],
  );

  /** The single repository's first row: its current branch's menu, then the repository's own. */
  const openHeadMenu = useCallback(
    (row: Extract<PanelRow, { kind: 'head' }>, at: { x: number; y: number }) => {
      const branch =
        row.entry !== undefined
          ? rpc.request<BranchPanelMenuItemDto[]>(BRANCHES_METHODS.menu, {
              target: targetOf(row.entry),
              scope: scopeRef.current,
            })
          : Promise.resolve([] as BranchPanelMenuItemDto[]);
      const repo = rpc.request<BranchPanelMenuItemDto[]>(BRANCHES_METHODS.menu, { root: row.repo.root });
      void Promise.all([branch, repo]).then(
        ([a, b]) => {
          const items: BranchPanelMenuItemDto[] = [...(a ?? [])];
          if (items.length > 0 && (b ?? []).length > 0) {
            items.push({ kind: 'separator' }, { kind: 'header', label: 'Repository' });
          }
          items.push(...(b ?? []));
          showMenu(items, at, `Actions for ${row.repo.label}`);
        },
        () => undefined,
      );
    },
    [showMenu],
  );

  const openMoreMenu = useCallback(
    (at: { x: number; y: number }) => {
      if (!state || !model) return;
      const single = model.scopeRepos.length === 1 ? model.scopeRepos[0]?.root : undefined;
      const keymap = state.intellijKeymap === true;
      const runs = new Map<string, () => void>();
      const item = (
        id: string,
        label: string,
        act: () => void,
        extra: { icon?: string; accelerator?: string; checked?: boolean } = {},
      ): MenuItem => {
        runs.set(id, act);
        return { kind: 'item', id, label, ...extra };
      };
      const items: MenuItem[] = [
        // IntelliJ's keys, named only when its keymap binds them (POST-QA).
        item('update', 'Update Project…', () => runCommand('gittree.update.dialog', single), {
          icon: 'arrow-down',
          ...(keymap ? { accelerator: 'Ctrl+T' } : {}),
        }),
        item('commit', 'Commit…', () => runCommand('gittree.commit', single), {
          icon: 'git-commit',
          ...(keymap ? { accelerator: 'Ctrl+K' } : {}),
        }),
        item('push', 'Push…', () => runCommand('gittree.push.dialog', single), {
          icon: 'arrow-up',
          ...(keymap ? { accelerator: 'Ctrl+Shift+K' } : {}),
        }),
        { kind: 'separator', id: 's1' },
        item('new', 'New Branch…', () => openForm({ from: 'HEAD' }), { icon: 'add' }),
        item('revision', 'Checkout Tag or Revision…', () =>
          runCommand('gittree.branches.checkoutRevision', single),
        ),
        // POST-P14ax: one branch in every repository in view, from a picker of them all.
        ...(model.scopeRepos.length > 1
          ? [
              item(
                'checkoutAcross',
                model.scopeRepos.length === state.repos.length
                  ? 'Checkout Branch in All Repositories…'
                  : `Checkout Branch in ${model.scopeRepos.length} Repositories…`,
                () => run({ type: 'checkoutAcross', roots: model.scopeRepos.map((r) => r.root) }),
                { icon: 'arrow-swap' },
              ),
            ]
          : []),
        item('cleanup', 'Clean Up Branches…', () => runCommand('gittree.branches.cleanup', single), {
          icon: 'trash',
        }),
        { kind: 'separator', id: 's2' },
        { kind: 'header', id: 'h1', label: 'Show' },
        item('tags', 'Tags', () => setSetting('showTags', !state.showTags), { checked: state.showTags }),
        item('inout', 'Incoming / Outgoing Counts', () => setSetting('showIncomingOutgoing', !state.showInOut), {
          checked: state.showInOut,
        }),
        // The toolbar's dots button, here too; only while several repositories are in view.
        ...(model.markers
          ? [
              item('dots', 'Repository Dots', () => setSetting('showRepositoryDots', !state.showRepositoryDots), {
                checked: state.showRepositoryDots,
              }),
            ]
          : []),
        item('folders', 'Group by Folder', () => setSetting('groupByFolder', !state.groupByFolder), {
          checked: state.groupByFolder,
        }),
        { kind: 'separator', id: 's3' },
        item(
          'collapse',
          'Collapse All',
          () => {
            // Every folder and remote of the tab on show, shut.
            setToggled((prev) => collapsedAll(model.rows, prev));
            setOpenCard(undefined);
          },
          { icon: 'collapse-all' },
        ),
      ];
      setMenu({ items, at, label: 'More actions', runs });
    },
    [model, openForm, run, runCommand, setSetting, state],
  );

  // ---- gestures on rows ---------------------------------------------------------
  const toggle = useCallback((id: string) => {
    setToggled((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const toggleCard = useCallback((id: string) => {
    setOpenCard((prev) => (prev === id ? undefined : id));
    // Opened again, a card starts with its groups shut.
    setGroupsOpen(undefined);
  }, []);

  const toggleGroup = useCallback(
    (key: string) => {
      if (openCard === undefined) return;
      setGroupsOpen((prev) => {
        const keys = new Set(prev?.card === openCard ? prev.keys : []);
        if (keys.has(key)) keys.delete(key);
        else keys.add(key);
        return { card: openCard, keys };
      });
    },
    [openCard],
  );

  /**
   * A tab picked, by the pointer or the arrows. The keyboard goes on from the
   * tabs, and a list scrolled far down starts again right under them.
   */
  const selectTab = useCallback((next: BranchTab) => {
    setTab(next);
    branchesListRef.current?.focusRow(TABS_ID);
  }, []);

  const onQuick = useCallback(
    (entry: BranchEntry, action: QuickAction, e: ReactMouseEvent<HTMLButtonElement>) => {
      const target = targetOf(entry);
      switch (action) {
        case 'checkout':
        case 'update':
        case 'push':
          run({ type: 'action', target, action });
          return;
        case 'star':
          void rpc.request(BRANCHES_METHODS.favorite, { target, on: !entry.favorite }).catch(() => undefined);
          return;
        case 'menu': {
          const r = e.currentTarget.getBoundingClientRect();
          openBranchMenu(entry, { x: r.right, y: r.bottom });
          return;
        }
      }
    },
    [openBranchMenu, run],
  );

  /**
   * A row's gesture. `detail` is the click count of a pointer's click, and
   * absent for a key (Enter, Space, Right, Left, Escape); `twisty` says the
   * click landed on the row's chevron.
   */
  const activate = useCallback(
    (row: PanelRow, e?: { ctrlKey: boolean; metaKey: boolean; detail?: number; twisty?: boolean }) => {
      switch (row.kind) {
        case 'remote':
        case 'folder':
          toggle(row.id);
          return;
        case 'repo':
          toggleScope(row.repo.root, e?.ctrlKey === true || e?.metaKey === true);
          return;
        case 'head':
        case 'branch': {
          // A click selects, which the list has done; the card is asked for:
          // the chevron, a double-click, or Enter, Space or Right.
          const clicks = e?.detail;
          if (clicks === undefined) toggleCard(row.id);
          // The chevron once: its second click of a double-click would shut it again.
          else if (e?.twisty === true) {
            if (clicks <= 1) toggleCard(row.id);
          } else if (clicks === 2) toggleCard(row.id);
          return;
        }
        case 'hint':
          if (row.create !== undefined) openForm({ from: 'HEAD', name: row.create });
          return;
        // A heading over a search's matches, which never folds.
        case 'section':
        case 'operation':
        case 'tabs':
          return;
      }
    },
    [openForm, toggle, toggleCard, toggleScope],
  );

  const openRowMenu = useCallback(
    (row: PanelRow, at: { x: number; y: number }) => {
      if (row.kind === 'branch') openBranchMenu(row.entry, at);
      else if (row.kind === 'repo') openRepoMenu(row.repo, at);
      else if (row.kind === 'head') openHeadMenu(row, at);
    },
    [openBranchMenu, openHeadMenu, openRepoMenu],
  );

  const onRowKeyDown = useCallback(
    (row: PanelRow, _index: number, e: ReactKeyboardEvent<HTMLDivElement>): boolean => {
      // On the tabs, Left and Right go from one to the next, round the ends as a tab strip does.
      if (row.kind === 'tabs' && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        e.preventDefault();
        const at = row.tabs.findIndex((t) => t.id === row.active);
        const step = e.key === 'ArrowRight' ? 1 : -1;
        const next = row.tabs[(at + step + row.tabs.length) % row.tabs.length];
        if (next !== undefined) selectTab(next.id);
        return true;
      }
      const open =
        row.kind === 'folder' || row.kind === 'remote'
          ? row.open
          : row.kind === 'branch' || row.kind === 'head'
            ? row.card
            : undefined;
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        activate(row, { ctrlKey: e.ctrlKey, metaKey: e.metaKey });
        return true;
      }
      if (e.key === 'ArrowRight' && open === false) {
        e.preventDefault();
        activate(row);
        return true;
      }
      if ((e.key === 'ArrowLeft' || e.key === 'Escape') && open === true) {
        e.preventDefault();
        activate(row);
        return true;
      }
      if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) {
        e.preventDefault();
        const r = rowRect(row.id);
        openRowMenu(row, { x: (r?.left ?? 0) + 24, y: (r?.top ?? 0) + 22 });
        return true;
      }
      if ((e.key === 'Delete' || e.key === 'F2') && row.kind === 'branch') {
        const entry = row.entry;
        if (entry.kind !== 'local' || entry.presence.length !== 1) return false;
        e.preventDefault();
        if (e.key === 'F2') run({ type: 'action', target: targetOf(entry), action: 'rename' });
        else if (entry.currentIn.length === 0) {
          run({ type: 'action', target: targetOf(entry), action: 'delete' });
        }
        return true;
      }
      // Ctrl+F, or simply typing: the filter takes it.
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        focusSearch();
        return true;
      }
      if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        focusSearch(e.key);
        return true;
      }
      return false;
    },
    [activate, focusSearch, openRowMenu, run, selectTab],
  );

  // ---- rendering ----------------------------------------------------------------------
  if (!state || !model) return <div className="gtp-empty">Loading…</div>;

  // Repository Dots: a dot per repository on each branch row, with several in
  // view and the toolbar's switch on. A branch's card lists the repositories
  // either way (`model.markers`), so turning them off hides nothing for good.
  const dotsShown = model.markers && state.showRepositoryDots;
  if (state.repos.length === 0) {
    return (
      <div className="gtp-empty">
        <Codicon name="repo" />
        <p>No Git repository in this workspace.</p>
      </div>
    );
  }

  const narrowed = model.multi && model.scopeRepos.length < state.repos.length;
  const scopeLabel =
    model.scopeRepos.length === 1
      ? (model.scopeRepos[0]?.label ?? '')
      : `${model.scopeRepos.length} repositories`;
  const placeholder = !model.multi
    ? 'Filter branches'
    : narrowed
      ? `Filter branches in ${scopeLabel}`
      : `Filter branches in ${state.repos.length} repositories`;
  const fetchBusy = fetching || state.fetchingAll;
  const firstBranchId = model.rows.find((r) => r.kind === 'branch')?.id;

  // ---- the panes: two lists with several repositories, one with one -----------
  const split = model.multi;
  const listRows = (list: ListId): readonly PanelRow[] =>
    !split ? model.rows : list === 'repos' ? model.repoRows : model.branchRows;
  /**
   * Puts the keyboard on a row of `list`: its first or last, else the one it
   * had, else its first. False when the list is not there to take it: folded,
   * empty, or (with one repository) the repositories' list that does not exist.
   */
  const focusList = (list: ListId, which?: 'first' | 'last'): boolean => {
    if (!split && list === 'repos') return false;
    if (split && !(list === 'repos' ? reposOpen : branchesOpen)) return false;
    const rows = listRows(list);
    const first = rows[0];
    const last = rows[rows.length - 1];
    if (first === undefined || last === undefined) return false;
    const kept = list === 'repos' ? repoFocusId : branchFocusId;
    const id =
      which === 'first'
        ? first.id
        : which === 'last'
          ? last.id
          : kept !== undefined && rows.some((r) => r.id === kept)
            ? kept
            : first.id;
    (list === 'repos' ? reposListRef : branchesListRef).current?.focusRow(id);
    return true;
  };
  /** Down or Enter in the filter: back to the list the keyboard was in, else the first one open. */
  const enterLists = (): void => {
    if (lastList !== undefined && focusList(lastList)) return;
    if (focusList('repos') || focusList('branches')) return;
    reposHeaderRef.current?.focus();
  };
  /**
   * A pane header's keys, as VS Code's: Enter and Space fold or open it, Left
   * shuts it, Right opens it. Down goes into its list (or, past a folded
   * REPOSITORIES, on to the BRANCHES header), Up from BRANCHES back to the last
   * repository; typing filters, as it does in the lists.
   */
  const onHeaderKeyDown = (pane: PaneId, e: ReactKeyboardEvent<HTMLDivElement>): void => {
    // Keys pressed on the header's own buttons are theirs.
    if (e.target !== e.currentTarget) return;
    const open = pane === 'repos' ? reposOpen : branchesOpen;
    if (e.key === 'Enter' || e.key === ' ') setPane(pane, !open);
    else if (e.key === 'ArrowLeft') setPane(pane, false);
    else if (e.key === 'ArrowRight') setPane(pane, true);
    else if (e.key === 'ArrowDown') {
      if (!focusList(pane, 'first') && pane === 'repos') branchesHeaderRef.current?.focus();
    } else if (e.key === 'ArrowUp') {
      if (pane === 'branches' && !focusList('repos', 'last')) reposHeaderRef.current?.focus();
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') focusSearch();
    else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) focusSearch(e.key);
    else return;
    e.preventDefault();
  };

  const reposContent = model.repoRows.reduce((sum, r) => sum + r.height, 0);
  const wantedRepos = dragSize ?? reposSize;
  const layout = paneLayout({
    total: splitSize.height,
    reposOpen,
    branchesOpen,
    reposContent,
    ...(wantedRepos !== undefined ? { reposSize: wantedRepos } : {}),
  });
  const selected = selectedRepos(state.repos, model.scopeRepos);

  const repoButtons = (repo: BranchPanelRepoDto) => ({
    onUpdate: () => runCommand('gittree.update.dialog', repo.root),
    onPush: () => runCommand('gittree.push.dialog', repo.root),
    onFetch: () => runCommand('gittree.fetch', repo.root),
    onMenu: (e: ReactMouseEvent<HTMLButtonElement>) => {
      const r = e.currentTarget.getBoundingClientRect();
      openRepoMenu(repo, { x: r.right, y: r.bottom });
    },
  });

  const card = (
    rowId: string,
    entry: BranchEntry | undefined,
    lines: readonly CardLine[],
    indent: number,
    menuFor: (at: { x: number; y: number }) => void,
    detachedAt?: string,
  ) => (
    <BranchCard
      entry={entry}
      lines={lines}
      details={entry !== undefined ? details.get(detailsKey(entry, scopeRoots)) : { repos: [], buttons: [] }}
      markers={model.markers}
      onToggleGroup={toggleGroup}
      now={state.now}
      indent={indent}
      colorOf={colorOf}
      {...(runningButton?.startsWith(`${rowId}|`) === true
        ? { running: runningButton.slice(rowId.length + 1) }
        : {})}
      onButton={(b: BranchPanelButtonDto) => {
        if (b.run.type === 'newBranch') {
          run(b.run);
          return;
        }
        // The host answers when the action is done: the button turns until then.
        const key = `${rowId}|${b.label}`;
        setRunningButton(key);
        void rpc
          .request(BRANCHES_METHODS.run, { run: b.run }, LONG_MS)
          .catch(() => undefined)
          .finally(() => setRunningButton((cur) => (cur === key ? undefined : cur)));
      }}
      onMenu={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        menuFor({ x: r.right, y: r.bottom });
      }}
      onStopTracking={(roots) => {
        if (entry === undefined) return;
        const target = targetOf(entry);
        // A group's repositories: the action in them alone. One is named as
        // the per-repository line always named it; several narrow the target.
        if (roots === undefined) run({ type: 'action', target, action: 'stopTracking' });
        else if (roots.length === 1) run({ type: 'action', target, action: 'stopTracking', root: roots[0]! });
        else run({ type: 'action', target: { ...target, roots: [...roots] }, action: 'stopTracking' });
      }}
      {...(detachedAt !== undefined ? { detachedAt } : {})}
    />
  );

  const dragProps = (row: Extract<PanelRow, { kind: 'branch' }>) => {
    if (row.entry.kind !== 'local') return {};
    return {
      onDragOver: (e: ReactDragEvent<HTMLDivElement>) => {
        if (!e.dataTransfer.types.includes(DRAG_MIME)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'link';
        if (dropOver !== row.id) setDropOver(row.id);
      },
      onDragLeave: () => setDropOver((cur) => (cur === row.id ? undefined : cur)),
      onDrop: (e: ReactDragEvent<HTMLDivElement>) => {
        setDropOver(undefined);
        const raw = e.dataTransfer.getData(DRAG_MIME);
        if (raw.length === 0) return;
        e.preventDefault();
        let source: BranchPanelTargetDto;
        try {
          source = JSON.parse(raw) as BranchPanelTargetDto;
        } catch {
          return;
        }
        if (source.kind !== 'local' || source.name === row.entry.name) return;
        void rpc
          .request(BRANCHES_METHODS.drop, { source, target: targetOf(row.entry) }, LONG_MS)
          .catch(() => undefined);
      },
    };
  };

  const renderRow = (row: PanelRow) => {
    switch (row.kind) {
      case 'section': {
        const actions =
          row.section === 'local' ? (
            <RowButton icon="add" title="New Branch…" onClick={() => openForm({ from: 'HEAD' })} />
          ) : row.section === 'remote' ? (
            <RowButton icon="sync" title="Fetch" spin={fetchBusy} onClick={fetchAll} />
          ) : undefined;
        return <SectionRow row={row} searching={searching} {...(actions !== undefined ? { actions } : {})} />;
      }
      case 'repo':
        return (
          <RepoRow
            row={row}
            color={colorOf(row.repo)}
            showInOut={state.showInOut}
            buttons={repoButtons(row.repo)}
          />
        );
      case 'head': {
        // The current branch's menu, then the repository's: from `⋯` as from right-click.
        const headMenu = (at: { x: number; y: number }) => openHeadMenu(row, at);
        return (
          <HeadRow
            row={row}
            showInOut={state.showInOut}
            buttons={{
              ...repoButtons(row.repo),
              onMenu: (e: ReactMouseEvent<HTMLButtonElement>) => {
                const r = e.currentTarget.getBoundingClientRect();
                headMenu({ x: r.right, y: r.bottom });
              },
            }}
            card={
              row.card
                ? card(row.id, row.entry, row.cardLines ?? [], 8, headMenu, row.repo.headSha?.slice(0, 8))
                : null
            }
          />
        );
      }
      case 'operation':
        return (
          <OperationRow
            repo={row.repo}
            onRun={(command) =>
              runCommand(command, row.repo.root)
            }
          />
        );
      case 'tabs':
        return <TabsRow row={row} onSelect={selectTab} />;
      case 'remote':
        return <GroupRow icon="cloud" label={row.remote} count={row.count} open={row.open} depth={row.depth} />;
      case 'folder':
        return <GroupRow icon="folder" label={row.label} count={row.count} open={row.open} depth={row.depth} />;
      case 'branch':
        return (
          <div className={`gtp-drop-zone${dropOver === row.id ? ' gtp-drop-over' : ''}`} {...dragProps(row)}>
            <BranchRow
              row={row}
              now={state.now}
              showInOut={state.showInOut}
              markers={dotsShown}
              scopeRepos={model.scopeRepos}
              colorOf={colorOf}
              onQuick={(action, e) => onQuick(row.entry, action, e)}
              card={
                row.card
                  ? card(row.id, row.entry, row.cardLines ?? [], 8 + row.depth * INDENT + 20, (at) =>
                      openBranchMenu(row.entry, at),
                    )
                  : null
              }
              draggable={row.entry.kind === 'local'}
              onDragStart={(e) => {
                e.dataTransfer.setData(DRAG_MIME, JSON.stringify(targetOf(row.entry)));
                e.dataTransfer.effectAllowed = 'link';
              }}
            />
          </div>
        );
      case 'hint':
        return (
          <div className="gtp-hint">
            <span>{row.text}</span>
            {row.create !== undefined ? (
              <button
                type="button"
                className="gt-button gtp-small"
                tabIndex={-1}
                onClick={(e) => {
                  e.stopPropagation();
                  openForm({ from: 'HEAD', name: row.create });
                }}
              >
                <Codicon name="add" /> Create branch “{row.create}”
              </button>
            ) : null}
          </div>
        );
    }
  };

  const rowAttributes = (row: PanelRow) => {
    const level = row.kind === 'branch' || row.kind === 'folder' || row.kind === 'remote' ? row.depth + 2 : 1;
    // A search's headings never fold, so they say nothing of being open.
    const expanded =
      row.kind === 'folder' || row.kind === 'remote'
        ? row.open
        : row.kind === 'branch' || row.kind === 'head'
          ? row.card
          : undefined;
    const label =
      row.kind === 'branch'
        ? `${row.entry.name}${row.entry.currentIn.length > 0 ? ', checked out' : ''}${
            row.entry.tracksElsewhere !== undefined ? `, tracks ${row.entry.tracksElsewhere}` : ''
          }`
        : row.kind === 'repo'
          ? `${row.repo.label}, on ${row.repo.head ?? 'a detached HEAD'}${row.repo.fetching ? ', fetching' : ''}`
          : row.kind === 'head'
            ? `Current branch ${row.repo.head ?? 'detached HEAD'}`
            : row.kind === 'section'
              ? `${row.label}, ${row.count}`
              : row.kind === 'tabs'
                ? tabsLabel(row)
                : undefined;
    return {
      'aria-level': level,
      ...(expanded !== undefined ? { 'aria-expanded': expanded } : {}),
      ...(row.kind === 'repo' ? { 'aria-selected': row.inScope && narrowed } : {}),
      ...(label !== undefined ? { 'aria-label': label } : {}),
    };
  };

  /** What both lists share: the rows' drawing, words and gestures, and which row each keeps. */
  const listProps = (list: ListId) => {
    const onFocusId = (id: string): void => {
      if (list === 'repos') setRepoFocusId(id);
      else setBranchFocusId(id);
      setLastList(list);
    };
    return {
      focusedId: list === 'repos' ? repoFocusId : branchFocusId,
      onFocusId,
      renderRow,
      rowClassName: (row: PanelRow) => `gtp-kind-${row.kind}`,
      rowAttributes,
      onRowKeyDown,
      onRowClick: (row: PanelRow, e: ReactMouseEvent<HTMLDivElement>) =>
        activate(row, {
          ctrlKey: e.ctrlKey,
          metaKey: e.metaKey,
          detail: e.detail,
          twisty: e.target instanceof Element && e.target.closest('.gtp-twisty') !== null,
        }),
      onRowContextMenu: (row: PanelRow, e: ReactMouseEvent<HTMLDivElement>) => {
        e.preventDefault();
        onFocusId(row.id);
        const keyboard = e.button === -1 || (e.clientX === 0 && e.clientY === 0);
        const r = rowRect(row.id);
        openRowMenu(
          row,
          keyboard ? { x: (r?.left ?? 0) + 24, y: (r?.top ?? 0) + 22 } : { x: e.clientX, y: e.clientY },
        );
      },
    };
  };

  return (
    <div className="gtp-root">
      <div className="gtp-toolbar">
        <div className="gtp-search">
          <Codicon name="search" />
          {narrowed ? (
            <button
              type="button"
              className="gtp-scope-pill"
              title="Show every repository"
              aria-label={`Narrowed to ${scopeLabel}; show every repository`}
              onClick={() => setScope([])}
            >
              {scopeLabel}
              <Codicon name="close" />
            </button>
          ) : null}
          <input
            ref={searchRef}
            className="gtp-search-input"
            type="text"
            value={query}
            placeholder={placeholder}
            aria-label="Filter branches"
            spellCheck={false}
            onChange={(e) => setQuery(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault();
                if (query.length > 0) setQuery('');
                else if (lastList !== undefined) focusList(lastList);
              } else if (e.key === 'ArrowDown' || e.key === 'Enter') {
                if (!searching) {
                  e.preventDefault();
                  enterLists();
                  return;
                }
                // The matches are in BRANCHES, which the search has opened.
                if (firstBranchId === undefined) return;
                e.preventDefault();
                branchesListRef.current?.focusRow(firstBranchId);
                if (e.key === 'Enter') setOpenCard(firstBranchId);
              }
            }}
          />
          {query.length > 0 ? (
            <button
              type="button"
              className="gt-toolbar-button gtp-icon-button"
              title="Clear (Escape)"
              aria-label="Clear filter"
              onClick={() => {
                setQuery('');
                searchRef.current?.focus();
              }}
            >
              <Codicon name="close" />
            </button>
          ) : null}
        </div>
        <button
          type="button"
          className={`gt-toolbar-button${fetchBusy ? ' gt-busy' : ''}`}
          title={state.repos.length > 1 ? 'Fetch all repositories' : 'Fetch'}
          aria-label="Fetch"
          aria-busy={fetchBusy ? true : undefined}
          onClick={fetchBusy ? undefined : fetchAll}
        >
          <Codicon name="sync" spin={fetchBusy} />
        </button>
        {model.markers ? (
          <button
            type="button"
            className={`gt-toolbar-button${state.showRepositoryDots ? ' gt-toggled' : ''}`}
            title={state.showRepositoryDots ? 'Hide Repository Dots' : 'Show Repository Dots'}
            aria-label="Repository Dots"
            aria-pressed={state.showRepositoryDots}
            onClick={() => setSetting('showRepositoryDots', !state.showRepositoryDots)}
          >
            <RepositoryDotsGlyph />
          </button>
        ) : null}
        <button
          type="button"
          className="gt-toolbar-button"
          title="New Branch…"
          aria-label="New Branch"
          onClick={() => openForm({ from: 'HEAD' })}
        >
          <Codicon name="add" />
        </button>
        <button
          type="button"
          className="gt-toolbar-button"
          title="More Actions…"
          aria-label="More Actions"
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            openMoreMenu({ x: r.right, y: r.bottom });
          }}
        >
          <Codicon name="ellipsis" />
        </button>
      </div>
      {form !== null ? (
        <NewBranchForm
          key={`${form.from}|${form.roots.join(',')}|${form.name ?? ''}`}
          repos={state.repos}
          request={form}
          colorOf={colorOf}
          onCreate={create}
          onClose={() => setForm(null)}
        />
      ) : null}
      {split ? (
        <div className={`gtp-split${dragSize !== undefined ? ' gtp-resizing' : ''}`} ref={splitHost}>
          <PaneHeader
            ref={reposHeaderRef}
            pane="repos"
            title="Repositories"
            open={reposOpen}
            count={state.repos.length}
            controls="gtp-repos-list"
            ariaLabel={`Repositories, ${state.repos.length}${selected.length > 0 ? `. ${selectionTitle(selected)}` : ''}`}
            label={
              selected.length > 0 ? (
                <span className="gtp-pane-label" title={selectionTitle(selected)}>
                  {selected.map((repo) => (
                    <span key={repo.root} className="gtp-pane-repo">
                      <span
                        className="gtp-dot gtp-dot-on"
                        style={{ '--gtp-repo': colorOf(repo) } as CSSProperties}
                        aria-hidden="true"
                      />
                      {repo.label}
                    </span>
                  ))}
                </span>
              ) : undefined
            }
            actions={
              selected.length > 0 ? (
                <button type="button" className="gtp-link" title="Show every repository" onClick={() => setScope([])}>
                  Show all
                </button>
              ) : undefined
            }
            onToggle={() => setPane('repos', !reposOpen)}
            onKeyDown={(e) => onHeaderKeyDown('repos', e)}
          />
          <div className={`gtp-pane-body${reposOpen ? '' : ' gtp-folded'}`} style={{ height: layout.reposBody }}>
            {splitSize.height > 0 ? (
              <PanelList
                ref={reposListRef}
                id="gtp-repos-list"
                rows={model.repoRows}
                height={layout.reposBody}
                ariaLabel="Repositories"
                onEdge={(direction) => (direction < 0 ? reposHeaderRef : branchesHeaderRef).current?.focus()}
                {...listProps('repos')}
              />
            ) : null}
          </div>
          <PaneHeader
            ref={branchesHeaderRef}
            pane="branches"
            title="Branches"
            open={branchesOpen}
            controls="gtp-branches-list"
            ariaLabel="Branches"
            onToggle={() => setPane('branches', !branchesOpen)}
            onKeyDown={(e) => onHeaderKeyDown('branches', e)}
          />
          <div className={`gtp-pane-body${branchesOpen ? '' : ' gtp-folded'}`} style={{ height: layout.branchesBody }}>
            {splitSize.height > 0 ? (
              <PanelList
                ref={branchesListRef}
                id="gtp-branches-list"
                rows={model.branchRows}
                height={layout.branchesBody}
                ariaLabel="Branches"
                stickyId={TABS_ID}
                onEdge={(direction) => {
                  if (direction < 0) branchesHeaderRef.current?.focus();
                }}
                {...listProps('branches')}
              />
            ) : null}
          </div>
          {layout.sash ? (
            <Sash
              top={PANE_HEADER + layout.reposBody}
              onStart={() => {
                dragBase.current = layout.reposBody;
              }}
              onMove={(delta) => setDragSize(Math.max(0, dragBase.current + delta))}
              onEnd={(moved) => {
                // The size the divider came to rest at, within the panes' limits.
                if (moved) setReposSize(layout.reposBody);
                setDragSize(undefined);
              }}
              onReset={() => {
                setDragSize(undefined);
                setReposSize(undefined);
              }}
            />
          ) : null}
        </div>
      ) : (
        <div className="gtp-list-host" ref={listHost}>
          {listSize.height > 0 ? (
            <PanelList
              ref={branchesListRef}
              rows={model.rows}
              height={listSize.height}
              ariaLabel="Repositories"
              stickyId={TABS_ID}
              {...listProps('branches')}
            />
          ) : null}
        </div>
      )}
      {menu ? (
        <Menu
          items={menu.items}
          at={menu.at}
          ariaLabel={menu.label}
          onSelect={(id) => {
            const act = menu.runs.get(id);
            setMenu(null);
            act?.();
          }}
          onClose={() => setMenu(null)}
        />
      ) : null}
    </div>
  );
}
