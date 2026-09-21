/**
 * Git tool window (P12-T1, over the P4 machinery): `Log` tab → filter bar →
 * the §2A four-pane layout `[Branches | Commits] | [Changed Files / Commit
 * Details]`, every ratio and collapse persisted. Rows stay in a VirtualList
 * with the canvas graph layer; infinite scroll pages over RPC; the selection
 * is mirrored host-side (`log/select`) so multi-commit actions read one model.
 * The `Console` tab arrives with P12-T8 — a dead tab is a worse affordance
 * than none (the P11-T2 precedent).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  LOG_METHODS,
  type CommitDetailsDto,
  type CommitFileDto,
  type LogBranchesDto,
  type LogChangedFilesDto,
  type LogFilterDto,
  type LogInitDto,
  type LogPageDto,
  type LogRootDto,
  type LogRowDto,
} from '../../../src/shared/protocol';
import { RpcClient } from '../lib/rpc';
import { TabPanel, Tabs } from '../lib/Tabs';
import { ToolbarButton } from '../lib/Toolbar';
import { useElementSize } from '../lib/useElementSize';
import { useVsCodeTheme } from '../lib/useVsCodeTheme';
import { VirtualList, type VirtualListHandle } from '../lib/VirtualList';
import { getVsCodeApi } from '../lib/vscodeApi';
import { BranchesPane } from './BranchesPane';
import { ChangedFilesPane, changedFilesLabel } from './ChangedFilesPane';
import { CommitTooltip } from './CommitTooltip';
import { ConsolePane } from './ConsolePane';
import { WorktreesPane } from './WorktreesPane';
import { DetailsPanel } from './DetailsPanel';
import { FilterBar } from './FilterBar';
import { GraphCanvas, laneColor, type GraphViewport } from './GraphCanvas';
import { DEFAULT_LAYOUT, Shell, type ShellLayout } from './Shell';

const ROW_HEIGHT = 24;

interface PersistedState {
  filter?: LogFilterDto;
  focusSha?: string;
  /** P12-T1: pane ratios + collapse flags, restored exactly across reload. */
  layout?: ShellLayout;
  filesRollup?: boolean;
  previewOnClick?: boolean;
  highlightMine?: boolean;
  tab?: string;
}

function relativeDate(unixSeconds: number): string {
  const deltaMin = Math.round((Date.now() / 1000 - unixSeconds) / 60);
  if (deltaMin < 1) return 'now';
  if (deltaMin < 60) return `${deltaMin}m`;
  const h = Math.round(deltaMin / 60);
  if (h < 24) return `${h}h`;
  const d = Math.round(h / 24);
  if (d < 60) return `${d}d`;
  return new Date(unixSeconds * 1000).toLocaleDateString();
}

