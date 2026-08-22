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
  type LogChangedFilesDto,
  type LogFilterDto,
  type LogInitDto,
  type LogPageDto,
  type LogRowDto,
} from '../../../src/shared/protocol';
import { RpcClient } from '../lib/rpc';
import { TabPanel, Tabs } from '../lib/Tabs';
import { ToolbarButton } from '../lib/Toolbar';
import { useVsCodeTheme } from '../lib/useVsCodeTheme';
import { VirtualList, type VirtualListHandle } from '../lib/VirtualList';
import { getVsCodeApi } from '../lib/vscodeApi';
import { BranchesPane } from './BranchesPane';
import { ChangedFilesPane, changedFilesLabel } from './ChangedFilesPane';
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
  const [size, setSize] = useState({ width: 800, height: 400 });
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

  const filter = init?.filter ?? { sort: 'topo', refs: 'HEAD' as const };
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const pageRef = useRef({ next: 0, loading: false, eof: false });

  /** Merge-persist: layout, filter and focus share one state bag. */
  const persist = useCallback((patch: Partial<PersistedState>) => {
    const prev = (getVsCodeApi().getState() as PersistedState | undefined) ?? {};
    getVsCodeApi().setState({ ...prev, ...patch });
  }, []);

  useEffect(() => {
    persist({ layout, filesRollup, previewOnClick });
  }, [filesRollup, layout, persist, previewOnClick]);

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

  // ---- container sizing ----
  const containerRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      setSize({ width: el.clientWidth, height: el.clientHeight });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [init]);

  // ---- boot + host events ----
  const restoreShaRef = useRef<string | undefined>(undefined);
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
      // Reload restore: reselect the previously focused commit (position).
      const restore = restoreShaRef.current;
      if (restore !== undefined) {
        const idx = page.rows.findIndex((r) => r.sha === restore);
        if (idx !== -1) {
          restoreShaRef.current = undefined;
          const absolute = page.page === 0 ? idx : rowsRef.current.length + idx;
          setSelected([restore]);
          void loadDetails(restore);
          requestAnimationFrame(() => listRef.current?.scrollToIndex(absolute, 'center'));
        }
      }
    });
    const offReset = rpc.onEvent(LOG_METHODS.evtReset, (params) => {
      const dto = params as LogInitDto;
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

    const saved = (getVsCodeApi().getState() as PersistedState | undefined) ?? {};
    restoreShaRef.current = saved.focusSha;
    void rpc.request<LogInitDto>(LOG_METHODS.init, { filter: saved.filter }).then((dto) => {
      setInit(dto);
      requestPage(0);
    });
    return () => {
      offRows();
      offReset();
      offReveal();
      offFocusFilter();
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
    <div className="gt-log-rows" ref={containerRef} data-testid="log-rows">
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
              return (
                <span
                  className={`gt-log-row${isSelected ? ' gt-selected' : ''}`}
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
        active="log"
        onChange={() => undefined}
        tabs={[{ id: 'log', label: 'Log' }]}
      />
      <TabPanel id="log" active="log" className="gt-log-tabpanel">
        <FilterBar
          filter={filter}
          onChange={applyFilter}
          onPickBranches={() => void rpc.request(LOG_METHODS.pickBranches)}
          onPickAuthors={() => void rpc.request(LOG_METHODS.pickAuthors)}
          onPickDates={() => void rpc.request(LOG_METHODS.pickDates)}
          onPickPaths={() => void rpc.request(LOG_METHODS.pickPaths)}
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
    </div>
  );
}
