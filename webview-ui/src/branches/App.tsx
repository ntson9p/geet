/**
 * The side bar's Repositories and Branches panels (new-way-4; one panel with
 * two panes until POST-P14co made each a panel of its own). One app draws
 * both, told which by its page (`ROLE`):
 *
 * - **Repositories**: every repository with what it has checked out, a banner
 *   under one mid-operation. No toolbar and no header of its own: VS Code's is
 *   the panel's. Typing there goes to the Branches panel's filter.
 * - **Branches**: a toolbar (the filter, Fetch, Repository Dots, New Branch,
 *   more); the New Branch form while it is open; then the tabs over the
 *   branches — Recent (the starred and recently used), Local, Remote and Tags,
 *   one kind at a time. With one repository, its current branch first. The
 *   tabs stay at the top once the list scrolls past them, and step aside while
 *   the filter searches every kind. An `@` in the filter opens a list of the
 *   repositories to tick (`RepoPicker.tsx`; its rules, `repoPickerModel.ts`).
 *
 * **A click never changes anything.** Clicking a branch opens its card — the
 * last commit, where it stands against what it tracks and against what is
 * checked out, and the two or three actions its state calls for — and the
 * row's own buttons (on hover) and its menu (right-click, `⋯`) do the rest.
 * Clicking a repository narrows the branches to it; Ctrl+click adds or removes
 * one; ticks under the filter's `@` do either; the scope's `×` widens it again.
 *
 * The host sends facts (`branches/state`); everything this file decides —
 * what is open, the filter — lives here, so none of it waits on a round trip.
 * The repositories picked (the scope) are the host's since POST-P14ce, because
 * the Commit window shows only theirs: a pick here changes this panel at once
 * and is told to the host (`branches/setScope`); one made elsewhere — the
 * other panel, the Commit window's Show all — arrives (`branches/scope`).
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from 'react';
import {
  BRANCHES_METHODS,
  REPOSITORY_LOG_TAB_COMMAND,
  type BranchPanelButtonDto,
  type BranchPanelCreateDto,
  type BranchPanelCreateResultDto,
  type BranchPanelDetailsDto,
  type BranchPanelInitialStateDto,
  type BranchPanelInViewVerb,
  type BranchPanelMenuItemDto,
  type BranchPanelRepoDto,
  type BranchPanelRole,
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
  viewActions,
  type BranchEntry,
  type BranchTab,
  type CardLine,
  type PanelRow,
  type PanelUiState,
  type QuickAction,
} from './model';
import { NewBranchForm, type NewBranchRequest } from './NewBranchForm';
import { PanelList, type PanelListHandle } from './PanelList';
import { pickerRowId, REPO_PICKER_ID, RepoPicker } from './RepoPicker';
import { mentionAt, pickerRows, pickToggled, withoutMention, type Mention, type PickerRow } from './repoPickerModel';
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

/**
 * Which panel this page is (POST-P14co), as the host's page says: the
 * Repositories panel, or the Branches panel (also a page that says nothing).
 */
const ROLE: BranchPanelRole =
  (window as { __gittreeInitialState?: Partial<BranchPanelInitialStateDto> }).__gittreeInitialState?.role ===
  'repositories'
    ? 'repositories'
    : 'branches';

/** A fetch of every repository, or a checkout behind a dialog, can take minutes. */
const LONG_MS = 10 * 60_000;
/** Cards remembered; their facts cost git, and the panel re-asks when the refs move. */
const DETAILS_KEPT = 40;
const DRAG_MIME = 'application/x-gittree-branch';

interface Persisted {
  /**
   * The repositories picked, as kept here until POST-P14ce. Read once, for the
   * host to adopt; the host keeps the pick now, and it is no longer written.
   */
  readonly scope?: readonly string[];
  readonly toggled?: readonly string[];
  /** The branch tab picked, kept until another is. */
  readonly tab?: BranchTab;
}

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

/** A repository's menu less its `Show in New Log Tab`, and the rule that followed it. */
function withoutRepositoryLogTab(items: readonly BranchPanelMenuItemDto[]): BranchPanelMenuItemDto[] {
  const kept = items.filter(
    (i) => !(i.kind === 'item' && i.run.type === 'command' && i.run.command === REPOSITORY_LOG_TAB_COMMAND),
  );
  while (kept[0]?.kind === 'separator') kept.shift();
  return kept;
}