export function App() {
  const rpc = useMemo(() => new RpcClient(), []);
  const theme = useVsCodeTheme();
  const dark = theme === 'dark' || theme === 'high-contrast';
  const listRef = useRef<VirtualListHandle>(null);

  const [init, setInit] = useState<LogInitDto | undefined>();
  const [rows, setRows] = useState<LogRowDto[]>([]);
  const [eof, setEof] = useState(false);
  const [loading, setLoading] = useState(false);
  const [viewport, setViewport] = useState<GraphViewport>({ scrollTop: 0, first: 0, last: 0 });
  const [selected, setSelected] = useState<string[]>([]);
  const [details, setDetails] = useState<CommitDetailsDto | undefined>();
  const [detailsLoading, setDetailsLoading] = useState(false);
  // P10-T2: gittree.log.focusFilter lands here (keyboard parity).
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  // P12-T1: layout + pane preferences, persisted with the filter.
  const boot = useMemo(() => (getVsCodeApi().getState() as PersistedState | undefined) ?? {}, []);
  const [layout, setLayout] = useState<ShellLayout>(boot.layout ?? DEFAULT_LAYOUT);
  const [filesRollup, setFilesRollup] = useState(boot.filesRollup ?? true);
  // P12-T3: the Changed Files pane's own data (single commit or aggregate).
  const [changed, setChanged] = useState<LogChangedFilesDto | undefined>(undefined);
  const [changedLoading, setChangedLoading] = useState(false);
  const [selectedFile, setSelectedFile] = useState<CommitFileDto | undefined>(undefined);
  const [previewOnClick, setPreviewOnClick] = useState(boot.previewOnClick ?? false);
  // P12-T5: refs data is shared by the Branches pane AND the filter row.
  const [branchesData, setBranchesData] = useState<LogBranchesDto | null>(null);
  const [highlightMine, setHighlightMine] = useState(boot.highlightMine ?? false);
  // P12-T8: the Log | Console strip; the active tab persists (step 1).
  const [tab, setTab] = useState(boot.tab ?? 'log');
  // POST-P14x: the row hover card. `text` is the full commit message, fetched
  // lazily — see LOG_METHODS.commitMessage for why it is not on the row DTO.
  const [hover, setHover] = useState<
    { sha: string; text: string; anchor: { left: number; top: number; bottom: number } } | undefined
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

  useEffect(() => {
    const reload = (): void => {
      rpc.request<LogBranchesDto>(LOG_METHODS.branches).then(
        (next) => setBranchesData(next ?? null),
        () => setBranchesData(null),
      );
    };
    reload();
    return rpc.onEvent(LOG_METHODS.evtBranches, reload);
  }, [rpc]);

  const filter = init?.filter ?? { sort: 'topo', refs: 'HEAD' as const };
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  // The boot effect runs once per rpc, so what it reads at event time has to
  // come through refs — a closure would hold the first render's empty values.
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const viewportRef = useRef(viewport);
  viewportRef.current = viewport;
  const pageRef = useRef({ next: 0, loading: false, eof: false });

  /** Merge-persist: layout, filter and focus share one state bag. */
  const persist = useCallback((patch: Partial<PersistedState>) => {
    const prev = (getVsCodeApi().getState() as PersistedState | undefined) ?? {};
    getVsCodeApi().setState({ ...prev, ...patch });
  }, []);

  useEffect(() => {
    persist({ layout, filesRollup, previewOnClick, highlightMine, tab });
  }, [filesRollup, highlightMine, layout, persist, previewOnClick, tab]);

  // P12-T3: the pane follows the selection — one commit's files, or the
  // aggregate change set of a multi-select.
  useEffect(() => {
    if (selected.length === 0) {
      setChanged(undefined);
      return;
    }
    let cancelled = false;
    setChangedLoading(true);
    rpc.request<LogChangedFilesDto>(LOG_METHODS.changedFiles, { shas: selected }).then(
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
  }, [rpc, selected]);

  // P12-T1: the selection is one host-side model — every pane and every
  // command reads the same list, pushed here on each change.
  useEffect(() => {
    void rpc.request(LOG_METHODS.select, { shas: selected }).catch(() => undefined);
  }, [rpc, selected]);

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
        rpc
          .request<{ message?: string }>(LOG_METHODS.commitMessage, { sha })
          .then((res) => {
            const text = res?.message ?? '';
            messages.current.set(sha, text);
            show(text);
          })
          .catch(() => undefined);
      }, HOVER_DELAY_MS);
    },
    [rpc],
  );

  // ---- container sizing ----
  // useElementSize (callback ref) survives the Log tab unmounting/remounting
  // around the Console tab — an object-ref ResizeObserver would keep watching
  // the detached node (the P11-T4 lesson).
  const [containerRef, measured] = useElementSize<HTMLDivElement>();
  const size = { width: measured.width || 800, height: measured.height || 400 };

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
      const page = params as LogPageDto;
      setRows((prev) => {
        // Pages arrive in order; page.page * PAGE alignment is guaranteed by
        // the host (it replays from its row store on rehydrate).
        const next = page.page === 0 ? [...page.rows] : [...prev, ...page.rows];
        return next;
      });
      setEof(page.eof);
      pageRef.current = { next: page.page + 1, loading: false, eof: page.eof };
      setLoading(false);
    });
    const offReset = rpc.onEvent(LOG_METHODS.evtReset, (params) => {
      const dto = params as LogInitDto;
      // `preserve` marks a reset the host raised because history moved. The
      // rows still have to be rebuilt — a new commit renumbers every page and
      // relays the graph — but the user did not ask to be sent back to the
      // top, so anchor on what they were looking at and restore it when page 0
      // lands. A user act (filter, root, Refresh) resets cleanly, as before.
      restoreRef.current = undefined;
      if (dto.preserve === true) {
        const focused = selectedRef.current[0];
        // `viewport.first` is overscanned — a few rows above the fold — so the
        // row actually at the top edge is derived from the offset instead.
        const topRow = rowsRef.current[Math.round(viewportRef.current.scrollTop / ROW_HEIGHT)];
        const anchor = focused ?? topRow?.sha;
        if (anchor !== undefined) restoreRef.current = { sha: anchor, select: focused !== undefined };
      }
      setInit(dto);
      setRows([]);
      setSelected([]);
      setDetails(undefined);
      setEof(false);
      pageRef.current = { next: 0, loading: false, eof: false };
      requestPage(0);
    });
    const offReveal = rpc.onEvent(LOG_METHODS.evtReveal, (params) => {
      const { sha } = params as { sha: string };
      const idx = rowsRef.current.findIndex((r) => r.sha === sha);
      if (idx !== -1) {
        listRef.current?.focusIndex(idx);
        setSelected([sha]);
        void loadDetails(sha);
      }
    });
    const offFocusFilter = rpc.onEvent(LOG_METHODS.evtFocusFilter, () => {
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
    });
    // Roots-only update: merged into init rather than replacing it, so a
    // folder joining the workspace does not cost the rows or the selection.
    const offRoots = rpc.onEvent(LOG_METHODS.evtRoots, (params) => {
      const { roots } = params as { roots: LogRootDto[] };
      setInit((prev) => (prev ? { ...prev, roots } : prev));
    });

    const saved = (getVsCodeApi().getState() as PersistedState | undefined) ?? {};
    restoreRef.current =
      saved.focusSha !== undefined ? { sha: saved.focusSha, select: true } : undefined;
    void rpc.request<LogInitDto>(LOG_METHODS.init, { filter: saved.filter }).then((dto) => {
      setInit(dto);
      requestPage(0);
    });
    return () => {
      offRows();
      offReset();
      offReveal();
      offFocusFilter();
      offRoots();
    };
    // Boot effect: intentionally runs once per rpc instance.
  }, [rpc]); // requestPage/loadDetails are stable enough for the boot path

  const requestPage = useCallback(
    (page: number) => {
      if (pageRef.current.loading) return;
      pageRef.current.loading = true;
      setLoading(true);
      void rpc.request(LOG_METHODS.page, { page }).catch(() => {
        pageRef.current.loading = false;
        setLoading(false);
      });
    },
    [rpc],
  );

  const loadDetails = useCallback(
    async (sha: string) => {
      setDetailsLoading(true);
      try {
        const d = await rpc.request<CommitDetailsDto | undefined>(LOG_METHODS.details, { sha });
        setDetails(d ?? undefined);
      } finally {
        setDetailsLoading(false);
      }
    },
    [rpc],
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
    if (restore.select) {
      setSelected([restore.sha]);
      void loadDetails(restore.sha);
    }
    // One frame so the taller spacer is laid out before the offset is applied.
    requestAnimationFrame(() =>
      // A restored selection is being read, so centre it; a scroll-only anchor
      // was the top row and belongs back at the top.
      listRef.current?.scrollToIndex(idx, restore.select ? 'center' : 'top'),
    );
  }, [rows, loadDetails]);

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
  const onFocusIndex = useCallback(
    (index: number) => {
      const row = rowsRef.current[index];
      if (!row) return;
      setSelected([row.sha]);
      persist({ filter, focusSha: row.sha });
      void loadDetails(row.sha);
    },
    [filter, loadDetails, persist],
  );

  const onRowClick = useCallback(
    (index: number, mods: { ctrlKey: boolean; shiftKey: boolean; metaKey: boolean }) => {
      const row = rowsRef.current[index];
      if (!row) return;
      if (mods.ctrlKey || mods.metaKey) {
        setSelected((prev) =>
          prev.includes(row.sha) ? prev.filter((s) => s !== row.sha) : [...prev, row.sha],
        );
      } else if (mods.shiftKey && selected.length > 0) {
        const anchor = rowsRef.current.findIndex((r) => r.sha === selected[0]);
        if (anchor !== -1) {
          const [a, b] = anchor < index ? [anchor, index] : [index, anchor];
          setSelected(rowsRef.current.slice(a, b + 1).map((r) => r.sha));
        }
      }
      // plain click handled by onFocusIndex
    },
    [selected],
  );

  // ---- keyboard: ctrl+c copies selected shas ----
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'c' && selected.length > 0) {
        void rpc.request(LOG_METHODS.copy, { text: selected.join('\n') });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [rpc, selected]);

  const applyFilter = useCallback(
    (next: LogFilterDto) => {
      persist({ filter: next });
      void rpc.request(LOG_METHODS.setFilter, { filter: next });
    },
    [persist, rpc],
  );

  if (!init) {
    return <div className="gt-muted" style={{ padding: 12 }}>Loading log…</div>;
  }

  const laneWidth = init.laneWidth;
  const maxLane = rows.reduce((m, r) => Math.max(m, r.graph.nodeLane, ...r.graph.lanesBefore.map((l) => l.lane)), 0);
  const graphWidth = Math.min((maxLane + 1) * laneWidth + 8, 220);
  const listHeight = Math.max(size.height, 100);

  const commitsPane = (
    <div
      className="gt-log-rows"
      ref={containerRef}
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
              return `commit ${row.subject} by ${row.authorName}, ${relativeDate(row.authorTime)}${refs}`;
            }}
            rowContext={(i) => {
              const row = rows[i];
              if (!row) return undefined;
              const shas = selected.includes(row.sha) && selected.length > 1 ? selected : [row.sha];
              return {
                webviewSection: 'commit',
                sha: row.sha,
                shas,
                preventDefaultContextMenuItems: true,
              };
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
              const isSelected = selected.includes(row.sha);
              const isMine =
                highlightMine && branchesData?.myName !== undefined && row.authorName === branchesData.myName;
              return (
                <span
                  className={`gt-log-row${isSelected ? ' gt-selected' : ''}${isMine ? ' gt-mine' : ''}`}
                  style={{ paddingLeft: graphWidth }}
                  data-testid={`log-row-${i}`}
                >
                  {row.side !== undefined ? (
                    <span className={`gt-side-badge gt-side-${row.side}`}>
                      {row.side === 'left' ? '◀' : '▶'}
                    </span>
                  ) : null}
                  {row.refs.map((r) => (
                    <span
                      key={`${r.type}:${r.name}`}
                      className={`gt-ref-chip gt-ref-${r.type}${r.isHeadTarget === true ? ' gt-ref-headTarget' : ''}`}
                      style={{ borderColor: laneColor(row.graph.colorIdx, dark, init.graphPalette ?? 'default') }}
                    >
                      {r.name}
                    </span>
                  ))}
                  <span className="gt-log-subject">{row.subject}</span>
                  <span className="gt-log-meta gt-muted">
                    {row.authorName} · {relativeDate(row.authorTime)} · {row.sha.slice(0, 7)}
                  </span>
                </span>
              );
            }}
          />
    </div>
  );

  return (
    <div className="gt-log-root">
      <Tabs
        ariaLabel="Git tool window"
        active={tab}
        onChange={setTab}
        tabs={[
          { id: 'log', label: 'Log' },
          { id: 'console', label: 'Console' },
          { id: 'worktrees', label: 'Worktrees' },
        ]}
      />
      <TabPanel id="worktrees" active={tab} className="gt-log-tabpanel">
        <WorktreesPane rpc={rpc} />
      </TabPanel>
      <TabPanel id="console" active={tab} className="gt-log-tabpanel">
        <ConsolePane
          rpc={rpc}
          onCopy={(text: string) => void rpc.request(LOG_METHODS.copy, { text })}
        />
      </TabPanel>
      <TabPanel id="log" active={tab} className="gt-log-tabpanel">
        <FilterBar
          filter={filter}
          onChange={applyFilter}
          branches={branchesData}
          fetchAuthors={async () => {
            const res = await rpc.request<{ authors: string[] }>(LOG_METHODS.authors);
            return res?.authors ?? [];
          }}
          presets={init.presets ?? []}
          onSavePreset={() => void rpc.request(LOG_METHODS.savePreset, { filter })}
          onDeletePreset={(name) => void rpc.request(LOG_METHODS.deletePreset, { name })}
          onRefresh={() => void rpc.request(LOG_METHODS.refresh)}
          onGoToRef={(ref) => void rpc.request(LOG_METHODS.goToRef, { ref })}
          onBrowsePaths={() => void rpc.request(LOG_METHODS.pickPaths)}
          onPickPathsInTree={() => void rpc.request(LOG_METHODS.pickPathsInTree)}
          roots={init.roots ?? []}
          currentRoot={init.repoRoot}
          onSetRoot={(root) => void rpc.request(LOG_METHODS.setRoot, { root })}
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
          onToggleHighlightMine={() => setHighlightMine((v) => !v)}
          canHighlightMine={branchesData?.myName !== undefined}
          searchInputRef={searchInputRef}
        />
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
              onOpenFile={(file: CommitFileDto) => {
                if (changed?.newest === undefined) return;
                void rpc.request(LOG_METHODS.openFileDiff, {
                  sha: changed.newest,
                  file,
                  ...(changed.base !== undefined ? { base: changed.base } : {}),
                });
              }}
              onSelectedFileChange={setSelectedFile}
            />
          }
          details={
            <DetailsPanel
              details={details}
              loading={detailsLoading}
              issue={init.issue}
              onCopy={(text: string) => void rpc.request(LOG_METHODS.copy, { text })}
              onGoTo={(sha: string) => void rpc.request(LOG_METHODS.goTo, { sha })}
              fetchContained={async (sha: string) => {
                const res = await rpc.request<{ branches: string[] }>(
                  LOG_METHODS.containedBranches,
                  { sha },
                );
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
                  disabled={changed?.newest === undefined || changed.base !== undefined}
                  onClick={() => {
                    if (changed?.newest !== undefined) {
                      void rpc.request(LOG_METHODS.openAllDiffs, { sha: changed.newest });
                    }
                  }}
                />
                <ToolbarButton
                  icon={filesRollup ? 'list-tree' : 'list-flat'}
                  label={filesRollup ? 'Flat file list' : 'Group by folder'}
                  onClick={() => setFilesRollup((v) => !v)}
                />
                <ToolbarButton
                  icon="open-preview"
                  label="Preview diff on click"
                  toggled={previewOnClick}
                  onClick={() => setPreviewOnClick((v) => !v)}
                />
                <ToolbarButton
                  icon="history"
                  label="Show History for Revision"
                  disabled={selectedFile === undefined}
                  onClick={() => {
                    if (selectedFile !== undefined) {
                      void rpc.request(LOG_METHODS.showFileHistory, { path: selectedFile.path });
                    }
                  }}
                />
              </>
            ),
          }}
        />
      </TabPanel>

      {hover !== undefined ? <CommitTooltip text={hover.text} anchor={hover.anchor} /> : null}
    </div>
  );
}
