/**
 * One Log tab of the Git tool window (P12-T1, over the P4 machinery): filter
 * bar → the §2A four-pane layout `[Branches | Commits] | [Changed Files /
 * Commit Details]`, every ratio and collapse persisted per tab. Rows stay in a
 * VirtualList with the canvas graph layer; infinite scroll pages over RPC; the
 * selection is mirrored host-side (`log/select`) so multi-commit actions read
 * one model. Every request names this tab (`logTab`) and every event for
 * another tab is ignored, so tabs never see each other's rows. A tab behind
 * another stays mounted, keeping its rows, selection and scroll for when it
 * is shown again; `App` owns the strip around it.
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from 'react';
import {
  LOG_METHODS,
  type CommitDetailsDto,
  type CommitFileDto,
  type LogBranchesDto,
  type LogChangedFilesDto,
  type LogDiffOnScreenDto,
  type LogRangeCountsDto,
  type LogFilterDto,
  type LogInitDto,
  type LogPageDto,
  type LogPresentationDto,
  type LogRootDto,
  type LogRowDto,
} from '../../../src/shared/protocol';
import type { RpcClient } from '../lib/rpc';
import { ToolbarButton } from '../lib/Toolbar';
import { useBusy } from '../lib/useBusy';
import { useElementSize } from '../lib/useElementSize';
import { VirtualList, type VirtualListHandle } from '../lib/VirtualList';
import {
  HASH_SAMPLES,
  SHORT_HASH_LENGTH,
  authorText,
  autoAuthorWidth,
  draggedWidth,
  fitColumns,
  readColumnWidths,
  sampleWidth,
  visibleColumns,
  type ColumnId,
  type ColumnWidths,
} from './columns';
import { SAMPLE_COMMIT_TIME, commitDate } from './dateFormat';
import { BranchesPane } from './BranchesPane';
import { ChangedFilesPane, changedFilesLabel } from './ChangedFilesPane';
import { CompareStrip } from './CompareStrip';
import { commitMenuContext } from './commitMenuContext';
import { CommitTooltip } from './CommitTooltip';
import { DetailsPanel } from './DetailsPanel';
import { FilterBar } from './FilterBar';
import { GraphCanvas, laneColor, type GraphViewport } from './GraphCanvas';
import {
  EMPTY_SELECTION,
  clickSelection,
  contextSelection,
  extendSelection,
  rowOrder,
  selectAll,
  shiftTarget,
  type LogSelection,
} from './logSelection';
import { comparedRefs, MAIN_LOG_TAB } from './logTabsModel';
import {
  groupRefs,
  labelTooltip,
  labelsBudget,
  layoutLabels,
  repoRefs,
  type RefLabel,
} from './refLabels';
import { RefLabels } from './RefLabelsView';
import { DEFAULT_LAYOUT, Shell, type ShellLayout } from './Shell';
import { useTextMeasure } from './useTextMeasure';

const ROW_HEIGHT = 24;
/** `.gt-virtual-row`'s padding, both sides: the columns are laid out inside it. */
const ROW_PADDING = 16;
/** How much message the columns always leave beside the graph. */
const MIN_MESSAGE_WIDTH = 80;
/**
 * IntelliJ's Commit Details pane shows at most this many of the selected
 * commits (`MAX_COMMITS_TO_LOAD`), then says how many it left out.
 */
const MAX_DETAILS = 50;
/** A Refresh whose rows never come (a host gone quiet) stops turning after this. */
const REFRESH_SPIN_MAX_MS = 30_000;

/** A new Log tab opens with the Branches pane folded to its strip, as IntelliJ's do. */
export const NEW_TAB_LAYOUT: ShellLayout = { ...DEFAULT_LAYOUT, collapsed: { branches: true } };

/** What one tab keeps in the webview's state across a reload. */
export interface LogTabUiState {
  /** The commit to land on again. */
  focusSha?: string;
  /** P12-T1: pane ratios + collapse flags, restored exactly. */
  layout?: ShellLayout;
  /** Columns whose border was dragged, and to what width; the rest fit their content. */
  columnWidths?: ColumnWidths;
  /**
   * The main tab's filter from before tabs, when the webview kept it. Sent once
   * with `init`; the host stores every tab's filter itself from then on.
   */
  filter?: LogFilterDto;
}

export interface LogTabProps {
  rpc: RpcClient;
  tabId: string;
  /** Whether this tab is the one on show. */
  visible: boolean;
  dark: boolean;
  presentation: LogPresentationDto;
  onPresentationChange: (patch: Partial<LogPresentationDto>) => void;
  /** An init or reset carried the settings; the strip's other tabs draw with them too. */
  onPresentationSeen: (presentation: LogPresentationDto) => void;
  /** Window-wide pane preferences: the same in every tab. */
  filesRollup: boolean;
  onFilesRollupChange: (next: boolean) => void;
  previewOnClick: boolean;
  onPreviewOnClickChange: (next: boolean) => void;
  highlightMine: boolean;
  onHighlightMineChange: (next: boolean) => void;
  saved: LogTabUiState;
  onSave: (patch: Partial<LogTabUiState>) => void;
}

/** Whether an event is for `tabId` (no `logTab` means the main tab). */
function isFor(params: unknown, tabId: string): boolean {
  const tab = (params as { logTab?: unknown } | undefined)?.logTab;
  return (typeof tab === 'string' ? tab : MAIN_LOG_TAB) === tabId;
}

