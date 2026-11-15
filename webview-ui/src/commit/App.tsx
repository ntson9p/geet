/**
 * Commit tool window (P11-T2). Layout follows the gap analysis §2A, made
 * compact by POST-P14ca:
 *
 *   tabs + toolbar  ->  change tree (flex)  ->  divider  ->  bottom block
 *
 * The toolbar shares the tabs' row and folds what does not fit into `⋯`. The
 * bottom block is the Amend row (the message menus, the `N of M` counter and
 * the options gear), the message editor at the height the divider gives it,
 * and one full-width `[✓ Commit | ▾]` whose ▾ holds Commit and Push…. P11-T4
 * replaced the editor with the IME/undo-hardened one; P11-T5 fills in the gear
 * popup; P11-T6 adds the `Shelf` tab beside `Commit`.
 *
 * The host owns every piece of state. This component renders what it is given
 * and posts intents, so a status refresh or a rehydrate can never desync it.
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FocusEvent as ReactFocusEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import {
  commitGroupByOf,
  COMMIT_METHODS,
  type CommitDiffFileDto,
  type CommitDiffOnScreenDto,
  type CommitFileDiffDto,
  type CommitGenerateParamsDto,
  type CommitGroupBy,
  type CommitHistoryDto,
  type CommitMessageEvtDto,
  type CommitOpenDiffParamsDto,
  type CommitRecentCommitsDto,
  type CommitRunParamsDto,
  type CommitSetAllCheckedParamsDto,
  type CommitSetCheckedManyParamsDto,
  type CommitSetGroupByParamsDto,
  type CommitSetIncludedParamsDto,
  type CommitStashStateDto,
  type CommitStateDto,
  type CommitSetCheckedParamsDto,
  type CommitStageParamsDto,
  type CommitMessageFocusParamsDto,
  type CommitTreeFocusParamsDto,
} from '../../../src/shared/protocol';
import {
  FileTree,
  type FileTreeAction,
  type FileTreeBadge,
  type FileTreeDecoration,
  type FileTreeHandle,
  type FileTreeRestore,
  type FileTreeViewState,
} from '../lib/FileTree';
import { InlineDiff } from '../lib/InlineDiff';
import { Menu, type MenuItem } from '../lib/Menu';
import { NO_MENU } from '../lib/menuContext';
import { OverflowToolbar, type OverflowAction } from '../lib/OverflowToolbar';
import { TriCheckbox } from '../lib/TriCheckbox';
import { RpcClient, RpcRequestError } from '../lib/rpc';
import { dirStatusColor, statusColor } from '../lib/status';
import { SplitPane } from '../lib/SplitPane';
import { TabPanel, Tabs } from '../lib/Tabs';
import { ToolbarButton } from '../lib/Toolbar';
import {
  allDirPaths,
  ancestorDirs,
  collectFiles,
  countFiles,
  selectedFiles,
  selectionFollowing,
  type ToggleDelta,
  type TreeNode,
} from '../lib/treeModel';
import { useBusy } from '../lib/useBusy';
import { useElementSize } from '../lib/useElementSize';
import { useVsCodeTheme } from '../lib/useVsCodeTheme';
import { getVsCodeApi } from '../lib/vscodeApi';
import { laneColor } from '../log/GraphCanvas';
import {
  allDiffFiles,
  assembleCommitTree,
  collapsedAll,
  commitDiffWalk,
  fileCountLabel,
  fileRowContext,
  fileSide,
  folderRowContext,
  groupByOf,
  groupRowContext,
  headLabel,
  iconFor,
  isConflictsRow,
  layoutOf,
  listContext,
  listDescription,
  multiRepoOf,
  originText,
  partialLabel,
  revealRequestOf,
  splitDelta,
  statusLook,
  tickAllState,
  treePathOf,
  twinRow,
  twinRows,
  type CommitTreeModel,
} from './commitTree';
import { filterEmptyText } from './repoFilter';
import { RepoFilterBar } from './RepoFilterBar';
import { firstLine, relativeTime } from './format';
import { answersCommitAsk, onMac } from './commitKey';
import {
  clampMessageHeight,
  fitMessageHeight,
  LIST_FLOOR_PX,
  popupPlacement,
  savedMessageHeight,
  type Placement,
} from './commitLayout';
import { MessageDivider } from './MessageDivider';
import { MessageEditor, type MessageEditorHandle, type MessageMetrics } from './MessageEditor';
import { OptionsPopup } from './OptionsPopup';
import { answersRevealAsk, isWindowsRevealChord, onWindows } from './revealKey';
import { ShelfTab } from './ShelfTab';
import { StashTab } from './StashTab';
import { applyViewOption, viewOptionsChanged, viewOptionsItems } from './viewOptions';

interface Persisted {
  tab?: string;
  /** Open rows of both groupings: their paths never collide, so each keeps its own. */
  expanded?: string[];
  /** The groupings that have opened every row once, as the window opens the first time. */
  seeded?: CommitGroupBy[];
  /** Rows with rows beneath them seen before; a new one opens as it appears. */
  known?: string[];
  message?: string;
  preview?: boolean;
  ratio?: number;
  /** POST-P14ca: the message box's height as the divider left it, px; absent for its first height. */
  messageHeight?: number;
}

/** A change of grouping on its way: where the user was, to be found again in the rebuilt tree. */
interface PendingRegroup {
  readonly from: CommitTreeModel;
  readonly view: FileTreeViewState;
  readonly selection: ReadonlySet<string>;
}

/**
 * Commit and rollback open modals and run checks, so they can legitimately sit
 * unanswered far longer than the client's 30 s default.
 */
const INTENT_TIMEOUT_MS = 10 * 60_000;

/** POST-P14bq: the reveal key's Windows chord is answered in the tree (see revealKey.ts). */
const ON_WINDOWS = onWindows(navigator.userAgent);

/** Below this width the preview diff is one column: two sides would each get a few characters. */
const UNIFIED_BELOW_PX = 640;

/** POST-P14ca: the commit key as the ▾ menu shows it, the keybinding's `mac` or `key`. */
const COMMIT_KEY_LABEL = onMac(navigator.userAgent) ? '⌘Enter' : 'Ctrl+Enter';

const EMPTY: CommitStateDto = {
  repos: [],
  targets: [],
  message: '',
  amend: false,
  signing: false,
  busy: false,
  modifiedCount: 0,
  checkedCount: 0,
  paradigm: 'changelists',
};

/** POST-P14ce: which repositories the list shows, as one key; empty for every one. */
function shownKeyOf(state: CommitStateDto): string {
  return state.filter !== undefined ? state.filter.shown.map((repo) => repo.root).join('\n') : '';
}

/** POST-P14ce: every row's path, the rows inside shut ones too. */
function rowPaths(nodes: readonly TreeNode[], into: Set<string> = new Set()): Set<string> {
  for (const node of nodes) {
    into.add(node.path);
    if (node.kind === 'dir') rowPaths(node.children, into);
  }
  return into;
}

/** A message dropdown (history clock or Amend ▾), anchored under its button. */
interface MessageMenu {
  label: string;
  x: number;
  y: number;
  items: MenuItem[];
  /** Index-aligned with `items`: the full multi-line message each inserts. */
  messages: string[];
}