/** No group opened: one set, so the model is not rebuilt for a new empty one. */
const NO_GROUPS: ReadonlySet<string> = new Set();

function rowRect(id: string): DOMRect | undefined {
  return document.querySelector(`[data-row-id="${CSS.escape(id)}"]`)?.getBoundingClientRect();
}

/** POST-P14ce: the roots a host message names; anything else names none. */
function rootsOf(raw: unknown): readonly string[] | undefined {
  return Array.isArray(raw) && raw.every((r) => typeof r === 'string') ? raw : undefined;
}

function sameRoots(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((root, i) => root === b[i]);
}

export function App() {
  const api = useMemo(() => getVsCodeApi(), []);
  const saved = useMemo(() => (api.getState() as Persisted | undefined) ?? {}, [api]);

  const [state, setState] = useState<BranchPanelStateDto | null>(null);
  /** The filter field's text, an `@` being typed included. */
  const [query, setQuery] = useState('');
  /**
   * POST-P14co: the `@` the filter's caret is after, while the filter has the
   * keyboard and there are repositories to pick from: the picker is open.
   */
  const [mention, setMention] = useState<Mention | undefined>(undefined);
  const mentionNow = useRef<Mention | undefined>(undefined);
  mentionNow.current = mention;
  /** The picker's highlighted row: what Enter ticks. */
  const [pickerActive, setPickerActive] = useState(0);
  // POST-P14ce: the repositories picked, as the host keeps them (`pickScope`,
  // `adoptScope`). Empty until its first state, which the panel waits for anyway.
  const [scope, setScope] = useState<readonly string[]>([]);
  /** The pick as of the last change, for handlers that run before the next render. */
  const scopeNow = useRef<readonly string[]>([]);
  /** Picks sent to the host and not yet answered: until then, the host's word on the pick is older than this one's. */
  const scopeAsks = useRef(0);
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
  /** The list's keyboard row, kept while the filter has the focus. */
  const [focusId, setFocusId] = useState<string | undefined>(undefined);
  const [details, setDetails] = useState<ReadonlyMap<string, BranchPanelDetailsDto>>(new Map());
  const [menu, setMenu] = useState<OpenMenu | null>(null);
  const [form, setForm] = useState<NewBranchRequest | null>(null);
  const [dropOver, setDropOver] = useState<string | undefined>(undefined);
  /** `<card row id>|<button label>` of a card button whose action is running. */
  const [runningButton, setRunningButton] = useState<string | undefined>(undefined);
  const [fetching, trackFetch] = useBusy();

  const searchRef = useRef<HTMLInputElement | null>(null);
  /** The panel's one list: the repositories, or the branches (with one repository, its current branch first). */
  const listRef = useRef<PanelListHandle | null>(null);
  const [listHost, listSize] = useElementSize<HTMLDivElement>();
  const theme = useVsCodeTheme();
  const dark = theme === 'dark' || theme === 'high-contrast';

  useEffect(() => {
    // The pick is the host's (POST-P14ce): not written here any more.
    api.setState({
      toggled: [...toggled],
      ...(tab !== undefined ? { tab } : {}),
    } satisfies Persisted);
  }, [api, tab, toggled]);

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
  /** What the branches are filtered by: the field's text, less an `@` being typed. */
  const filterText = withoutMention(query, mention);
  const ui: PanelUiState = useMemo(
    () => ({
      query: filterText,
      scope,
      toggled,
      ...(openCard !== undefined ? { openCard } : {}),
      ...(tab !== undefined ? { tab } : {}),
      detailsOf,
      openGroups,
    }),
    [detailsOf, filterText, openCard, openGroups, scope, tab, toggled],
  );
  const model = useMemo(() => (state ? buildPanel(state, ui) : undefined), [state, ui]);
  const searching = filterText.trim().length > 0;

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

  /**
   * The filter takes the keyboard, with `text` typed on: a key pressed in the
   * list, or (POST-P14co) one pressed in the Repositories panel, which has no
   * filter of its own and hands it to this one through the host.
   */
  const focusSearch = useCallback((text?: string) => {
    if (ROLE === 'repositories') {
      void rpc.request(BRANCHES_METHODS.searchFor, text !== undefined ? { text } : {}).catch(() => undefined);
      return;
    }
    const el = searchRef.current;
    if (!el) return;
    if (text !== undefined) {
      const value = el.value + text;
      setQuery(value);
      // An `@` typed on opens the picker, as one typed in the filter does.
      setMention(modelRef.current?.multi === true ? mentionAt(value, value.length) : undefined);
      setPickerActive(0);
    }
    requestAnimationFrame(() => {
      el.focus();
      if (text === undefined) el.select();
      else el.setSelectionRange(el.value.length, el.value.length);
    });
  }, []);

  /**
   * The picker closed (POST-P14co): the `@` and what followed it leave the
   * filter, which they were never part of, and the caret goes where the `@` was.
   */
  const closePicker = useCallback(() => {
    const m = mentionNow.current;
    if (m === undefined) return;
    setMention(undefined);
    setQuery((q) => withoutMention(q, m));
    const el = searchRef.current;
    if (el !== null && document.activeElement === el) {
      requestAnimationFrame(() => el.setSelectionRange(m.start, m.start));
    }
  }, []);

  // ---- the repositories picked (POST-P14ce) ---------------------------------
  /**
   * The host's pick, taken as this panel's: at its first state, from a pick made
   * elsewhere, or as the answer to one made here. A pick that changes closes
   * the open card, which may be a branch now out of view.
   */
  const adoptScope = useCallback((roots: readonly string[]) => {
    if (sameRoots(scopeNow.current, roots)) return;
    scopeNow.current = roots;
    setScope(roots);
    setOpenCard(undefined);
  }, []);

  /**
   * A pick made here: at once in this panel, then told to the host, which the
   * Commit window follows. The host's word on the pick waits until every pick
   * sent is answered; the last answer is the pick as kept.
   */
  const pickScope = useCallback(
    (next: readonly string[]) => {
      scopeNow.current = next;
      setScope(next);
      scopeAsks.current += 1;
      void rpc.request<{ roots?: unknown }>(BRANCHES_METHODS.setScope, { roots: [...next] }).then(
        (answer) => {
          scopeAsks.current -= 1;
          const kept = rootsOf(answer?.roots);
          if (scopeAsks.current === 0 && kept !== undefined) adoptScope(kept);
        },
        () => {
          scopeAsks.current -= 1;
        },
      );
    },
    [adoptScope],
  );

  // ---- the host ---------------------------------------------------------------
  useEffect(() => {
    const offState = rpc.onEvent(BRANCHES_METHODS.evtState, (p) => {
      const next = p as BranchPanelStateDto;
      setState(next);
      // Built before a pick on its way was kept, a state can carry the one before.
      const roots = rootsOf(next.scope);
      if (scopeAsks.current === 0 && roots !== undefined) adoptScope(roots);
    });
    const offNew = rpc.onEvent(BRANCHES_METHODS.evtNewBranch, (p) => {
      const params = (p ?? {}) as { from?: string; roots?: string[] };
      openForm({
        ...(params.from !== undefined ? { from: params.from } : {}),
        ...(params.roots !== undefined ? { roots: params.roots } : {}),
      });
    });
    // POST-P14co: with what was typed in the Repositories panel, when it came from there.
    const offFocus = rpc.onEvent(BRANCHES_METHODS.evtFocusFilter, (p) => {
      const text = (p as { text?: unknown } | undefined)?.text;
      focusSearch(typeof text === 'string' && text.length > 0 ? text : undefined);
    });
    // POST-P14ce: a pick made elsewhere: the Commit window's Show all, or a
    // repository row's Show Only This Repository there.
    const offScope = rpc.onEvent(BRANCHES_METHODS.evtScope, (p) => {
      const roots = rootsOf((p as { roots?: unknown } | undefined)?.roots);
      if (scopeAsks.current === 0 && roots !== undefined) adoptScope(roots);
    });
    // POST-P14ce: a name on the Commit window's filter bar. Held until the
    // panel's state is in, which a panel opened by it waits for.
    const offReveal = rpc.onEvent(BRANCHES_METHODS.evtRevealRepo, (p) => {
      const root = (p as { root?: unknown } | undefined)?.root;
      if (typeof root === 'string' && root.length > 0) setRevealRepo({ root });
    });
    // The pick kept here before POST-P14ce, for the host to adopt once.
    const legacy = saved.scope !== undefined && saved.scope.length > 0 ? { scope: [...saved.scope] } : {};
    void rpc.request<BranchPanelStateDto>(BRANCHES_METHODS.init, legacy).then(
      (s) => {
        setState(s);
        if (scopeAsks.current === 0) adoptScope(rootsOf(s.scope) ?? []);
      },
      () => undefined,
    );
    return () => {
      offState();
      offNew();
      offFocus();
      offScope();
      offReveal();
    };
  }, [adoptScope, focusSearch, openForm, saved]);

  // POST-P14ce: the keyboard on the row of the repository named on the Commit
  // window's filter bar, in the Repositories panel the host has brought into
  // view (POST-P14co). What is picked stays.
  const [revealRepo, setRevealRepo] = useState<{ readonly root: string } | undefined>(undefined);
  useEffect(() => {
    if (revealRepo === undefined || !state) return;
    setRevealRepo(undefined);
    const same = (a: string, b: string): boolean =>
      a.replace(/\\/g, '/').toLowerCase() === b.replace(/\\/g, '/').toLowerCase();
    const repo =
      state.repos.find((r) => r.root === revealRepo.root) ?? state.repos.find((r) => same(r.root, revealRepo.root));
    if (repo === undefined) return;
    // Once the panel is in view and its rows drawn.
    requestAnimationFrame(() => requestAnimationFrame(() => listRef.current?.focusRow(`repo:${repo.root}`)));
  }, [revealRepo, state]);

  const run = useCallback(
    (what: BranchPanelRunDto) => {
      // The New Branch form is the Branches panel's; asked for in the
      // Repositories panel, the host opens it there (POST-P14co).
      if (what.type === 'newBranch' && ROLE === 'branches') {
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
      /** The lead items belong to the host's first group: no rule between them. */
      joinLead = false,
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
      if (items.length > 0 && rest.length > 0 && !joinLead) items.push({ kind: 'separator', id: `s${n++}` });
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
      const prev = scopeNow.current;
      let next: readonly string[];
      if (!additive) next = prev.length === 1 && prev[0] === root ? [] : [root];
      else {
        const picked = prev.includes(root) ? prev.filter((r) => r !== root) : [...prev, root];
        next = picked.length >= repoCount ? [] : picked;
      }
      pickScope(next);
      // The open card may belong to a branch that is now out of view.
      setOpenCard(undefined);
    },
    [pickScope, repoCount],
  );

  /** A tick in the `@` picker (POST-P14co): the same pick a click makes, one box at a time. */
  const pickRow = useCallback(
    (row: PickerRow) => {
      if (!state) return;
      pickScope(row.kind === 'all' ? [] : pickToggled(state.repos, scopeNow.current, row.repo.root));
      setOpenCard(undefined);
    },
    [pickScope, state],
  );

  const openRepoMenu = useCallback(
    (repo: BranchPanelRepoDto, at: { x: number; y: number }) => {
      const narrowedToIt = scope.length === 1 && scope[0] === repo.root;
      const lead =
        repoCount > 1
          ? [
              narrowedToIt
                ? { label: 'Show All Repositories', icon: 'list-flat', run: () => pickScope([]) }
                : { label: 'Show Only This Repository', icon: 'filter', run: () => pickScope([repo.root]) },
            ]
          : [];
      void rpc.request<BranchPanelMenuItemDto[]>(BRANCHES_METHODS.menu, { root: repo.root }).then(
        // The host's menu starts with the ways of looking at the repository
        // (Show in New Log Tab); Show Only This Repository is one too.
        (items) => showMenu(items ?? [], at, `Actions for ${repo.label}`, lead, true),
        () => undefined,
      );
    },
    [pickScope, repoCount, scope, showMenu],
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
          // The current branch's own Show in New Log Tab stands above: the
          // repository's, its history at HEAD, would say the same twice.
          const own = items.length > 0 ? withoutRepositoryLogTab(b ?? []) : (b ?? []);
          if (items.length > 0 && own.length > 0) {
            items.push({ kind: 'separator' }, { kind: 'header', label: 'Repository' });
          }
          items.push(...own);
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
      // POST-P14bx, POST-P14by: Update, Commit and Push act on what is in view,
      // the project or the repositories picked.
      const inView = viewActions(state.repos, model.scopeRepos);
      const act = (verb: BranchPanelInViewVerb) => () => run({ type: 'inView', verb, roots: inView.roots });
      // IntelliJ's keys, named only when its keymap binds them (POST-QA), and
      // only on the project's actions, which are what the keys run.
      const key = (accelerator: string) => (keymap && inView.project ? { accelerator } : {});
      const items: MenuItem[] = [
        item('update', inView.update, act('update'), { icon: 'arrow-down', ...key('Ctrl+T') }),
        // From each remote branch as it was last fetched: instant, and offline.
        item('updateWithoutFetch', inView.updateWithoutFetch, act('updateWithoutFetch')),
        item('commit', inView.commit, act('commit'), { icon: 'git-commit', ...key('Ctrl+K') }),
        item('push', inView.push, act('push'), { icon: 'arrow-up', ...key('Ctrl+Shift+K') }),
        { kind: 'separator', id: 's1' },
        item('new', 'New Branch…', () => openForm({ from: 'HEAD' }), { icon: 'add' }),
        // One repository's checkout: offered here only while one is in view. With
        // several, this menu could not say which it would act on; each
        // repository's own menu has it, and acts on that one.
        ...(single !== undefined
          ? [item('revision', 'Checkout Tag or Revision…', () => runCommand('gittree.branches.checkoutRevision', single))]
          : []),
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
    listRef.current?.focusRow(TABS_ID);
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
  // view and the toolbar's switch on. Off, each row names its repositories in
  // words instead (`row.where`), and a branch's card lists them either way
  // (`model.markers`), so turning them off hides nothing.
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
  // POST-P14co: what an `@` is for, at the end of what the field says before
  // anything is typed, as VS Code's Quick Open says what its `:` and `@` do.
  const placeholder = !model.multi
    ? 'Filter branches'
    : narrowed
      ? `Filter branches in ${scopeLabel} (type @ to pick repositories)`
      : `Filter branches in ${state.repos.length} repositories (type @ to pick repositories)`;
  const fetchBusy = fetching || state.fetchingAll;
  const firstBranchId = model.rows.find((r) => r.kind === 'branch')?.id;

  // ---- the panel's one list (POST-P14co) -------------------------------------
  // The Repositories panel lists the repositories; the Branches panel the tabs
  // and the branches, after the current branch with one repository, which has
  // no Repositories panel (its `when` is several).
  const listRows: readonly PanelRow[] =
    ROLE === 'repositories' ? model.repoRows : model.multi ? model.branchRows : model.rows;
  /** Down or Enter in the filter: into the list, on the row the keyboard had, else the first. */
  const enterList = (): void => {
    const first = listRows[0];
    if (first === undefined) return;
    listRef.current?.focusRow(focusId !== undefined && listRows.some((r) => r.id === focusId) ? focusId : first.id);
  };

  // ---- the `@` picker (POST-P14co) ----------------------------------------------
  const picker = mention !== undefined ? pickerRows(state.repos, scope, mention.query) : undefined;
  const activeRow = picker !== undefined && picker.length > 0 ? Math.min(pickerActive, picker.length - 1) : -1;
  /** The field's text and caret as they are now: what the picker opens, follows and closes on. */
  const readFilter = (el: HTMLInputElement): void => {
    const next = model.multi ? mentionAt(el.value, el.selectionStart) : undefined;
    if (next?.query !== mention?.query || (next === undefined) !== (mention === undefined)) setPickerActive(0);
    setQuery(el.value);
    setMention(next);
  };
  /**
   * The caret moved without typing: the picker's query is what lies between
   * the `@` and the caret, and with the caret before the `@` it closes.
   */
  const followCaret = (el: HTMLInputElement): void => {
    if (mention === undefined) return;
    const next = mentionAt(el.value, el.selectionStart);
    if (next === undefined || next.start !== mention.start) closePicker();
    else if (next.end !== mention.end) setMention(next);
  };

  /**
   * A row's buttons. `project`: the workspace's only repository, whose update is
   * the project's and says so; one of several says it updates that one (POST-P14bx).
   */
  const repoButtons = (repo: BranchPanelRepoDto, project: boolean) => ({
    updateTitle: project ? 'Update Project…' : 'Update Repository…',
    onUpdate: () => runCommand(project ? 'gittree.update.dialog' : 'gittree.update.repository', repo.root),
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
            buttons={repoButtons(row.repo, false)}
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
              // The only repository's row: its update is the project's.
              ...repoButtons(row.repo, true),
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
          }${row.where !== undefined ? `, ${row.where.spoken}` : ''}`
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

  /** The list's rows' drawing, words and gestures, and the row the keyboard keeps. */
  const listProps = () => {
    const onFocusId = (id: string): void => setFocusId(id);
    return {
      focusedId: focusId,
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

  const menuView = menu ? (
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
  ) : null;

  // ---- the Repositories panel (POST-P14co): its list, and the line at its foot ----
  if (ROLE === 'repositories') {
    return (
      <div className="gtp-root">
        <div className="gtp-list-host" ref={listHost}>
          {listSize.height > 0 ? (
            <PanelList
              ref={listRef}
              id="gtp-repos-list"
              rows={listRows}
              height={listSize.height}
              ariaLabel="Repositories"
              {...listProps()}
            />
          ) : null}
        </div>
        {menuView}
        {/* VS Code's divider between this panel and the Branches panel lies
            along its foot: the line there says where to grab it, as the one
            between the two panes did (POST-P14bu), and as the Commit view's does. */}
        <div className="gtp-edge" aria-hidden="true" />
      </div>
    );
  }

  // ---- the Branches panel: the toolbar, the form, the list -----------------------
  const pickerOpen = picker !== undefined;
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
              onClick={() => pickScope([])}
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
            // POST-P14co: with several repositories the field is a combobox,
            // its `@` list the listbox it controls while open.
            {...(model.multi
              ? {
                  role: 'combobox',
                  'aria-expanded': pickerOpen,
                  'aria-autocomplete': 'list' as const,
                  ...(pickerOpen ? { 'aria-controls': REPO_PICKER_ID } : {}),
                  ...(activeRow >= 0 ? { 'aria-activedescendant': pickerRowId(activeRow) } : {}),
                }
              : {})}
            onChange={(e) => readFilter(e.currentTarget)}
            onSelect={(e) => followCaret(e.currentTarget)}
            onBlur={closePicker}
            onKeyDown={(e) => {
              if (picker !== undefined) {
                // The picker's keys while it is open; anything else is typed on into its query.
                if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                  e.preventDefault();
                  if (picker.length === 0) return;
                  const step = e.key === 'ArrowDown' ? 1 : -1;
                  setPickerActive((activeRow + step + picker.length) % picker.length);
                } else if (e.key === 'Enter') {
                  e.preventDefault();
                  const row = picker[activeRow];
                  if (row !== undefined) pickRow(row);
                  closePicker();
                } else if (e.key === 'Escape') {
                  e.preventDefault();
                  closePicker();
                } else if (e.key === 'Tab') {
                  closePicker();
                }
                return;
              }
              if (e.key === 'Escape') {
                e.preventDefault();
                if (query.length > 0) setQuery('');
                else if (focusId !== undefined) enterList();
              } else if (e.key === 'ArrowDown' || e.key === 'Enter') {
                if (!searching) {
                  e.preventDefault();
                  enterList();
                  return;
                }
                if (firstBranchId === undefined) return;
                e.preventDefault();
                listRef.current?.focusRow(firstBranchId);
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
                setMention(undefined);
                searchRef.current?.focus();
              }}
            >
              <Codicon name="close" />
            </button>
          ) : null}
          {picker !== undefined ? (
            <RepoPicker
              rows={picker}
              active={activeRow}
              query={mention?.query ?? ''}
              colorOf={colorOf}
              onPick={pickRow}
              onActive={setPickerActive}
            />
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
      <div className="gtp-list-host" ref={listHost}>
        {listSize.height > 0 ? (
          <PanelList
            ref={listRef}
            id="gtp-branches-list"
            rows={listRows}
            height={listSize.height}
            ariaLabel="Branches"
            stickyId={TABS_ID}
            onEdge={(direction) => {
              // Up from the first row: the filter, which is over the list.
              if (direction < 0) searchRef.current?.focus();
            }}
            {...listProps()}
          />
        ) : null}
      </div>
      {menuView}
    </div>
  );
}