export function LogTab({
  rpc,
  tabId,
  visible,
  dark,
  presentation,
  onPresentationChange: changePresentation,
  onPresentationSeen,
  filesRollup,
  onFilesRollupChange,
  previewOnClick,
  onPreviewOnClickChange,
  highlightMine,
  onHighlightMineChange,
  saved,
  onSave,
}: LogTabProps) {
  const listRef = useRef<VirtualListHandle>(null);

  /** A request about this tab: every one names it, so the host acts on the right session. */
  const send = useCallback(
    <T,>(method: string, params: Record<string, unknown> = {}): Promise<T> =>
      rpc.request<T>(method, { ...params, logTab: tabId }),
    [rpc, tabId],
  );

  const [init, setInit] = useState<LogInitDto | undefined>();
  const [rows, setRows] = useState<LogRowDto[]>([]);
  const [eof, setEof] = useState(false);
  const [loading, setLoading] = useState(false);
  const [viewport, setViewport] = useState<GraphViewport>({ scrollTop: 0, first: 0, last: 0 });
  // The selection, IntelliJ's way: any set of commits, in graph order, with
  // the anchor a Shift range starts from. See `logSelection.ts`.
  const [selection, setSelection] = useState<LogSelection>(EMPTY_SELECTION);
  const selected = selection.shas;
  const selectOnly = useCallback((sha: string) => setSelection({ shas: [sha], anchor: sha }), []);
  // Commit Details for up to MAX_DETAILS selected commits, stacked.
  const [detailsList, setDetailsList] = useState<CommitDetailsDto[]>([]);
  const [detailsLoading, setDetailsLoading] = useState(false);
  /** sha → details, so re-selecting a commit does not re-run git. Cleared on reset. */
  const detailsCache = useRef(new Map<string, CommitDetailsDto>());
  /**
   * Bumped when history moved under a kept selection: its details are read
   * again (a push puts `origin/main` on them), without blanking the pane.
   */
  const [detailsEpoch, setDetailsEpoch] = useState(0);
  /** A preserving reset is waiting for page 0 to prune the selection against. */
  const pruneOnPageZeroRef = useRef(false);
  // Refresh turns from the click until the re-read page 0 is on screen.
  const [refreshing, trackRefresh] = useBusy();
  /** Ends the Refresh in flight; called when page 0 arrives. */
  const refreshDoneRef = useRef<(() => void) | undefined>(undefined);
  // P10-T2: gittree.log.focusFilter lands here (keyboard parity).
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  // P12-T1: this tab's layout, persisted with its focus. A tab opened by `+` or
  // a command starts with the Branches pane folded, as IntelliJ's new tabs do.
  const [layout, setLayout] = useState<ShellLayout>(
    () => saved.layout ?? (tabId === MAIN_LOG_TAB ? DEFAULT_LAYOUT : NEW_TAB_LAYOUT),
  );
  // P12-T3: the Changed Files pane's own data (single commit or aggregate).
  const [changed, setChanged] = useState<LogChangedFilesDto | undefined>(undefined);
  const [changedLoading, setChangedLoading] = useState(false);
  const [selectedFile, setSelectedFile] = useState<CommitFileDto | undefined>(undefined);
  // Two branches side by side: how many commits only one of them has.
  const [rangeCounts, setRangeCounts] = useState<LogRangeCountsDto | undefined>(undefined);
  // The diff opened from the pane has moved on to another of its files.
  const [diffFile, setDiffFile] = useState<{ sha: string; path: string } | undefined>(undefined);
  // The file that diff is showing, while it is on screen.
  const [diffOnScreen, setDiffOnScreen] = useState<{ sha: string; path: string } | undefined>(undefined);
  // P12-T5: refs data is shared by the Branches pane AND the filter row.
  const [branchesData, setBranchesData] = useState<LogBranchesDto | null>(null);
  // POST-P14x: the row hover card. `text` is the full commit message, fetched
  // lazily — see LOG_METHODS.commitMessage for why it is not on the row DTO.
  // `kind: 'refs'` is the same card over a ref label, naming its refs.
  const [hover, setHover] = useState<
    | {
        sha: string;
        text: string;
        anchor: { left: number; top: number; bottom: number };
        kind?: 'refs';
      }
    | undefined
  >(undefined);
  const hoverTimer = useRef<number | undefined>(undefined);
  /**
   * sha → message, kept for the life of the view. Re-hovering a row the user
   * has already read must not re-run git, and the same rows are hovered over
   * and over while the pointer travels down the list.
   */
  const messages = useRef(new Map<string, string>());
  /** The sha the pointer is over right now — a late reply for any other is dropped. */
  const hoverSha = useRef<string | undefined>(undefined);

  // Read again on every reset, since that is what history moving looks like here.
  useEffect(() => {
    if (init === undefined || comparedRefs(init.filter) === undefined) {
      setRangeCounts(undefined);
      return;
    }
    let current = true;
    send<LogRangeCountsDto | undefined>(LOG_METHODS.rangeCounts).then(
      (counts) => {
        if (current) setRangeCounts(counts);
      },
      () => {
        if (current) setRangeCounts(undefined);
      },
    );
    return () => {
      current = false;
    };
  }, [init, send]);

  useEffect(
    () =>
      rpc.onEvent(LOG_METHODS.evtDiffFile, (params) => {
        if (isFor(params, tabId)) setDiffFile(params as { sha: string; path: string });
      }),
    [rpc, tabId],
  );

  useEffect(
    () =>
      rpc.onEvent(LOG_METHODS.evtDiffOnScreen, (params) => {
        if (isFor(params, tabId)) setDiffOnScreen((params as LogDiffOnScreenDto).file);
      }),
    [rpc, tabId],
  );

  useEffect(() => {
    const reload = (): void => {
      send<LogBranchesDto>(LOG_METHODS.branches).then(
        (next) => setBranchesData(next ?? null),
        () => setBranchesData(null),
      );
    };
    reload();
    return rpc.onEvent(LOG_METHODS.evtBranches, (params) => {
      if (isFor(params, tabId)) reload();
    });
  }, [rpc, send, tabId]);

  // Only reached before the host's first `log/init` answers; it has to agree
  // with DEFAULT_FILTER or the sort dropdown reads wrong for that one frame.
  const filter = init?.filter ?? { sort: 'date' as const, refs: 'HEAD' as const };
  const compared = comparedRefs(filter);
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  // The loaded commits as shas and their rows, for the selection rules.
  const rowShas = useMemo(() => rows.map((r) => r.sha), [rows]);
  const order = useMemo(() => rowOrder(rowShas), [rowShas]);
  const selectedSet = useMemo(() => new Set(selected), [selected]);
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  const rowShasRef = useRef(rowShas);
  rowShasRef.current = rowShas;
  const orderRef = useRef(order);
  orderRef.current = order;
  // The boot effect runs once per rpc, so what it reads at event time has to
  // come through refs — a closure would hold the first render's empty values.
  const viewportRef = useRef(viewport);
  viewportRef.current = viewport;
  const pageRef = useRef({ next: 0, loading: false, eof: false });
  // The boot effect runs once, but these may change under it.
  const savedRef = useRef(saved);
  savedRef.current = saved;
  const presentationSeenRef = useRef(onPresentationSeen);
  presentationSeenRef.current = onPresentationSeen;

  // `onSave` is a fresh closure every render; only the layout drives this.
  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;
  useEffect(() => {
    onSaveRef.current({ layout });
  }, [layout]);

  // P12-T3: the pane follows the selection — one commit's files, or the
  // aggregate change set of a multi-select.
  useEffect(() => {
    if (selected.length === 0) {
      setChanged(undefined);
      return;
    }
    let cancelled = false;
    setChangedLoading(true);
    send<LogChangedFilesDto>(LOG_METHODS.changedFiles, { shas: selected }).then(
      (next) => {
        if (cancelled) return;
        setChanged(next ?? { files: [] });
        setChangedLoading(false);
      },
      () => {
        if (cancelled) return;
        setChanged({ files: [] });
        setChangedLoading(false);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [send, selected]);

  // P12-T1: the selection is one host-side model — every pane and every
  // command reads the same list, pushed here on each change.
  useEffect(() => {
    void send(LOG_METHODS.select, { shas: selected }).catch(() => undefined);
  }, [send, selected]);

  // Commit Details follows the selection: each selected commit's details, in
  // graph order, the first MAX_DETAILS of them — IntelliJ's stacked pane.
  useEffect(() => {
    const wanted = selected.slice(0, MAX_DETAILS);
    const cache = detailsCache.current;
    const known = (): CommitDetailsDto[] =>
      wanted.flatMap((sha) => {
        const d = cache.get(sha);
        return d !== undefined ? [d] : [];
      });
    const missing = wanted.filter((sha) => !cache.has(sha));
    if (missing.length === 0) {
      setDetailsList(known());
      setDetailsLoading(false);
      return undefined;
    }
    let cancelled = false;
    setDetailsLoading(true);
    void Promise.all(
      missing.map((sha) =>
        send<CommitDetailsDto | undefined>(LOG_METHODS.details, { sha }).then(
          (d) => {
            if (d) cache.set(sha, d);
          },
          () => undefined,
        ),
      ),
    ).then(() => {
      if (cancelled) return;
      setDetailsList(known());
      setDetailsLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [send, selected, detailsEpoch]);

  /** IntelliJ's own dwell before a commit tooltip appears. */
  const HOVER_DELAY_MS = 450;

  const cancelHover = useCallback(() => {
    if (hoverTimer.current !== undefined) window.clearTimeout(hoverTimer.current);
    hoverTimer.current = undefined;
    hoverSha.current = undefined;
    setHover(undefined);
  }, []);

  const beginHover = useCallback(
    (sha: string, el: HTMLElement) => {
      if (hoverTimer.current !== undefined) window.clearTimeout(hoverTimer.current);
      hoverSha.current = sha;
      // The rectangle is read now, not in the timer: by then the row may have
      // scrolled, and a card anchored to where the row *is* would jump away
      // from the message it describes.
      const rect = el.getBoundingClientRect();
      const anchor = { left: rect.left, top: rect.top, bottom: rect.bottom };
      const show = (text: string): void => {
        if (hoverSha.current !== sha || text.length === 0) return;
        setHover({ sha, text, anchor });
      };
      hoverTimer.current = window.setTimeout(() => {
        const cached = messages.current.get(sha);
        if (cached !== undefined) {
          show(cached);
          return;
        }
        send<{ message?: string }>(LOG_METHODS.commitMessage, { sha })
          .then((res) => {
            const text = res?.message ?? '';
            messages.current.set(sha, text);
            show(text);
          })
          .catch(() => undefined);
      }, HOVER_DELAY_MS);
    },
    [send],
  );

  /**
   * Over a ref label the card names its refs instead of showing the message,
   * as IntelliJ's tooltip does over a commit's labels: a label folds several
   * refs into one icon, and hovering is the way to read them. The key is not
   * the bare sha, so a message fetch still in flight for this row cannot land
   * over the names.
   */
  const beginRefsHover = useCallback((sha: string, text: string, label: HTMLElement) => {
    if (hoverTimer.current !== undefined) window.clearTimeout(hoverTimer.current);
    const key = `refs:${sha}`;
    hoverSha.current = key;
    setHover(undefined);
    if (text.length === 0) return;
    const rect = label.getBoundingClientRect();
    const anchor = { left: rect.left, top: rect.top, bottom: rect.bottom };
    hoverTimer.current = window.setTimeout(() => {
      if (hoverSha.current === key) setHover({ sha, text, anchor, kind: 'refs' });
    }, HOVER_DELAY_MS);
  }, []);

  /**
   * Off the label but still on its row: back to the row's own card. The row's
   * `mouseenter` does not fire again for a move inside it, so it is restarted
   * here; leaving the row or the pane at the same time overrides this, because
   * those handlers run after this one.
   */
  const endRefsHover = useCallback(
    (sha: string, label: HTMLElement) => {
      cancelHover();
      const row = label.closest<HTMLElement>('.gt-virtual-row');
      if (row) beginHover(sha, row);
    },
    [beginHover, cancelHover],
  );

  // ---- container sizing ----
  // useElementSize (callback ref) survives the Log tab unmounting/remounting
  // around the Console tab — an object-ref ResizeObserver would keep watching
  // the detached node (the P11-T4 lesson).
  const [containerRef, measured] = useElementSize<HTMLDivElement>();
  const size = { width: measured.width || 800, height: measured.height || 400 };
  /** For Shift+PageUp/PageDown, which run from a callback. */
  const listHeightRef = useRef(400);
  listHeightRef.current = Math.max(size.height, 100);
  const rowsHostRef = useRef<HTMLDivElement | null>(null);
  const rowsRefCallback = useCallback(
    (el: HTMLDivElement | null) => {
      rowsHostRef.current = el;
      containerRef(el);
    },
    [containerRef],
  );
  // The rows are as wide as the list's client area: the pane less its
  // scrollbar. The columns are laid out in that width.
  const [listWidth, setListWidth] = useState(0);
  const noRows = rows.length === 0;
  useLayoutEffect(() => {
    const list = rowsHostRef.current?.querySelector<HTMLElement>('.gt-virtual-list');
    if (list) setListWidth(list.clientWidth);
  }, [size.width, size.height, noRows]);

  // ---- columns: IntelliJ's Subject, then Author, Date and Hash ----
  const measure = useTextMeasure(dark);
  const [columnWidths, setColumnWidths] = useState<ColumnWidths>(() =>
    readColumnWidths(saved.columnWidths),
  );
  const columnWidthsRef = useRef(columnWidths);
  columnWidthsRef.current = columnWidths;
  // Sized by the first thousand rows, as IntelliJ sizes it, and only again
  // when those change: a page further down does not move the column.
  const sizedBy = rows.length > 1000 ? 1000 : rows.length;
  const firstSha = rows[0]?.sha;
  const authorAuto = useMemo(
    () =>
      autoAuthorWidth(
        rowsRef.current.slice(0, sizedBy).map((r) => authorText(r.authorName, r.committedByOther)),
        measure.text,
      ),
    [measure, sizedBy, firstSha],
  );
  const autoWidths = useMemo(
    () => ({
      author: authorAuto,
      date: sampleWidth(commitDate(SAMPLE_COMMIT_TIME), measure.bold),
      hash: sampleWidth(HASH_SAMPLES, measure.bold),
    }),
    [authorAuto, measure],
  );
  const repo = useMemo(() => repoRefs(branchesData), [branchesData]);

  // ---- boot + host events ----
  /**
   * The commit to land on once page 0 arrives. `select: true` restores a
   * focused commit (a reload, or an auto-refresh the user had a selection
   * for); `select: false` only puts the row back where it was, which is what
   * an auto-refresh under no selection needs — silently selecting a commit
   * the user never picked would repaint both right-hand panes.
   */
  const restoreRef = useRef<{ sha: string; select: boolean } | undefined>(undefined);
  useEffect(() => {
    const offRows = rpc.onEvent(LOG_METHODS.evtRows, (params) => {
      if (!isFor(params, tabId)) return;
      const page = params as LogPageDto;
      setRows((prev) => {
        // Pages arrive in order; page.page * PAGE alignment is guaranteed by
        // the host (it replays from its row store on rehydrate).
        const next = page.page === 0 ? [...page.rows] : [...prev, ...page.rows];
        return next;
      });
      if (page.page === 0 && pruneOnPageZeroRef.current) {
        // The graph a preserving reset kept on screen has been replaced:
        // commits that are gone (an amend, a rebase) leave the selection.
        pruneOnPageZeroRef.current = false;
        const present = new Set(page.rows.map((r) => r.sha));
        setSelection((prev) => {
          if (prev.shas.every((sha) => present.has(sha))) return prev;
          const shas = prev.shas.filter((sha) => present.has(sha));
          if (shas.length === 0) return EMPTY_SELECTION;
          return {
            shas,
            ...(prev.anchor !== undefined && present.has(prev.anchor) ? { anchor: prev.anchor } : {}),
          };
        });
      }
      if (page.page === 0) {
        refreshDoneRef.current?.();
        refreshDoneRef.current = undefined;
      }
      setEof(page.eof);
      pageRef.current = { next: page.page + 1, loading: false, eof: page.eof };
      setLoading(false);
    });
    const offReset = rpc.onEvent(LOG_METHODS.evtReset, (params) => {
      if (!isFor(params, tabId)) return;
      const dto = params as LogInitDto;
      // `preserve` marks a reset the host raised because history moved — after
      // a commit, a cherry-pick, a push. The rows still have to be rebuilt (a
      // new commit renumbers every page and relays the graph), but the user
      // did not ask for any of it: the graph and the selection stay on screen
      // until page 0 replaces them, rather than blanking and repainting — the
      // flash this used to be. The row at the top stays at the top. A user act
      // (filter, root, Refresh) resets cleanly, as before.
      restoreRef.current = undefined;
      setInit(dto);
      if (dto.presentation) presentationSeenRef.current(dto.presentation);
      // History moved or the view changed: a commit's refs may have too.
      detailsCache.current.clear();
      setEof(false);
      if (dto.preserve === true) {
        // `viewport.first` is overscanned — a few rows above the fold — so the
        // row actually at the top edge is derived from the offset instead.
        const topRow = rowsRef.current[Math.round(viewportRef.current.scrollTop / ROW_HEIGHT)];
        if (topRow !== undefined) restoreRef.current = { sha: topRow.sha, select: false };
        pruneOnPageZeroRef.current = true;
        // The details on show re-read their refs, in place.
        setDetailsEpoch((n) => n + 1);
      } else {
        setRows([]);
        setSelection(EMPTY_SELECTION);
      }
      pageRef.current = { next: 0, loading: false, eof: false };
      requestPage(0);
    });
    const offReveal = rpc.onEvent(LOG_METHODS.evtReveal, (params) => {
      if (!isFor(params, tabId)) return;
      const { sha } = params as { sha: string };
      const idx = rowsRef.current.findIndex((r) => r.sha === sha);
      if (idx !== -1) {
        listRef.current?.focusIndex(idx);
        selectOnly(sha);
      }
    });
    const offFocusFilter = rpc.onEvent(LOG_METHODS.evtFocusFilter, (params) => {
      if (!isFor(params, tabId)) return;
      // The strip may be bringing this tab forward in the same event; focus
      // once it is drawn, or the hidden box would refuse it.
      requestAnimationFrame(() => {
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
      });
    });
    // Roots-only update: merged into init rather than replacing it, so a
    // folder joining the workspace does not cost the rows or the selection.
    const offRoots = rpc.onEvent(LOG_METHODS.evtRoots, (params) => {
      const { roots } = params as { roots: LogRootDto[] };
      setInit((prev) => (prev ? { ...prev, roots } : prev));
    });

    const boot = savedRef.current;
    restoreRef.current =
      boot.focusSha !== undefined ? { sha: boot.focusSha, select: true } : undefined;
    void send<LogInitDto | undefined>(LOG_METHODS.init, {
      ...(tabId === MAIN_LOG_TAB && boot.filter !== undefined ? { filter: boot.filter } : {}),
    }).then((dto) => {
      // No answer: the tab was closed while it was starting.
      if (!dto) return;
      setInit(dto);
      if (dto.presentation) presentationSeenRef.current(dto.presentation);
      // A view started again while a diff it opened is still up.
      if (dto.diffOnScreen !== undefined) setDiffOnScreen(dto.diffOnScreen);
      requestPage(0);
    });
    return () => {
      offRows();
      offReset();
      offReveal();
      offFocusFilter();
      offRoots();
    };
    // Boot effect: intentionally runs once per tab.
  }, [rpc, tabId]); // requestPage/selectOnly are stable enough for the boot path

  const requestPage = useCallback(
    (page: number) => {
      if (pageRef.current.loading) return;
      pageRef.current.loading = true;
      setLoading(true);
      void send(LOG_METHODS.page, { page }).catch(() => {
        pageRef.current.loading = false;
        setLoading(false);
      });
    },
    [send],
  );

  /**
   * Reload / auto-refresh restore. This has to run AFTER the rows commit, not
   * from the `evtRows` handler: a reset empties the list, which collapses its
   * spacer and makes the browser clamp scrollTop to 0, so a scroll set before
   * React has painted the new rows is silently thrown away. Waiting for the
   * committed `rows` also means an anchor that page 0 does not carry is simply
   * found on whichever later page does.
   */
  useEffect(() => {
    const restore = restoreRef.current;
    if (restore === undefined) return;
    const idx = rows.findIndex((r) => r.sha === restore.sha);
    if (idx === -1) return;
    restoreRef.current = undefined;
    if (restore.select) selectOnly(restore.sha);
    // One frame so the taller spacer is laid out before the offset is applied.
    requestAnimationFrame(() =>
      // A restored selection is being read, so centre it; a scroll-only anchor
      // was the top row and belongs back at the top.
      listRef.current?.scrollToIndex(idx, restore.select ? 'center' : 'top'),
    );
  }, [rows, selectOnly]);

  // ---- infinite scroll ----
  const onViewport = useCallback(
    (v: GraphViewport) => {
      setViewport(v);
      const nearEnd = v.last >= rowsRef.current.length - 40;
      if (nearEnd && !pageRef.current.eof && !pageRef.current.loading && rowsRef.current.length > 0) {
        requestPage(pageRef.current.next);
      }
    },
    [requestPage],
  );

  // ---- selection ----
  /** A plain click or a plain arrow key: that commit alone. */
  const onFocusIndex = useCallback(
    (index: number) => {
      const row = rowsRef.current[index];
      if (!row) return;
      selectOnly(row.sha);
      onSaveRef.current({ focusSha: row.sha });
    },
    [selectOnly],
  );

  /**
   * Ctrl/⌘+click adds or removes a commit, Shift+click selects the run from
   * the anchor, both together add the run. The focus moves to the clicked row
   * without collapsing the selection to it.
   */
  const onRowClick = useCallback(
    (index: number, mods: { ctrlKey: boolean; shiftKey: boolean; metaKey: boolean }) => {
      const toggle = mods.ctrlKey || mods.metaKey;
      if (!toggle && !mods.shiftKey) return; // a plain click went through onFocusIndex
      setSelection((prev) =>
        clickSelection(rowShasRef.current, orderRef.current, prev, index, { toggle, range: mods.shiftKey }),
      );
      listRef.current?.focusIndex(index, { silent: true });
    },
    [],
  );

  /**
   * Shift with ↑ ↓ PageUp PageDown Home End grows or shrinks the run from the
   * anchor; Ctrl/⌘+A selects every loaded commit. The plain keys stay with the
   * list, which selects the row it lands on.
   */
  const onRowKeyDown = useCallback(
    (index: number, e: ReactKeyboardEvent<HTMLDivElement>): boolean => {
      const count = rowShasRef.current.length;
      if (count === 0) return false;
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'a') {
        e.preventDefault();
        setSelection((prev) => selectAll(rowShasRef.current, prev));
        return true;
      }
      if (!e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return false;
      const page = Math.max(1, Math.floor(listHeightRef.current / ROW_HEIGHT) - 1);
      const target = shiftTarget(e.key, Math.min(index, count - 1), page, count);
      if (target === undefined) return false;
      e.preventDefault();
      setSelection((prev) =>
        extendSelection(rowShasRef.current, orderRef.current, prev, target, Math.min(index, count - 1)),
      );
      listRef.current?.focusIndex(target, { silent: true });
      return true;
    },
    [],
  );

  /**
   * Right-click outside the selection selects that commit, as IntelliJ does;
   * inside it the selection stays, and the menu acts on all of it. (The menu
   * itself reads `data-vscode-context`, built from the selection as it stood.)
   */
  const onRowContextMenu = useCallback((index: number) => {
    const prev = selectionRef.current;
    const next = contextSelection(rowShasRef.current, prev, index);
    if (next === prev) return;
    setSelection(next);
    listRef.current?.focusIndex(index, { silent: true });
  }, []);

  // ---- keyboard: ctrl+c copies selected shas (of the tab on show only) ----
  useEffect(() => {
    if (!visible) return undefined;
    const onKey = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'c' && selected.length > 0) {
        void rpc.request(LOG_METHODS.copy, { text: selected.join('\n') });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [rpc, selected, visible]);

  // A tab brought forward again: the hover card of the one before it must go.
  useEffect(() => {
    if (!visible) cancelHover();
  }, [cancelHover, visible]);

  const applyFilter = useCallback(
    (next: LogFilterDto) => {
      // The host stores the tab's filter; the strip retitles from its echo.
      void send(LOG_METHODS.setFilter, { filter: next });
    },
    [send],
  );

  if (!init) {
    return <div className="gt-muted" style={{ padding: 12 }}>Loading log…</div>;
  }

  const laneWidth = init.laneWidth;
  const maxLane = rows.reduce((m, r) => Math.max(m, r.graph.nodeLane, ...r.graph.lanesBefore.map((l) => l.lane)), 0);
  const graphWidth = Math.min((maxLane + 1) * laneWidth + 8, 220);
  const listHeight = Math.max(size.height, 100);

  // The message column takes what Author, Date and Hash leave, and never less
  // than the graph and a readable stretch of message.
  const rowWidth = Math.max(0, (listWidth > 0 ? listWidth : size.width) - ROW_PADDING);
  const minSubject = graphWidth + MIN_MESSAGE_WIDTH;
  const columns = visibleColumns(presentation);
  const widths = fitColumns(columns, autoWidths, columnWidths, rowWidth, minSubject);
  const subjectWidth = rowWidth - columns.reduce((sum, id) => sum + widths[id], 0);
  const compact = presentation.compactReferences;
  const leftAligned = presentation.referencesOnLeft;

  /** The row's ref labels, grouped and fitted as IntelliJ's are. */
  const labelsFor = (row: LogRowDto): RefLabel[] => {
    const groups = groupRefs(row.refs, repo, { compact, showTagNames: presentation.showTagNames });
    if (groups.length === 0) return [];
    const column = Math.max(0, subjectWidth - graphWidth);
    const budget = labelsBudget(column, measure.text(row.subject), compact, leftAligned);
    return layoutLabels(groups, budget, compact, measure.label).labels;
  };

  /**
   * Dragging a column's left border: leftwards widens it. The width is kept
   * for this tab once the button is released.
   */
  const beginResize = (id: ColumnId, e: ReactMouseEvent<HTMLElement>): void => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    cancelHover();
    const startX = e.clientX;
    const start = widths[id];
    const others = columns.reduce((sum, c) => (c === id ? sum : sum + widths[c]), 0);
    // The last width is kept here as well as in state: the button can come up
    // before React has drawn the last move, and that move is the one to keep.
    let last: number | undefined;
    const onMove = (ev: MouseEvent): void => {
      const width = draggedWidth(start, ev.clientX - startX, others, rowWidth, minSubject);
      last = width;
      setColumnWidths((prev) => (prev[id] === width ? prev : { ...prev, [id]: width }));
    };
    const onUp = (): void => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.classList.remove('gt-col-resizing');
      // A press that never moved (half of a double-click) leaves the width alone.
      if (last === undefined) return;
      const next = { ...columnWidthsRef.current, [id]: last };
      setColumnWidths(next);
      onSaveRef.current({ columnWidths: next });
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    document.body.classList.add('gt-col-resizing');
  };

  /** A double-click on the border: the column fits its content again, as in IntelliJ. */
  const resetColumn = (id: ColumnId): void => {
    const next = { ...columnWidthsRef.current };
    delete next[id];
    setColumnWidths(next);
    onSaveRef.current({ columnWidths: next });
  };

  const cellText = (id: ColumnId, row: LogRowDto): string => {
    switch (id) {
      case 'author':
        return authorText(row.authorName, row.committedByOther);
      case 'date':
        return commitDate(row.authorTime);
      case 'hash':
        return row.sha.slice(0, SHORT_HASH_LENGTH);
    }
  };

  const commitsPane = (
    <div
      className="gt-log-rows"
      ref={rowsRefCallback}
      data-testid="log-rows"
      // One listener for the whole pane rather than one per row: rows are
      // recycled by the windowing, so a scroll that swaps the row under a
      // stationary pointer fires no mouseleave on the row that left. Clicking
      // is a selection gesture — the card must not outlive it and sit over
      // the rows the user was aiming at.
      onMouseLeave={cancelHover}
      onWheel={cancelHover}
      onMouseDown={cancelHover}
    >
      <GraphCanvas
        rows={rows}
        viewport={viewport}
        rowHeight={ROW_HEIGHT}
        laneWidth={laneWidth}
        width={graphWidth}
        height={listHeight}
        palette={init.graphPalette ?? 'default'}
      />
      <VirtualList
            ref={listRef}
            rowCount={rows.length + (eof ? 0 : 1)}
            rowHeight={ROW_HEIGHT}
            height={listHeight}
            ariaLabel="Commits"
            onFocusIndex={onFocusIndex}
            onRowClick={onRowClick}
            onRowKeyDown={onRowKeyDown}
            onRowContextMenu={onRowContextMenu}
            multiselectable
            isRowSelected={(i) => {
              const row = rows[i];
              return row !== undefined && selectedSet.has(row.sha);
            }}
            onRowMouseEnter={(i, el) => {
              const row = rows[i];
              if (row) beginHover(row.sha, el);
              else cancelHover();
            }}
            onViewport={onViewport}
            rowAriaLabel={(i) => {
              const row = rows[i];
              if (!row) return loading ? 'Loading…' : 'Load more';
              const refs = row.refs.length > 0 ? `, branch ${row.refs.map((r) => r.name).join(', ')}` : '';
              return `commit ${row.subject} by ${row.authorName}, ${commitDate(row.authorTime)}${refs}`;
            }}
            rowContext={(i) => {
              const row = rows[i];
              if (!row) return undefined;
              return commitMenuContext(row, selected, (sha) => {
                const at = order.get(sha);
                return at !== undefined ? rows[at] : undefined;
              });
            }}
            renderRow={(i) => {
              const row = rows[i];
              if (!row) {
                return (
                  <span className="gt-muted" data-testid="skeleton-row">
                    {loading ? 'Loading…' : ''}
                    {!loading && !eof ? (
                      <button type="button" className="gt-chip-main" onClick={() => requestPage(pageRef.current.next)}>
                        Load more
                      </button>
                    ) : null}
                  </span>
                );
              }
              const isSelected = selectedSet.has(row.sha);
              const isMine =
                highlightMine && branchesData?.myName !== undefined && row.authorName === branchesData.myName;
              const labels = labelsFor(row);
              const labelsEl =
                labels.length > 0 ? (
                  <RefLabels
                    labels={labels}
                    compact={compact}
                    onHover={(label, el) => beginRefsHover(row.sha, labelTooltip(label), el)}
                    onLeave={(el) => endRefsHover(row.sha, el)}
                  />
                ) : null;
              return (
                <span
                  className={`gt-log-row${isSelected ? ' gt-selected' : ''}${isMine ? ' gt-mine' : ''}`}
                  data-testid={`log-row-${i}`}
                >
                  <span className="gt-log-cell gt-log-subject-cell" style={{ paddingLeft: graphWidth }}>
                    {row.side !== undefined ? (
                      <span className={`gt-side-badge gt-side-${row.side}`}>
                        {row.side === 'left' ? '◀' : '▶'}
                      </span>
                    ) : null}
                    {leftAligned ? labelsEl : null}
                    <span className="gt-log-subject">{row.subject}</span>
                    {leftAligned ? null : labelsEl}
                  </span>
                  {columns.map((id) => (
                    <span
                      key={id}
                      className={`gt-log-cell gt-log-col gt-log-${id}`}
                      style={{ width: widths[id] }}
                      data-testid={`log-${id}`}
                    >
                      {/* The column's left border: drag to resize, double-click to fit. */}
                      <span
                        className="gt-col-resize"
                        aria-hidden="true"
                        data-testid={`col-resize-${id}`}
                        onMouseDown={(e) => beginResize(id, e)}
                        onClick={(e) => e.stopPropagation()}
                        onDoubleClick={(e) => {
                          e.stopPropagation();
                          resetColumn(id);
                        }}
                      />
                      {cellText(id, row)}
                    </span>
                  ))}
                </span>
              );
            }}
          />
    </div>
  );

  return (
    <>
      <FilterBar
        filter={filter}
        onChange={applyFilter}
        branches={branchesData}
        fetchAuthors={async () => {
          const res = await send<{ authors: string[] }>(LOG_METHODS.authors);
          return res?.authors ?? [];
        }}
        presets={init.presets ?? []}
        onSavePreset={() => void rpc.request(LOG_METHODS.savePreset, { filter })}
        onDeletePreset={(name) => void rpc.request(LOG_METHODS.deletePreset, { name })}
        refreshing={refreshing}
        onRefresh={() =>
          trackRefresh(
            () =>
              new Promise<void>((resolve) => {
                refreshDoneRef.current = resolve;
                // Nothing to re-read, or no answer: no rows are coming.
                send<{ ok?: boolean } | undefined>(LOG_METHODS.refresh).then(
                  (res) => {
                    if (res?.ok === false) resolve();
                  },
                  () => resolve(),
                );
                setTimeout(resolve, REFRESH_SPIN_MAX_MS);
              }),
          )
        }
        onGoToRef={(ref) => void send(LOG_METHODS.goToRef, { ref })}
        onBrowsePaths={() => void send(LOG_METHODS.pickPaths)}
        onPickPathsInTree={() => void send(LOG_METHODS.pickPathsInTree)}
        roots={init.roots ?? []}
        currentRoot={init.repoRoot}
        onSetRoot={(root) => void send(LOG_METHODS.setRoot, { root })}
        rootColor={(colorIdx) => laneColor(colorIdx, dark, init.graphPalette ?? 'default')}
        showDetails={layout.collapsed.files !== true || layout.collapsed.details !== true}
        onToggleDetails={() =>
          setLayout((prev) => {
            const hidden = prev.collapsed.files === true && prev.collapsed.details === true;
            return {
              ...prev,
              collapsed: { ...prev.collapsed, files: !hidden, details: !hidden },
            };
          })
        }
        highlightMine={highlightMine}
        onToggleHighlightMine={() => onHighlightMineChange(!highlightMine)}
        canHighlightMine={branchesData?.myName !== undefined}
        presentation={presentation}
        onPresentationChange={changePresentation}
        searchInputRef={searchInputRef}
      />
      {compared !== undefined ? (
        <CompareStrip
          range={compared}
          counts={rangeCounts}
          onShowFilesDiff={() => void send(LOG_METHODS.showFilesDiff)}
        />
      ) : null}
      {/* P10-T2: async loads announced to screen readers. */}
      <div className="gt-visually-hidden" aria-live="polite" data-testid="log-status">
        {loading ? 'Loading commits…' : `${rows.length} commits loaded${eof ? ', end of history' : ''}`}
      </div>
      <Shell
        layout={layout}
        onLayoutChange={setLayout}
        branches={
          <BranchesPane
            rpc={rpc}
            data={branchesData}
            repoRoot={init.repoRoot.length > 0 ? init.repoRoot : undefined}
            filter={filter}
            onFilterChange={applyFilter}
            onCollapsePane={() =>
              setLayout((prev) => ({
                ...prev,
                collapsed: { ...prev.collapsed, branches: true },
              }))
            }
            showTags={presentation.showTags}
            onShowTagsChange={(showTags) => changePresentation({ showTags })}
            logTab={tabId}
          />
        }
        commits={commitsPane}
        files={
          <ChangedFilesPane
            data={changed}
            loading={changedLoading}
            repoLabel={init.repoLabel}
            repoRoot={init.repoRoot}
            grouped={filesRollup}
            colors={init.colors}
            previewOnClick={previewOnClick}
            onOpenFile={(file, files, browsing) => {
              if (changed?.newest === undefined) return;
              // Several commits: the file carries its own two revisions.
              void send(LOG_METHODS.openFileDiff, { sha: changed.newest, file, files, browsing });
            }}
            onSelectedFileChange={setSelectedFile}
            {...(diffFile !== undefined && diffFile.sha === changed?.newest ? { follow: diffFile } : {})}
            {...(diffOnScreen !== undefined && diffOnScreen.sha === changed?.newest
              ? { onScreen: diffOnScreen.path }
              : {})}
          />
        }
        details={
          <DetailsPanel
            details={detailsList}
            selectedCount={selected.length}
            loading={detailsLoading}
            issue={init.issue}
            onCopy={(text: string) => void rpc.request(LOG_METHODS.copy, { text })}
            onGoTo={(sha: string) => void send(LOG_METHODS.goTo, { sha })}
            fetchContained={async (sha: string) => {
              const res = await send<{ branches: string[] }>(LOG_METHODS.containedBranches, { sha });
              return res?.branches ?? [];
            }}
          />
        }
        toolbars={{
          files: (
            <>
              <span className="gt-pane-count gt-muted">{changedFilesLabel(changed)}</span>
              <ToolbarButton
                icon="diff-multiple"
                label="Show all files in multi-diff"
                disabled={changed?.newest === undefined || changed.files.length === 0}
                onClick={() => {
                  if (changed?.newest !== undefined) {
                    void send(LOG_METHODS.openAllDiffs, {
                      sha: changed.newest,
                      ...(changed.shas !== undefined ? { shas: changed.shas } : {}),
                    });
                  }
                }}
              />
              <ToolbarButton
                icon={filesRollup ? 'list-tree' : 'list-flat'}
                label={filesRollup ? 'Flat file list' : 'Group by folder'}
                onClick={() => onFilesRollupChange(!filesRollup)}
              />
              <ToolbarButton
                icon="open-preview"
                label="Preview diff on click"
                toggled={previewOnClick}
                onClick={() => onPreviewOnClickChange(!previewOnClick)}
              />
              <ToolbarButton
                icon="history"
                label="Show History for Revision"
                disabled={selectedFile === undefined}
                onClick={() => {
                  if (selectedFile !== undefined) {
                    void send(LOG_METHODS.showFileHistory, { path: selectedFile.path });
                  }
                }}
              />
            </>
          ),
        }}
      />

      {hover !== undefined && visible ? (
        <CommitTooltip
          text={hover.text}
          anchor={hover.anchor}
          testId={hover.kind === 'refs' ? 'refs-tooltip' : 'commit-tooltip'}
        />
      ) : null}
    </>
  );
}