export function App() {
  const rpc = useMemo(() => new RpcClient(), []);
  const api = useMemo(() => getVsCodeApi(), []);
  const saved = (api.getState() as Persisted | undefined) ?? {};

  const [state, setState] = useState<CommitStateDto>(EMPTY);
  const [ready, setReady] = useState(false);
  const [tab, setTab] = useState(saved.tab ?? 'commit');
  // Read by the host's events, which outlive a render.
  const tabRef = useRef(tab);
  tabRef.current = tab;
  // POST-P14l: IntelliJ's `Combine stashes and shelves in one tab`. Off by
  // default, so the strip is `Commit | Shelf | Stash`; on, the Stash tab folds
  // into the Shelf tab and the third tab disappears.
  const [combined, setCombined] = useState(false);

  useEffect(() => {
    const off = rpc.onEvent(COMMIT_METHODS.evtStash, (payload) => {
      setCombined((payload as CommitStashStateDto | undefined)?.combined === true);
    });
    rpc
      .request<CommitStashStateDto>(COMMIT_METHODS.stashState)
      .then((next) => setCombined(next?.combined === true), () => undefined);
    return off;
  }, [rpc]);

  // Turning the setting on while the Stash tab is showing would leave `tab`
  // naming a tab that no longer exists, and every panel renders null.
  useEffect(() => {
    if (combined && tab === 'stash') setTab('shelf');
  }, [combined, tab]);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(
    () => new Set(saved.expanded ?? []),
  );
  // A state saved before groupings existed opened every row once already, in
  // the only grouping there was.
  const [seeded, setSeeded] = useState<ReadonlySet<CommitGroupBy>>(
    () => new Set(saved.seeded ?? ((saved.expanded ?? []).length > 0 ? ['changelist'] : [])),
  );
  const [known, setKnown] = useState<ReadonlySet<string>>(() => new Set(saved.known ?? []));
  // Nor did it note the rows it had seen: the first tree's are taken as seen,
  // or every row the user had shut would open again.
  const migrateKnown = useRef(saved.known === undefined && (saved.expanded ?? []).length > 0);
  const [selection, setSelection] = useState<ReadonlySet<string>>(() => new Set());
  const [reveal, setReveal] = useState<{ readonly path: string } | undefined>(undefined);
  const [restore, setRestore] = useState<FileTreeRestore | undefined>(undefined);
  const [viewMenu, setViewMenu] = useState<{ readonly x: number; readonly y: number } | null>(null);
  const treeHandle = useRef<FileTreeHandle>(null);
  const regroup = useRef<PendingRegroup | undefined>(undefined);
  // The file a diff opened from the list is showing, while it is on screen.
  const [diffOnScreen, setDiffOnScreen] = useState<CommitDiffFileDto | undefined>(undefined);
  // Mirror of the uncontrolled editor's value — drives `canCommit`, the
  // webview-state persist, and re-seeds the editor when its TabPanel remounts
  // after a Shelf-tab round trip (P11-T6). The editor owns the DOM value; a
  // changing `initial` never touches it after mount, and mid-composition the
  // mirror is frozen because onInput is suppressed (P11-T4).
  const [message, setMessage] = useState(saved.message ?? '');
  const [menu, setMenu] = useState<MessageMenu | null>(null);
  const [optionsOpen, setOptionsOpen] = useState(false);
  // POST-P14ca: where the options popup opens, from the gear's place on screen.
  const [optionsAt, setOptionsAt] = useState<Placement | undefined>(undefined);
  // POST-P14ca: the ▾ beside Commit, open at these viewport coordinates.
  const [commitMenuAt, setCommitMenuAt] = useState<{ readonly x: number; readonly y: number } | null>(null);
  const [preview, setPreview] = useState(saved.preview ?? false);
  const [ratio, setRatio] = useState(saved.ratio ?? 0.55);
  // POST-P14ca: the height the divider gave the message box; undefined for its first one.
  const [messageHeight, setMessageHeight] = useState<number | undefined>(() =>
    savedMessageHeight(saved.messageHeight),
  );
  const [messageMetrics, setMessageMetrics] = useState<MessageMetrics | undefined>(undefined);
  const [diff, setDiff] = useState<CommitFileDiffDto | undefined>(undefined);
  const [rpcError, setRpcError] = useState<string | undefined>(undefined);
  const [treeRef, treeSize] = useElementSize<HTMLDivElement>();
  const [diffRef, diffSize] = useElementSize<HTMLDivElement>();
  // POST-P14ca: the list and the message box share what these two have between them.
  const [bodyRef, bodySize] = useElementSize<HTMLDivElement>();
  const [slotRef, slotSize] = useElementSize<HTMLDivElement>();
  // The repositories' colours have a light and a dark shade, as the log's lanes do.
  const theme = useVsCodeTheme();
  const dark = theme === 'dark' || theme === 'high-contrast';
  const editorRef = useRef<MessageEditorHandle | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;

  const model = useMemo(() => assembleCommitTree(state), [state]);
  const modelRef = useRef(model);
  modelRef.current = model;
  const selectionRef = useRef(selection);
  selectionRef.current = selection;

  const apply = useCallback((next: CommitStateDto) => {
    // Another grouping rebuilds every row: note where the user is while the old
    // rows still stand, to put them back on the same rows once it is drawn.
    const before = modelRef.current;
    // POST-P14cb: so does a switch between folder rows and a list.
    if ((groupByOf(next) !== before.groupBy || layoutOf(next) !== before.layout) && before.nodes.length > 0) {
      regroup.current = {
        from: before,
        view: treeHandle.current?.viewState() ?? { atTop: true },
        selection: selectionRef.current,
      };
    } else if (shownKeyOf(next) !== shownKeyOf(stateRef.current) && before.nodes.length > 0) {
      // POST-P14ce: other repositories listed: the list starts again at its
      // top, where the scroll of the one before would mean nothing.
      setRestore({ top: true });
    }
    setState(next);
    setDiffOnScreen(next.diffOnScreen);
    setReady(true);
  }, []);

  useEffect(() => {
    const offState = rpc.onEvent(COMMIT_METHODS.evtState, (p) => apply(p as CommitStateDto));
    // Programmatic message writes (history pick via the native command, amend
    // prefill, post-commit clear) arrive on their own event. Generic state
    // pushes never touch the editor: they can carry a snapshot older than the
    // debounced persist, and applying one would eat the user's last keystrokes.
    const offMessage = rpc.onEvent(COMMIT_METHODS.evtMessage, (p) => {
      const m = p as CommitMessageEvtDto;
      if (m.repoRoot !== stateRef.current.activeRepo) return;
      editorRef.current?.setProgrammatic(m.message);
    });
    rpc.request<CommitStateDto>(COMMIT_METHODS.init).then(apply, () => setReady(true));
    return () => {
      offState();
      offMessage();
    };
  }, [apply, rpc]);

  // Adopt the host's message only when the repo under the editor changes —
  // which includes the first snapshot. Everything else comes via evtMessage.
  const editorRepo = useRef<{ root: string | undefined } | null>(null);
  useEffect(() => {
    if (!ready) return;
    if (editorRepo.current !== null && editorRepo.current.root === state.activeRepo) return;
    editorRepo.current = { root: state.activeRepo };
    editorRef.current?.adoptExternal(state.message);
  }, [ready, state]);

  // Expand every row the first time a grouping shows rows of its own, the way
  // the IntelliJ commit window opens; and any row the first time it appears,
  // so a repository that changes later, or files moved to another list, are
  // not found shut. A row the user shut stays shut. Before paint, and before
  // the regroup below reads what is open.
  useLayoutEffect(() => {
    if (!ready || model.nodes.length === 0) return;
    const rows = allDirPaths(model.nodes);
    const migrating = migrateKnown.current;
    migrateKnown.current = false;
    const fresh = migrating ? [] : rows.filter((path) => !known.has(path));
    // Repository › Changelist with nothing changed draws the one empty Changes
    // row: not its own rows yet, so it opens everything when they come.
    const ownRows =
      model.groupBy === 'changelist' ||
      // POST-P14cb: without changelists, whatever it draws is its own.
      model.groupBy === 'none' ||
      [...model.groups.values()].some((g) => g.kind === 'repository');
    const firstVisit = ownRows && !seeded.has(model.groupBy);
    if (firstVisit || fresh.length > 0) {
      setExpanded((prev) => {
        const next = new Set(prev);
        if (firstVisit) for (const path of allDirPaths(model.nodes)) next.add(path);
        for (const path of fresh) next.add(path);
        return next;
      });
    }
    if (firstVisit) setSeeded((prev) => new Set([...prev, model.groupBy]));
    if (migrating || fresh.length > 0) setKnown((prev) => new Set([...prev, ...rows]));
  }, [known, model, ready, seeded]);

  // The grouping changed: the same files stay selected, the keyboard stays on
  // the same row, and the row the user was looking at goes back where it was.
  useLayoutEffect(() => {
    const pending = regroup.current;
    if (pending === undefined || pending.from.groupBy === model.groupBy) return;
    regroup.current = undefined;
    const { from, view } = pending;
    const lead = view.lead !== undefined ? twinRow(from, model, view.lead) : undefined;
    const anchor = view.anchor !== undefined ? twinRow(from, model, view.anchor.path) : undefined;
    // Shut folders would hide them.
    const open = [lead, anchor].flatMap((path) => (path === undefined ? [] : ancestorDirs(model.nodes, path)));
    if (open.length > 0) setExpanded((prev) => new Set([...prev, ...open]));
    setSelection(new Set(twinRows(from, model, pending.selection)));
    // At the very top it stays at the top: that is where it was.
    const top = view.atTop && (view.anchor?.offset ?? 0) <= 0;
    setRestore({
      ...(top
        ? { top: true }
        : anchor !== undefined && view.anchor !== undefined
          ? { anchor: { path: anchor, offset: view.anchor.offset } }
          : {}),
      ...(lead !== undefined ? { lead } : {}),
    });
  }, [model]);

  // POST-P14ce: a row gone from the list — its repository left out by the
  // Repositories panel's pick, or its file committed — is no longer selected,
  // so Rollback, Show Diff and the preview never act on a row not on screen.
  // After the regroup above, whose twins are rows of this list.
  useLayoutEffect(() => {
    const live = rowPaths(model.nodes);
    setSelection((prev) =>
      [...prev].every((path) => live.has(path)) ? prev : new Set([...prev].filter((path) => live.has(path))),
    );
  }, [model]);

  useEffect(() => {
    api.setState({
      tab,
      expanded: [...expanded],
      seeded: [...seeded],
      known: [...known],
      message,
      preview,
      ratio,
      ...(messageHeight !== undefined ? { messageHeight } : {}),
    } satisfies Persisted);
  }, [api, expanded, known, message, messageHeight, preview, ratio, seeded, tab]);

  const activeRepo = state.activeRepo;
  // POST-P14ce: Amend, its ▾ list, the options and Shelve act on a repository
  // the list shows; the message box stays the editor's repository's.
  const commitRepo = state.commitRepo ?? activeRepo;
  const multiRepo = multiRepoOf(state);

  /**
   * Every webview→host intent is an RPC **request**, matching what
   * `WebviewRpcHost.on()` registers. `sendEvent` posts `kind: 'evt'`, which
   * only reaches `onEvent` listeners — a mismatch no handler ever sees, so it
   * fails in total silence. Reporting the rejection is the point: an intent
   * that never lands must be visible, not invisible.
   */
  const request = useCallback(
    (method: string, params: unknown = {}): Promise<void> =>
      rpc.request(method, params, INTENT_TIMEOUT_MS).then(
        () => setRpcError(undefined),
        (err: unknown) => {
          // A timeout means the host is slow or the user is sitting in a modal;
          // the state push will tell the truth. Only routing and handler
          // failures are worth interrupting for.
          if (err instanceof RpcRequestError && err.code === 'timeout') return;
          setRpcError(err instanceof Error ? err.message : String(err));
        },
      ),
    [rpc],
  );
  const send = useCallback(
    (method: string, params: unknown = {}) => {
      void request(method, params);
    },
    [request],
  );

  /**
   * POST-P14bq: says when the change tree gains or loses the keyboard, which the
   * reveal key's `when` (`gittree.commitTreeFocus`) reads: VS Code clears its own
   * `focusedView` once focus is inside a webview. Not `send`: a focus change is
   * no intent, and must not clear a failure's banner.
   */
  const treeFocused = useRef(false);
  const reportTreeFocus = useCallback(
    (focused: boolean) => {
      if (treeFocused.current === focused) return;
      treeFocused.current = focused;
      void rpc
        .request(COMMIT_METHODS.treeFocus, { focused } satisfies CommitTreeFocusParamsDto, INTENT_TIMEOUT_MS)
        .catch(() => undefined);
    },
    [rpc],
  );
  /**
   * POST-P14bs: the same for the message box, which the commit key's `when`
   * (`gittree.commitMessageFocus`) reads.
   */
  const messageFocused = useRef(false);
  const reportMessageFocus = useCallback(
    (focused: boolean) => {
      if (messageFocused.current === focused) return;
      messageFocused.current = focused;
      void rpc
        .request(COMMIT_METHODS.messageFocus, { focused } satisfies CommitMessageFocusParamsDto, INTENT_TIMEOUT_MS)
        .catch(() => undefined);
    },
    [rpc],
  );
  // Another tab unmounts the tree and the box, which say nothing as they go;
  // leaving the window takes the keyboard from them too.
  useEffect(() => {
    if (tab === 'commit') return;
    reportTreeFocus(false);
    reportMessageFocus(false);
  }, [reportMessageFocus, reportTreeFocus, tab]);
  useEffect(() => {
    const away = (): void => {
      reportTreeFocus(false);
      reportMessageFocus(false);
    };
    window.addEventListener('blur', away);
    return () => window.removeEventListener('blur', away);
  }, [reportMessageFocus, reportTreeFocus]);
  /** When a key was last pressed in the tree: the host's ask is that key's for a moment after. */
  const lastTreeKeyAt = useRef(Number.NEGATIVE_INFINITY);
  /** POST-P14bq: the keyboard's row in the file manager, as Enter opens it; nothing for a list row. A repository row, its folder (POST-P14cb). */
  const revealLeadRow = useCallback(() => {
    const lead = treeHandle.current?.viewState().lead;
    const ask = lead !== undefined ? revealRequestOf(modelRef.current, lead) : undefined;
    if (ask !== undefined) send(COMMIT_METHODS.reveal, ask);
  }, [send]);
  const treeFocusProps = {
    onFocus: () => reportTreeFocus(true),
    onBlur: (e: ReactFocusEvent<HTMLDivElement>) => {
      if (!e.currentTarget.contains(e.relatedTarget)) reportTreeFocus(false);
    },
    onKeyDown: (e: ReactKeyboardEvent<HTMLDivElement>) => {
      lastTreeKeyAt.current = performance.now();
      // Windows' Shift+Alt+R is answered here, never passed on: VS Code would
      // also open its Run menu (see revealKey.ts).
      if (ON_WINDOWS && isWindowsRevealChord(e)) {
        e.preventDefault();
        e.stopPropagation();
        if (tabRef.current === 'commit') revealLeadRow();
      }
    },
  };
  /**
   * A walk over the whole list goes on following it, as IntelliJ's does: this list
   * changes while you read it, unlike a commit's. One over a selection is what was
   * selected.
   */
  const walksWholeList = useRef(false);

  const openDiffAt = useCallback(
    (treePath: string) => {
      const ref = modelRef.current.files.get(treePath);
      if (!ref) return;
      const walk = commitDiffWalk(modelRef.current, selectionRef.current, treePath);
      walksWholeList.current = !walk.explicit;
      const side = fileSide(ref);
      send(COMMIT_METHODS.openDiff, {
        repoRoot: ref.repoRoot,
        path: ref.relPath,
        // With staging, which row of the file: its staged or its unstaged half.
        ...(side !== undefined ? { side } : {}),
        files: walk.files,
      } satisfies CommitOpenDiffParamsDto);
    },
    [send],
  );

  const listKey = useMemo(
    () =>
      allDiffFiles(model)
        .map((f) => `${f.repoRoot}\n${f.path}\n${f.side ?? ''}`)
        .join('\n'),
    [model],
  );
  useEffect(() => {
    if (walksWholeList.current) {
      send(COMMIT_METHODS.diffChain, { files: allDiffFiles(modelRef.current) });
    }
  }, [listKey, send]);

  useEffect(() => {
    // The walk moved on: the row follows, and nothing opens again.
    const offMoved = rpc.onEvent(COMMIT_METHODS.evtDiffFile, (p) => {
      const current = modelRef.current;
      const treePath = treePathOf(current, p as CommitDiffFileDto);
      if (treePath === undefined) return;
      setExpanded((prev) => new Set([...prev, ...ancestorDirs(current.nodes, treePath)]));
      setSelection((prev) => selectionFollowing(current.nodes, prev, treePath));
      setReveal({ path: treePath });
    });
    const offOpen = rpc.onEvent(COMMIT_METHODS.evtOpenDiff, (p) => {
      const treePath = treePathOf(modelRef.current, p as CommitDiffFileDto);
      if (treePath !== undefined) openDiffAt(treePath);
    });
    const offOnScreen = rpc.onEvent(COMMIT_METHODS.evtDiffOnScreen, (p) => {
      setDiffOnScreen((p as CommitDiffOnScreenDto).file);
    });
    // POST-P14bq: the reveal shortcut, pressed in this window. The keyboard's
    // row, as Enter opens it; nothing from another tab, where the tree is not
    // on screen, or on a changelist or repository row.
    const offReveal = rpc.onEvent(COMMIT_METHODS.evtRevealRow, () => {
      // The key is bound only while the tree has the keyboard. An ask that
      // finds it gone is still that key's if one was pressed in the tree just
      // now (Alt may hand focus to the menu bar); otherwise nobody is looking.
      if (tabRef.current !== 'commit') return;
      if (!answersRevealAsk(treeFocused.current, lastTreeKeyAt.current, performance.now())) return;
      revealLeadRow();
    });
    return () => {
      offMoved();
      offOpen();
      offOnScreen();
      offReveal();
    };
  }, [openDiffAt, revealLeadRow, rpc]);

  // Looked up in each new tree, so a file moved to another changelist keeps its mark.
  const onScreenPath = useMemo(
    () => (diffOnScreen !== undefined ? treePathOf(model, diffOnScreen) : undefined),
    [diffOnScreen, model],
  );

  // Refresh turns until the host has re-read every repository and pushed the
  // state it found — the moment the badge and the tree are current.
  const [refreshing, trackRefresh] = useBusy();

  const onToggleCheck = useCallback(
    (delta: ToggleDelta) => {
      const parts: CommitSetCheckedParamsDto[] = splitDelta(delta, model).map((part) => ({
        repoRoot: part.repoRoot,
        paths: part.paths,
        checked: part.checked,
      }));
      if (parts.length === 1) send(COMMIT_METHODS.setChecked, parts[0]);
      // POST-P14cf: several repositories, one request: the host applies them
      // together and pushes once, not twice per repository.
      else if (parts.length > 1) send(COMMIT_METHODS.setCheckedMany, { parts } satisfies CommitSetCheckedManyParamsDto);
    },
    [model, send],
  );

  /**
   * POST-P14cf: the tick-all box on the counter: every change the list shows,
   * in the repositories it shows, ticked or unticked by the host in one go.
   */
  const setAllChecked = useCallback(
    (checked: boolean) => {
      send(COMMIT_METHODS.setAllChecked, {
        checked,
        roots: stateRef.current.repos.map((repo) => repo.root),
      } satisfies CommitSetAllCheckedParamsDto);
    },
    [send],
  );

  // This grouping's rows only, from the toolbar or the list's menu (POST-P14cf):
  // the other grouping keeps its own for when it comes back.
  const expandAllRows = useCallback(() => {
    setExpanded((prev) => new Set([...prev, ...allDirPaths(modelRef.current.nodes)]));
  }, []);
  const collapseAllRows = useCallback(() => {
    setExpanded((prev) => collapsedAll(modelRef.current, prev));
  }, []);
  useEffect(() => {
    const offExpand = rpc.onEvent(COMMIT_METHODS.evtExpandAll, expandAllRows);
    const offCollapse = rpc.onEvent(COMMIT_METHODS.evtCollapseAll, collapseAllRows);
    return () => {
      offExpand();
      offCollapse();
    };
  }, [collapseAllRows, expandAllRows, rpc]);

  const onToggleExpand = useCallback((path: string, open: boolean) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (open) next.add(path);
      else next.delete(path);
      return next;
    });
  }, []);

  /**
   * POST-QA F5: with staging, rows carry IntelliJ's + and − — Stage on what is
   * not staged yet, Unstage on what is. A folder or a group acts on the files
   * under it, one request per repository.
   */
  const stagingActions = useCallback(
    (node: TreeNode): FileTreeAction[] | undefined => {
      const leaves = node.kind === 'file' ? [node.path] : collectFiles(node);
      const refs = leaves.flatMap((p) => {
        const ref = model.files.get(p);
        return ref !== undefined ? [ref] : [];
      });
      const side = refs[0] !== undefined ? fileSide(refs[0]) : undefined;
      if (side === undefined || side === 'conflicted' || refs.some((r) => fileSide(r) !== side)) return undefined;
      const byRepo = new Map<string, string[]>();
      for (const r of refs) byRepo.set(r.repoRoot, [...(byRepo.get(r.repoRoot) ?? []), r.relPath]);
      const run = (method: string): void => {
        for (const [repoRoot, paths] of byRepo) send(method, { repoRoot, paths } satisfies CommitStageParamsDto);
      };
      return side === 'staged'
        ? [{ id: 'unstage', codicon: 'remove', title: 'Unstage', run: () => run(COMMIT_METHODS.unstage) }]
        : [{ id: 'stage', codicon: 'add', title: 'Stage', run: () => run(COMMIT_METHODS.stage) }];
    },
    [model, send],
  );

  // POST-QA: the Merge Conflicts row's Resolve, IntelliJ's link on that node,
  // in either paradigm; with staging, every other row its Stage or Unstage.
  const rowActions = useCallback(
    (node: TreeNode): FileTreeAction[] | undefined => {
      if (node.kind === 'dir' && isConflictsRow(model, node.path)) {
        const repoRoot = model.groups.get(node.path)?.repoRoot;
        return [
          {
            id: 'resolve',
            codicon: 'git-merge',
            title: 'Resolve Conflicts…',
            run: () => send(COMMIT_METHODS.resolveConflicts, repoRoot !== undefined ? { repoRoot } : {}),
          },
        ];
      }
      return state.paradigm === 'staging' ? stagingActions(node) : undefined;
    },
    [model, send, stagingActions, state.paradigm],
  );

  const description = useCallback(
    (node: TreeNode): string | undefined => {
      if (node.kind === 'dir') return fileCountLabel(countFiles(node));
      const ref = model.files.get(node.path);
      if (!ref) return undefined;
      // A partially-included file says so first: it is the one row whose
      // checkbox does not tell the whole story.
      if (ref.change.partial !== undefined) return partialLabel(ref.change.partial);
      // POST-P14cb: in a list no folder row says where a file is, so its row
      // does, and where a renamed one came from.
      if (model.layout === 'list') return listDescription(ref.relPath, ref.change.origPath);
      // Its folder is the row above it: what a file's row adds is where a
      // renamed one came from, as IntelliJ's grouped tree shows (POST-QA).
      return originText(ref.relPath, ref.change.origPath);
    },
    [model],
  );

  // POST-P14cb: without changelist rows, each file shows its status as VS
  // Code's Source Control view does: a letter in its colour at the row's end, an
  // untracked file's name in italics, a deleted one's struck through (D44).
  const decoration = useCallback(
    (node: TreeNode): FileTreeDecoration | undefined => {
      if (model.groupBy !== 'none' || node.kind !== 'file') return undefined;
      const ref = model.files.get(node.path);
      if (!ref) return undefined;
      const look = statusLook(ref.change);
      return {
        letter: look.letter,
        title: look.title,
        color: statusColor(ref.change.kind, state.colors),
        italic: look.italic,
        strike: look.strike,
      };
    },
    [model, state.colors],
  );

  const icon = useCallback(
    (node: TreeNode) => {
      if (node.kind === 'dir') {
        // A repository's row wears its colour, whatever its files' status: a
        // filled square, as IntelliJ's repository node draws the log's root
        // colour and the log's Roots draw its chip; the same colour as its dot
        // in the Repositories panel. Under a list or at the top alike.
        const group = model.groups.get(node.path);
        if (group?.shows === 'repository') {
          return { swatch: laneColor(group.colorIdx ?? 0, dark, state.palette) };
        }
        // P11-T8: a folder of modified descendants wears the modified color.
        const color = dirStatusColor(model.dirKinds.get(node.path) ?? new Set(), state.colors);
        return color !== undefined ? { codicon: 'folder', color } : { codicon: 'folder' };
      }
      const ref = model.files.get(node.path);
      return ref ? iconFor(ref.change, state.colors) : { codicon: 'file' };
    },
    [dark, model, state.colors, state.palette],
  );

  // IntelliJ colors the file *names*, not only the icons (P11-T8).
  const nameColor = useCallback(
    (node: TreeNode): string | undefined => {
      if (node.kind === 'dir') {
        // A repository's name in plain text, as IntelliJ's: its square says which it is.
        if (model.groups.get(node.path)?.shows === 'repository') return undefined;
        return dirStatusColor(model.dirKinds.get(node.path) ?? new Set(), state.colors);
      }
      const ref = model.files.get(node.path);
      return ref ? statusColor(ref.change.kind, state.colors) : undefined;
    },
    [model, state.colors],
  );

  // A repository's branch after its file count, IntelliJ's label, in both groupings.
  const badge = useCallback((node: TreeNode): FileTreeBadge | undefined => {
    const group = model.groups.get(node.path);
    return group?.shows === 'repository' ? headLabel(group.head) : undefined;
  }, [model]);

  /**
   * P14-T2: native context menus for the change tree. The changelists tree view
   * used to be the only place a changelist could be renamed, deleted or made
   * active; once it goes, this is that home. Labels are static, so master §9's
   * native-menu rule applies (the kit `Menu` is for interpolated labels).
   *
   * POST-P14v: file rows carry the whole selection, so `Add to VCS` and the
   * other file verbs act on a Ctrl-clicked set rather than on one row.
   */
  const rowContext = useCallback(
    (node: TreeNode): Record<string, unknown> | undefined =>
      groupRowContext(model, node.path) ??
      (node.kind === 'dir' ? folderRowContext(model, node, selection) : fileRowContext(model, node.path, selection)),
    [model, selection],
  );

  const selectedRelPaths = useCallback((): { repoRoot: string; paths: string[] } | undefined => {
    const refs = [...selection]
      .map((p) => model.files.get(p))
      .filter((r): r is NonNullable<typeof r> => r !== undefined);
    const first = refs[0];
    if (!first) return undefined;
    return {
      repoRoot: first.repoRoot,
      paths: refs.filter((r) => r.repoRoot === first.repoRoot).map((r) => r.relPath),
    };
  }, [model, selection]);

  // ---- preview diff (P11-T3) ------------------------------------------------

  /** The preview pane follows a single selected file; it has no meaning for many. */
  const selectedFile = useMemo(() => {
    if (selection.size !== 1) return undefined;
    const [only] = [...selection];
    return only === undefined ? undefined : model.files.get(only);
  }, [model, selection]);

  const diffRepo = selectedFile?.repoRoot;
  const diffPath = selectedFile?.relPath;
  // With staging a file can be two rows; the preview shows the one selected.
  const diffSide = selectedFile !== undefined ? fileSide(selectedFile) : undefined;

  useEffect(() => {
    if (!preview || diffRepo === undefined || diffPath === undefined) {
      setDiff(undefined);
      return;
    }
    let cancelled = false;
    rpc
      .request<CommitFileDiffDto | undefined>(COMMIT_METHODS.fileDiff, {
        repoRoot: diffRepo,
        path: diffPath,
        ...(diffSide !== undefined ? { side: diffSide } : {}),
      })
      .then(
        (next) => {
          if (!cancelled) setDiff(next ?? undefined);
        },
        () => {
          if (!cancelled) setDiff(undefined);
        },
      );
    return () => {
      cancelled = true;
    };
    // `state` is a dependency on purpose: a refresh, a rollback or an inclusion
    // toggle all land as a state push, and each can change what this file's
    // changes are. Re-reading is cheaper than showing a diff that has moved on.
  }, [diffPath, diffRepo, preview, rpc, state]);

  const includedSet = useMemo(() => {
    // An unticked file contributes nothing, so none of its changes are in —
    // showing them all ticked would contradict the tree row right above.
    if (!diff || !diff.checked) return new Set<number>();
    return new Set(diff.included ?? diff.changes.map((_, i) => i));
  }, [diff]);

  const onToggleInclude = useCallback(
    (index: number, next: boolean) => {
      if (!diff || diffRepo === undefined || diffPath === undefined) return;
      const included = new Set(includedSet);
      if (next) included.add(index);
      else included.delete(index);
      send(COMMIT_METHODS.setIncluded, {
        repoRoot: diffRepo,
        path: diffPath,
        included: [...included].sort((a, b) => a - b),
        signature: diff.signature,
      } satisfies CommitSetIncludedParamsDto);
    },
    [diff, diffPath, diffRepo, includedSet, send],
  );

  // ---- message editor (P11-T4) ----------------------------------------------

  const onEditorInput = useCallback((value: string) => setMessage(value), []);
  const activeRepoRef = useRef(activeRepo);
  activeRepoRef.current = activeRepo;
  const commitRepoRef = useRef(commitRepo);
  commitRepoRef.current = commitRepo;
  const onEditorPersist = useCallback(
    (value: string) => {
      const repoRoot = activeRepoRef.current;
      if (repoRoot === undefined) return;
      send(COMMIT_METHODS.setMessage, { repoRoot, message: value });
    },
    [send],
  );

  /** Opens the history clock or Amend ▾ dropdown under its button. */
  const openMessageMenu = useCallback(
    async (anchor: HTMLElement, kind: 'history' | 'amend') => {
      // The history is the message box's; the commits to reuse, those of the
      // repository Amend acts on (POST-P14ce), which the list shows.
      const repoRoot = kind === 'history' ? activeRepoRef.current : commitRepoRef.current;
      if (repoRoot === undefined) return;
      const rect = anchor.getBoundingClientRect();
      const at = { x: rect.left, y: rect.bottom + 2 };
      try {
        if (kind === 'history') {
          const res = await rpc.request<CommitHistoryDto>(COMMIT_METHODS.messageHistory, {
            repoRoot,
          });
          const entries = res?.entries ?? [];
          setMenu({
            label: 'Commit message history',
            ...at,
            items:
              entries.length === 0
                ? [{ kind: 'item', id: 'empty', label: 'No commit message history yet.', disabled: true }]
                : entries.map((e, i) => ({
                    kind: 'item' as const,
                    id: String(i),
                    label: firstLine(e.message),
                    accelerator: relativeTime(e.ts, Date.now(), state.dateFormat),
                  })),
            messages: entries.map((e) => e.message),
          });
        } else {
          const res = await rpc.request<CommitRecentCommitsDto>(COMMIT_METHODS.recentCommits, {
            repoRoot,
          });
          const commits = res?.commits ?? [];
          setMenu({
            label: 'Reuse commit message',
            ...at,
            items:
              commits.length === 0
                ? [{ kind: 'item', id: 'empty', label: 'No commits yet.', disabled: true }]
                : commits.map((c, i) => ({
                    kind: 'item' as const,
                    id: String(i),
                    label: c.subject,
                    accelerator: c.shortSha,
                  })),
            messages: commits.map((c) => c.message),
          });
        }
      } catch (err) {
        setRpcError(err instanceof Error ? err.message : String(err));
      }
    },
    [rpc],
  );

  const onMenuSelect = useCallback(
    (id: string) => {
      const text = menu?.messages[Number(id)];
      setMenu(null);
      // Deferred one tick: the closing menu restores focus to the button that
      // opened it, and the editor must win that race after a pick.
      if (text !== undefined) window.setTimeout(() => editorRef.current?.insert(text), 0);
    },
    [menu],
  );

  const commit = (andPush: boolean): void => {
    if (activeRepo === undefined) return;
    // A half-typed message may still be inside the debounce window; the flush
    // posts it first, and the host processes messages in arrival order.
    editorRef.current?.flush();
    send(COMMIT_METHODS.commit, {
      repoRoot: activeRepo,
      andPush,
      // POST-P14ce: narrowed, what the list shows is what is committed.
      ...(state.filter !== undefined ? { roots: state.filter.shown.map((repo) => repo.root) } : {}),
    } satisfies CommitRunParamsDto);
  };

  /**
   * POST-P14cj: Generate Commit Message. A language model writes the message
   * for what Commit would commit: what the list shows, when it is narrowed.
   * The host answers at once; the message comes as a programmatic write.
   */
  const generateMessage = (): void => {
    if (activeRepo === undefined) return;
    send(COMMIT_METHODS.generateMessage, {
      repoRoot: activeRepo,
      ...(state.filter !== undefined ? { roots: state.filter.shown.map((repo) => repo.root) } : {}),
    } satisfies CommitGenerateParamsDto);
  };
  // In a ref, so the button below is the same element from render to render
  // and the memoized message box is not drawn again for it.
  const generateRef = useRef(generateMessage);
  generateRef.current = generateMessage;
  const generation = state.messageGeneration;
  const cannotGenerate = activeRepo === undefined || state.busy;
  /**
   * The button in the message box's corner, where VS Code's Source Control
   * input and IntelliJ's commit message keep theirs. While a model writes, the
   * same place stops it. Nothing while the setting, or VS Code's AI features,
   * are off.
   */
  const messageCorner = useMemo(
    () =>
      generation === 'running' ? (
        <ToolbarButton
          icon="stop-circle"
          label="Stop Generating the Commit Message"
          toggled
          onClick={() => send(COMMIT_METHODS.stopGenerating)}
        />
      ) : generation === 'idle' ? (
        <ToolbarButton
          icon="sparkle"
          label="Generate Commit Message"
          disabled={cannotGenerate}
          onClick={() => generateRef.current()}
        />
      ) : undefined,
    [cannotGenerate, generation, send],
  );

  const canCommit =
    !state.busy &&
    activeRepo !== undefined &&
    (state.amend || message.trim().length > 0) &&
    // With staging, what is staged is what commits (POST-QA F5): nothing
    // staged, nothing to commit — the counter says the same.
    (state.amend || state.checkedCount > 0);

  // POST-P14bs: the commit key (Ctrl+Enter, ⌘Enter), pressed in the message
  // box. What the Commit button does, when it would: the message as typed goes
  // first, then the commit. In a ref, so the host's ask finds this render's.
  const answerCommitKey = useRef<() => void>(() => undefined);
  answerCommitKey.current = () => {
    if (tabRef.current !== 'commit') return;
    const composing = editorRef.current?.composing() ?? false;
    if (!answersCommitAsk({ messageFocused: messageFocused.current, composing, canCommit })) return;
    commit(false);
  };
  useEffect(() => rpc.onEvent(COMMIT_METHODS.evtCommitKey, () => answerCommitKey.current()), [rpc]);

  // The tree spans every repository, so in a multi-root workspace a bare
  // `Commit` leaves the scope invisible — which is how a commit lands in the
  // wrong repo unnoticed. Single-root workspaces keep the plain label.
  // Defensive despite the DTO requiring it: this crosses `postMessage`, where
  // the compiler enforces nothing, and a missing field must not blank the
  // whole panel — which is exactly what it did the first time.
  const targets = state.targets ?? [];
  // POST-P14ce: narrowed to one repository, the workspace still has several,
  // and the button still names where the commit goes.
  const commitLabel =
    !multiRepo || targets.length === 0
      ? 'Commit'
      : targets.length === 1
        ? `Commit to ${targets[0]}`
        : `Commit to ${targets.length} repositories`;
  const targetTitle = targets.length > 0 ? `Commits: ${targets.join(', ')}` : undefined;

  // POST-P14ca: the box's sizes, read once it is drawn. It is drawn again on
  // every return from the Shelf tab, at the same sizes, so once is enough.
  useLayoutEffect(() => {
    if (tab !== 'commit' || messageMetrics !== undefined) return;
    const m = editorRef.current?.metrics();
    if (m !== undefined) setMessageMetrics(m);
  }, [messageMetrics, tab]);

  // POST-P14ca: the list and the box share what they hold between them now:
  // the list takes whatever the box leaves, so their sum is the room there is.
  const messageRoom = bodySize.height + slotSize.height;
  const measured = messageMetrics !== undefined && bodySize.height + slotSize.height > 0;
  const messageFit = measured
    ? { min: messageMetrics.min, room: messageRoom, listFloor: LIST_FLOOR_PX }
    : undefined;
  const preferredMessage = messageHeight ?? messageMetrics?.natural;
  const appliedMessage =
    messageFit !== undefined && preferredMessage !== undefined
      ? fitMessageHeight({ ...messageFit, preferred: preferredMessage })
      : messageHeight;
  const resizeMessage = (next: number): void => {
    if (messageFit !== undefined) setMessageHeight(clampMessageHeight(next, messageFit));
  };

  // POST-P14ca: the toolbar shares the tabs' row, so what does not fit there
  // folds into `⋯`. The lower the priority, the longer a button stays out: at
  // the side bar's usual width, Refresh, Rollback and View Options do.
  // POST-P14cb: what the eye's menu shows: the settings as set, not as drawn
  // (one repository draws Repository › Changelist as Changelist › Repository).
  const viewOptions = {
    groupBy: commitGroupByOf(state.groupBy),
    directory: state.groupByDirectory === true,
    // POST-P14ce: the workspace's repositories, the ones the list leaves out too.
    multiRepo,
  };

  const commitTools: OverflowAction[] = [
    {
      id: 'refresh',
      label: 'Refresh',
      icon: 'refresh',
      priority: 0,
      disabled: state.busy,
      busy: refreshing,
      run: () => trackRefresh(() => request(COMMIT_METHODS.refresh)),
    },
    {
      id: 'rollback',
      label: 'Rollback',
      icon: 'discard',
      priority: 1,
      disabled: state.busy || selection.size === 0,
      run: () => {
        const target = selectedRelPaths();
        if (target) send(COMMIT_METHODS.rollback, target);
      },
    },
    {
      id: 'showDiff',
      label: 'Show Diff',
      icon: 'diff',
      priority: 3,
      disabled: selection.size === 0,
      run: () => {
        const first = selectedFiles(model.nodes, selection)[0];
        if (first !== undefined) openDiffAt(first);
      },
    },
    {
      id: 'shelve',
      label: 'Shelve Changes',
      icon: 'archive',
      priority: 5,
      // POST-P14ce: a repository the list shows.
      disabled: state.busy || commitRepo === undefined,
      run: () => send(COMMIT_METHODS.shelve, { repoRoot: commitRepo }),
    },
    {
      id: 'preview',
      label: 'Preview Diff',
      icon: 'split-horizontal',
      priority: 4,
      toggled: preview,
      run: () => setPreview((on) => !on),
    },
    // IntelliJ's eye before Expand All and Collapse All. POST-P14cb: with one
    // repository too, where Changelist and Directory are choices as well.
    {
      id: 'viewOptions',
      label: 'View Options',
      icon: 'eye',
      priority: 2,
      badge: viewOptionsChanged(viewOptions),
      run: (at: { readonly x: number; readonly y: number }) => setViewMenu(at),
    },
    // This grouping's rows only: the other keeps its own for when it comes back.
    {
      id: 'expandAll',
      label: 'Expand all',
      icon: 'expand-all',
      priority: 6,
      run: expandAllRows,
    },
    {
      id: 'collapseAll',
      label: 'Collapse all',
      icon: 'collapse-all',
      priority: 7,
      run: collapseAllRows,
    },
  ];

  // POST-P14cf: the tick-all box's state, and the menu of the list's blank space.
  const tickAll = tickAllState(model);
  const listMenu = useMemo(
    () =>
      JSON.stringify(
        listContext(model, { narrowed: state.filter !== undefined, roots: state.repos.map((repo) => repo.root) }),
      ),
    [model, state.filter, state.repos],
  );

  // POST-P14ce: narrowed to repositories with nothing to commit, the list says
  // so — whatever the grouping, rather than an empty changelist row — beside
  // the way to the changes it leaves out.
  const nothingToShow = ready && (model.nodes.length === 0 || (state.filter !== undefined && model.files.size === 0));
  const errorText = state.error ?? rpcError;
  const showAllRepositories = (): void => send(COMMIT_METHODS.showAllRepositories, {});
  const emptyText = state.filter !== undefined ? filterEmptyText(state.filter) : { text: 'No changes.' };

  const treePane = nothingToShow ? (
    <div className="gt-commit-empty" data-testid="commit-empty">
      {emptyText.text}
      {emptyText.elsewhere !== undefined ? (
        <div className="gt-commit-empty-more">
          <button
            type="button"
            className="gt-link-button"
            data-testid="commit-empty-show-all"
            onClick={showAllRepositories}
          >
            Show all repositories
          </button>
          {` · ${emptyText.elsewhere}`}
        </div>
      ) : null}
    </div>
  ) : (
    <FileTree
      ref={treeHandle}
      nodes={model.nodes}
      height={Math.max(0, treeSize.height)}
      ariaLabel="Changes"
      expanded={expanded}
      onToggleExpand={onToggleExpand}
      checked={model.checked}
      checkboxless={model.checkboxless}
      onToggleCheck={onToggleCheck}
      selection={selection}
      onSelectionChange={(paths) => setSelection(new Set(paths))}
      onActivate={(node) => {
        if (!model.files.has(node.path)) return;
        openDiffAt(node.path);
        // Enter opens the keyboard's row, which the arrows moved without
        // selecting: the selection goes with the diff, as it does on a walk.
        setSelection((prev) =>
          prev.size === 1 && prev.has(node.path) ? prev : selectionFollowing(model.nodes, prev, node.path),
        );
      }}
      description={description}
      badge={badge}
      icon={icon}
      nameColor={nameColor}
      decoration={decoration}
      rowContext={rowContext}
      actions={rowActions}
      // POST-P14cf: IntelliJ's keys: Ctrl+A selects every row, Space ticks a selection.
      selectionKeys
      {...(reveal !== undefined ? { reveal } : {})}
      {...(restore !== undefined ? { restore } : {})}
      {...(onScreenPath !== undefined ? { current: onScreenPath } : {})}
    />
  );

  const previewPane = ((): JSX.Element => {
    if (!selectedFile) {
      return (
        <div className="gt-commit-empty" data-testid="preview-hint">
          Select one file to review and include its changes.
        </div>
      );
    }
    if (!diff) {
      return <div className="gt-commit-empty">Loading changes…</div>;
    }
    if (diff.wholeFileOnly) {
      // Binary, or a file with only one side. Offering checkboxes here would
      // promise a granularity the commit cannot deliver.
      return (
        <div className="gt-commit-empty" data-testid="preview-whole-file">
          {selectedFile.relPath} commits as a whole file.
        </div>
      );
    }
    return (
      <InlineDiff
        originalText={diff.originalText}
        modifiedText={diff.modifiedText}
        changes={diff.changes}
        leftLabel={diffSide === 'unstaged' ? 'Staged' : 'HEAD'}
        rightLabel={diffSide === 'staged' ? `${selectedFile.relPath} (staged)` : selectedFile.relPath}
        height={Math.max(0, diffSize.height)}
        // Two sides in a sidebar cut both to a few characters (POST-QA): below
        // this width the preview is one column, as IntelliJ's unified viewer.
        layout={diffSize.width > 0 && diffSize.width < UNIFIED_BELOW_PX ? 'unified' : 'split'}
        // With staging there is nothing to tick: a change is in the commit by
        // being staged (the diff editor's Stage hunk lens), not by a checkbox.
        {...(state.paradigm === 'staging' ? {} : { included: includedSet, onToggleInclude })}
      />
    );
  })();

  return (
    // POST-P14cf: no menu on the window's chrome (tabs, toolbar, Amend row),
    // where VS Code's Cut, Copy and Paste have nothing to act on. The list's
    // blank space has its own menu; the text fields keep theirs.
    <div className="gt-commit" data-vscode-context={NO_MENU}>
      <Tabs
        ariaLabel="Commit tool window"
        active={tab}
        onChange={setTab}
        tabs={[
          { id: 'commit', label: 'Commit' },
          { id: 'shelf', label: 'Shelf' },
          ...(combined ? [] : [{ id: 'stash', label: 'Stash' }]),
        ]}
        actions={
          tab === 'commit' ? (
            <OverflowToolbar ariaLabel="Commit actions" actions={commitTools} className="gt-commit-tools" />
          ) : undefined
        }
      />

      {/* Window-level, not per-tab: a failed shelf action must be visible from
          the Shelf tab exactly like a failed commit is from the Commit tab. */}
      {errorText !== undefined ? (
        <div className="gt-commit-error" role="alert" data-testid="commit-error">
          <span className="gt-commit-error-text">{errorText}</span>
          <span className="gt-commit-error-actions">
            <button
              type="button"
              className="gt-link-button"
              data-testid="commit-error-output"
              onClick={() => send(COMMIT_METHODS.showOutput, {})}
            >
              Show Output
            </button>
            <button
              type="button"
              className="gt-commit-error-close codicon codicon-close"
              aria-label="Dismiss"
              title="Dismiss"
              data-testid="commit-error-dismiss"
              onClick={() => {
                setRpcError(undefined);
                send(COMMIT_METHODS.dismissError, {});
              }}
            />
          </span>
        </div>
      ) : null}

      <TabPanel id="commit" active={tab} className="gt-commit-panel">
        {/* POST-P14ce: the list narrowed to the repositories picked in the
            Repositories panel, said where commits are made. */}
        {state.filter !== undefined ? (
          <RepoFilterBar
            filter={state.filter}
            staging={state.paradigm === 'staging'}
            colorOf={(colorIdx) => laneColor(colorIdx, dark, state.palette)}
            onShowAll={showAllRepositories}
            onReveal={(root) => send(COMMIT_METHODS.revealRepository, { root })}
            menuContext={listMenu}
          />
        ) : null}
        <div className="gt-commit-body" data-testid="commit-tree" ref={bodyRef}>
          {preview ? (
            <SplitPane
              direction="vertical"
              className="gt-commit-split"
              ariaLabel="Changes and diff preview"
              ratio={ratio}
              onRatioChange={setRatio}
              minFirst={80}
              minSecond={80}
              first={
                // POST-P14cf: the list's blank space has the list's menu; its rows, their own.
                <div className="gt-commit-pane" ref={treeRef} data-vscode-context={listMenu} {...treeFocusProps}>
                  {treePane}
                </div>
              }
              second={
                <div className="gt-commit-pane" ref={diffRef} data-testid="commit-preview">
                  {previewPane}
                </div>
              }
            />
          ) : (
            <div className="gt-commit-pane" ref={treeRef} data-vscode-context={listMenu} {...treeFocusProps}>
              {treePane}
            </div>
          )}
        </div>

        {/* POST-P14ca: the message box's height, dragged here. */}
        <MessageDivider
          height={appliedMessage ?? messageMetrics?.natural ?? 0}
          step={messageMetrics?.line ?? 18}
          onResize={resizeMessage}
          onReset={() => setMessageHeight(undefined)}
        />

        <div className="gt-commit-bottom">
          <div className="gt-commit-amend-row">
            <label
              className="gt-checkbox"
              // POST-P14ce: which repository's last commit, when the list is
              // narrowed and the message box is another's.
              title={
                commitRepo !== undefined && commitRepo !== activeRepo
                  ? `Amend the last commit of ${state.repos.find((r) => r.root === commitRepo)?.label ?? commitRepo}`
                  : 'Amend the last commit'
              }
            >
              <input
                type="checkbox"
                checked={state.amend}
                disabled={state.busy || commitRepo === undefined}
                onChange={() =>
                  send(COMMIT_METHODS.toggleAmend, {
                    repoRoot: commitRepo,
                    // The box on screen, which takes the last commit's message.
                    ...(activeRepo !== undefined ? { messageRepoRoot: activeRepo } : {}),
                  })
                }
              />
              <span className="gt-checkbox-body">
                <span>Amend</span>
              </span>
            </label>
            <ToolbarButton
              icon="chevron-down"
              label="Reuse a recent commit message"
              disabled={commitRepo === undefined}
              onClick={(e) => void openMessageMenu(e.currentTarget, 'amend')}
            />
            <ToolbarButton
              icon="history"
              label="Commit message history"
              disabled={activeRepo === undefined}
              onClick={(e) => void openMessageMenu(e.currentTarget, 'history')}
            />
            {/* POST-P14cl: the counter and the gear go together — on the row's
                right, or, in a sidebar too narrow for one line, on a second. */}
            <div className="gt-commit-amend-end">
              {tickAll !== undefined ? (
                // POST-P14cf: the counter is the tick-all box, drawn as the rows'
                // boxes are: none, some or all of them ticked. A click ticks every
                // change the list shows, or, all ticked, unticks them all.
                <button
                  type="button"
                  role="checkbox"
                  aria-checked={tickAll.state === 'partial' ? 'mixed' : tickAll.state === 'checked'}
                  className="gt-commit-counter gt-commit-tick-all"
                  data-testid="commit-tick-all"
                  title={`${tickAll.state === 'checked' ? 'Untick' : 'Tick'} all ${fileCountLabel(tickAll.total)}`}
                  disabled={state.busy || tickAll.total === 0}
                  onClick={() => setAllChecked(tickAll.state !== 'checked')}
                >
                  <TriCheckbox state={tickAll.state} disabled={state.busy || tickAll.total === 0} />
                  <span data-testid="commit-counter">
                    {state.checkedCount} of {fileCountLabel(state.modifiedCount)}
                  </span>
                </button>
              ) : (
                <span className="gt-commit-counter" data-testid="commit-counter">
                  {state.checkedCount} of {fileCountLabel(state.modifiedCount)}
                  {state.paradigm === 'staging' ? ' staged' : ''}
                </span>
              )}
              <ToolbarButton
                icon="gear"
                label="Commit options"
                disabled={commitRepo === undefined}
                toggled={optionsOpen}
                onClick={(e) => {
                  if (optionsOpen) {
                    setOptionsOpen(false);
                    return;
                  }
                  // Opened clear of the gear, which sits mid-window now.
                  setOptionsAt(popupPlacement(e.currentTarget.getBoundingClientRect(), window.innerHeight));
                  setOptionsOpen(true);
                }}
              />
            </div>
          </div>

          <div className="gt-commit-message-slot" ref={slotRef}>
            <MessageEditor
              ref={editorRef}
              initial={message}
              disabled={activeRepo === undefined}
              onInput={onEditorInput}
              onPersist={onEditorPersist}
              onFocusChange={reportMessageFocus}
              height={appliedMessage}
              // POST-P14cj: Generate Commit Message.
              corner={messageCorner}
            />
          </div>

          {/* POST-P14ca: one full-width button, as VS Code's Source Control
              view has, so a long label stays whole; its ▾ holds the rest. */}
          <div className="gt-commit-split-button" role="group" aria-label="Commit">
            <button
              type="button"
              className="gt-button gt-primary gt-commit-main"
              data-testid="commit-button"
              disabled={!canCommit}
              title={targetTitle}
              onClick={() => commit(false)}
            >
              <span className="codicon codicon-check" aria-hidden="true" />
              <span className="gt-commit-main-label">{commitLabel}</span>
            </button>
            <button
              type="button"
              className="gt-button gt-primary gt-commit-more"
              data-testid="commit-more-button"
              aria-label="More Commit Actions"
              title="More Commit Actions"
              aria-haspopup="menu"
              aria-expanded={commitMenuAt !== null}
              disabled={!canCommit}
              onClick={(e) => {
                const box = e.currentTarget.getBoundingClientRect();
                setCommitMenuAt((open) => (open === null ? { x: box.left, y: box.bottom + 2 } : null));
              }}
            >
              <span className="codicon codicon-chevron-down" aria-hidden="true" />
            </button>
          </div>
        </div>
      </TabPanel>

      <TabPanel id="shelf" active={tab} className="gt-commit-panel">
        <ShelfTab rpc={rpc} send={send} colors={state.colors} dateFormat={state.dateFormat} />
        {/* `Combine stashes and shelves in one tab`: the stashes render under
            the shelves rather than in a tab of their own. */}
        {combined ? (
          <StashTab rpc={rpc} send={send} colors={state.colors} dateFormat={state.dateFormat} embedded />
        ) : null}
      </TabPanel>

      {combined ? null : (
        <TabPanel id="stash" active={tab} className="gt-commit-panel">
          <StashTab rpc={rpc} send={send} colors={state.colors} dateFormat={state.dateFormat} />
        </TabPanel>
      )}

      {/* The line along the window's bottom edge, on VS Code's own divider
          between this view and the one under it: where to grab it. */}
      <div className="gt-commit-edge" aria-hidden="true" data-testid="commit-edge" />

      {optionsOpen && commitRepo !== undefined ? (
        <OptionsPopup
          rpc={rpc}
          // POST-P14ce: a repository the list shows: its author is the one committed.
          repoRoot={commitRepo}
          placement={optionsAt}
          onClose={() => setOptionsOpen(false)}
        />
      ) : null}

      {commitMenuAt !== null ? (
        <Menu
          items={[
            { kind: 'item', id: 'commit', label: commitLabel, icon: 'check', accelerator: COMMIT_KEY_LABEL },
            { kind: 'item', id: 'commitAndPush', label: 'Commit and Push…', icon: 'repo-push' },
          ]}
          at={commitMenuAt}
          ariaLabel="More Commit Actions"
          onSelect={(id) => {
            setCommitMenuAt(null);
            // The state may have moved on while the menu was open.
            if (!canCommit) return;
            if (id === 'commitAndPush') commit(true);
            else if (id === 'commit') commit(false);
          }}
          onClose={() => setCommitMenuAt(null)}
        />
      ) : null}

      {menu !== null ? (
        <Menu
          items={menu.items}
          at={{ x: menu.x, y: menu.y }}
          ariaLabel={menu.label}
          onSelect={onMenuSelect}
          onClose={() => setMenu(null)}
        />
      ) : null}

      {viewMenu !== null ? (
        <Menu
          items={viewOptionsItems(viewOptions)}
          at={viewMenu}
          ariaLabel="View Options"
          activeId="changelist"
          onSelect={(id) => {
            const change = applyViewOption(viewOptions, id);
            if (change !== undefined) {
              send(COMMIT_METHODS.setGroupBy, change satisfies CommitSetGroupByParamsDto);
            }
          }}
          onClose={() => setViewMenu(null)}
        />
      ) : null}
    </div>
  );
}
