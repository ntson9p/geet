/**
 * The Branches panel (new-way-4).
 *
 * Top to bottom: a toolbar (the filter, Fetch, New Branch, more); the New
 * Branch form while it is open; then one list — every repository with what it
 * has checked out (or, with one repository, its current branch), then the
 * recent and starred branches, every local branch, the remote ones and the
 * tags.
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
  targetOf,
  type BranchEntry,
  type PanelRow,
  type PanelUiState,
  type QuickAction,
} from './model';
import { NewBranchForm, type NewBranchRequest } from './NewBranchForm';
import { PanelList, type PanelListHandle } from './PanelList';
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
}

interface OpenMenu {
  readonly items: MenuItem[];
  readonly at: { readonly x: number; readonly y: number };
  readonly label: string;
  readonly runs: ReadonlyMap<string, () => void>;
}

/** What a card's facts depend on: when any of it moves, the card asks again. */
function detailsKey(entry: BranchEntry): string {
  return `${entry.key}|${entry.presence
    .map(
      (p) =>
        `${p.repo.root}@${p.ref.sha}:${p.repo.headSha ?? ''}:${p.repo.head ?? ''}:${p.ref.current === true ? 1 : 0}:${
          p.repo.merged.includes(entry.name) ? 1 : 0
        }:${p.ref.gone === true ? 1 : 0}`,
    )
    .join(',')}`;
}

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
  const [openCard, setOpenCard] = useState<string | undefined>(undefined);
  const [focusedId, setFocusedId] = useState<string | undefined>(undefined);
  const [details, setDetails] = useState<ReadonlyMap<string, BranchPanelDetailsDto>>(new Map());
  const [menu, setMenu] = useState<OpenMenu | null>(null);
  const [form, setForm] = useState<NewBranchRequest | null>(null);
  const [dropOver, setDropOver] = useState<string | undefined>(undefined);
  /** `<card row id>|<button label>` of a card button whose action is running. */
  const [runningButton, setRunningButton] = useState<string | undefined>(undefined);
  const [fetching, trackFetch] = useBusy();

  const searchRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<PanelListHandle | null>(null);
  const [listHost, listSize] = useElementSize<HTMLDivElement>();
  const theme = useVsCodeTheme();
  const dark = theme === 'dark' || theme === 'high-contrast';

  useEffect(() => {
    api.setState({ scope: [...scope], toggled: [...toggled] } satisfies Persisted);
  }, [api, scope, toggled]);

  const ui: PanelUiState = useMemo(
    () => ({ query, scope, toggled, ...(openCard !== undefined ? { openCard } : {}) }),
    [openCard, query, scope, toggled],
  );
  const model = useMemo(() => (state ? buildPanel(state, ui) : undefined), [state, ui]);
  const searching = query.trim().length > 0;

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
  const openKey = openEntry !== undefined ? detailsKey(openEntry) : undefined;
  const openEntryRef = useRef(openEntry);
  openEntryRef.current = openEntry;
  useEffect(() => {
    const entry = openEntryRef.current;
    if (entry === undefined || openKey === undefined || details.has(openKey)) return undefined;
    let live = true;
    void rpc.request<BranchPanelDetailsDto>(BRANCHES_METHODS.details, { target: targetOf(entry) }).then(
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
      void rpc.request<BranchPanelMenuItemDto[]>(BRANCHES_METHODS.menu, { target: targetOf(entry) }).then(
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
          ? rpc.request<BranchPanelMenuItemDto[]>(BRANCHES_METHODS.menu, { target: targetOf(row.entry) })
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
        item('update', 'Update Project…', () => runCommand('gittree.update.dialog', single), {
          icon: 'arrow-down',
          accelerator: 'Ctrl+T',
        }),
        item('commit', 'Commit…', () => runCommand('gittree.commit', single), {
          icon: 'git-commit',
          accelerator: 'Ctrl+K',
        }),
        item('push', 'Push…', () => runCommand('gittree.push.dialog', single), {
          icon: 'arrow-up',
          accelerator: 'Ctrl+Shift+K',
        }),
        { kind: 'separator', id: 's1' },
        item('new', 'New Branch…', () => openForm({ from: 'HEAD' }), { icon: 'add' }),
        item('revision', 'Checkout Tag or Revision…', () =>
          runCommand('gittree.branches.checkoutRevision', single),
        ),
        item('cleanup', 'Clean Up Branches…', () => runCommand('gittree.branches.cleanup', single), {
          icon: 'trash',
        }),
        { kind: 'separator', id: 's2' },
        { kind: 'header', id: 'h1', label: 'Show' },
        item('tags', 'Tags', () => setSetting('showTags', !state.showTags), { checked: state.showTags }),
        item('inout', 'Incoming / Outgoing Counts', () => setSetting('showIncomingOutgoing', !state.showInOut), {
          checked: state.showInOut,
        }),
        item('folders', 'Group by Folder', () => setSetting('groupByFolder', !state.groupByFolder), {
          checked: state.groupByFolder,
        }),
        { kind: 'separator', id: 's3' },
        item(
          'collapse',
          'Collapse All',
          () => {
            // Back to how the panel starts: every folder, Remote and Tags shut.
            setToggled(() => {
              const next = new Set<string>();
              for (const r of model.rows) {
                if ((r.kind === 'folder' || r.kind === 'remote') && r.open) next.add(r.id);
              }
              return next;
            });
            setOpenCard(undefined);
          },
          { icon: 'collapse-all' },
        ),
      ];
      setMenu({ items, at, label: 'More actions', runs });
    },
    [model, openForm, runCommand, setSetting, state],
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

  const activate = useCallback(
    (row: PanelRow, e?: { ctrlKey: boolean; metaKey: boolean; detail?: number }) => {
      switch (row.kind) {
        case 'section':
          if (!searching) toggle(row.id);
          return;
        case 'remote':
        case 'folder':
          toggle(row.id);
          return;
        case 'repo':
          toggleScope(row.repo.root, e?.ctrlKey === true || e?.metaKey === true);
          return;
        case 'head':
        case 'branch':
          // The second click of a double-click would shut what the first opened.
          if ((e?.detail ?? 1) > 1) return;
          toggleCard(row.id);
          return;
        case 'hint':
          if (row.create !== undefined) openForm({ from: 'HEAD', name: row.create });
          return;
        case 'operation':
          return;
      }
    },
    [openForm, searching, toggle, toggleCard, toggleScope],
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
      const open =
        row.kind === 'section' || row.kind === 'folder' || row.kind === 'remote'
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
      if (e.key === 'ArrowLeft' && open === true && !(row.kind === 'section' && searching)) {
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
    [activate, focusSearch, openRowMenu, run, searching],
  );

  // ---- rendering ----------------------------------------------------------------------
  if (!state || !model) return <div className="gtp-empty">Loading…</div>;
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
    indent: number,
    menuFor: (at: { x: number; y: number }) => void,
    detachedAt?: string,
  ) => (
    <BranchCard
      entry={entry}
      details={entry !== undefined ? details.get(detailsKey(entry)) : { repos: [], buttons: [] }}
      markers={model.markers}
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
          row.section === 'repos' && narrowed ? (
            <button
              type="button"
              className="gtp-link"
              tabIndex={-1}
              onClick={(e) => {
                e.stopPropagation();
                setScope([]);
              }}
            >
              Show all
            </button>
          ) : row.section === 'local' ? (
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
            card={row.card ? card(row.id, row.entry, 8, headMenu, row.repo.headSha?.slice(0, 8)) : null}
          />
        );
      }
      case 'operation':
        return (
          <OperationRow
            repo={row.repo}
            onRun={(command) =>
              runCommand(command, command === 'gittree.conflicts.focus' ? undefined : row.repo.root)
            }
          />
        );
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
              markers={model.markers}
              scopeRepos={model.scopeRepos}
              colorOf={colorOf}
              onQuick={(action, e) => onQuick(row.entry, action, e)}
              card={
                row.card
                  ? card(row.id, row.entry, 8 + row.depth * INDENT + 20, (at) => openBranchMenu(row.entry, at))
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
                else if (focusedId !== undefined) listRef.current?.focusRow(focusedId);
              } else if (e.key === 'ArrowDown' || e.key === 'Enter') {
                const id = searching ? firstBranchId : (focusedId ?? model.rows[0]?.id);
                if (id === undefined) return;
                e.preventDefault();
                listRef.current?.focusRow(id);
                if (e.key === 'Enter' && searching) setOpenCard(id);
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
            rows={model.rows}
            height={listSize.height}
            ariaLabel="Branches"
            focusedId={focusedId}
            onFocusId={setFocusedId}
            renderRow={renderRow}
            rowClassName={(row) => `gtp-kind-${row.kind}`}
            rowAttributes={(row) => {
              const level =
                row.kind === 'branch' || row.kind === 'folder' || row.kind === 'remote' ? row.depth + 2 : 1;
              const expanded =
                row.kind === 'section' || row.kind === 'folder' || row.kind === 'remote'
                  ? row.open
                  : row.kind === 'branch' || row.kind === 'head'
                    ? row.card
                    : undefined;
              const label =
                row.kind === 'branch'
                  ? `${row.entry.name}${row.entry.currentIn.length > 0 ? ', checked out' : ''}`
                  : row.kind === 'repo'
                    ? `${row.repo.label}, on ${row.repo.head ?? 'a detached HEAD'}${row.repo.fetching ? ', fetching' : ''}`
                    : row.kind === 'head'
                      ? `Current branch ${row.repo.head ?? 'detached HEAD'}`
                      : row.kind === 'section'
                        ? `${row.label}, ${row.count}`
                        : undefined;
              return {
                'aria-level': level,
                ...(expanded !== undefined ? { 'aria-expanded': expanded } : {}),
                ...(row.kind === 'repo' ? { 'aria-selected': row.inScope && narrowed } : {}),
                ...(label !== undefined ? { 'aria-label': label } : {}),
              };
            }}
            onRowKeyDown={onRowKeyDown}
            onRowClick={(row, e) =>
              activate(row, { ctrlKey: e.ctrlKey, metaKey: e.metaKey, detail: e.detail })
            }
            onRowContextMenu={(row, e) => {
              e.preventDefault();
              setFocusedId(row.id);
              const keyboard = e.button === -1 || (e.clientX === 0 && e.clientY === 0);
              const r = rowRect(row.id);
              openRowMenu(
                row,
                keyboard ? { x: (r?.left ?? 0) + 24, y: (r?.top ?? 0) + 22 } : { x: e.clientX, y: e.clientY },
              );
            }}
          />
        ) : null}
      </div>
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
