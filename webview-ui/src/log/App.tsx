/**
 * Log tool window (P4-T3): filter bar · graph+rows · details panel.
 * Rows in VirtualList with a canvas graph layer; infinite scroll pages over
 * RPC; selection feeds data-vscode-context for native menus; state persists
 * via getState/setState with host rehydrate.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  LOG_METHODS,
  type CommitDetailsDto,
  type CommitFileDto,
  type LogFilterDto,
  type LogInitDto,
  type LogPageDto,
  type LogRowDto,
} from '../../../src/shared/protocol';
import { RpcClient } from '../lib/rpc';
import { useVsCodeTheme } from '../lib/useVsCodeTheme';
import { VirtualList, type VirtualListHandle } from '../lib/VirtualList';
import { getVsCodeApi } from '../lib/vscodeApi';
import { DetailsPanel } from './DetailsPanel';
import { FilterBar } from './FilterBar';
import { GraphCanvas, laneColor, type GraphViewport } from './GraphCanvas';

const ROW_HEIGHT = 24;

interface PersistedState {
  filter?: LogFilterDto;
  focusSha?: string;
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

  const filter = init?.filter ?? { sort: 'topo', refs: 'HEAD' as const };
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const pageRef = useRef({ next: 0, loading: false, eof: false });

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
      getVsCodeApi().setState({ filter, focusSha: row.sha } satisfies PersistedState);
      void loadDetails(row.sha);
    },
    [filter, loadDetails],
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
      getVsCodeApi().setState({ filter: next } satisfies PersistedState);
      void rpc.request(LOG_METHODS.setFilter, { filter: next });
    },
    [rpc],
  );

  if (!init) {
    return <div className="gt-muted" style={{ padding: 12 }}>Loading log…</div>;
  }

  const laneWidth = init.laneWidth;
  const maxLane = rows.reduce((m, r) => Math.max(m, r.graph.nodeLane, ...r.graph.lanesBefore.map((l) => l.lane)), 0);
  const graphWidth = Math.min((maxLane + 1) * laneWidth + 8, 220);
  const listHeight = Math.max(size.height, 100);

  return (
    <div className="gt-log-root">
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
      <div className="gt-log-main">
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
        <DetailsPanelHost
          rpc={rpc}
          details={details}
          loading={detailsLoading}
        />
      </div>
    </div>
  );
}

function DetailsPanelHost({
  rpc,
  details,
  loading,
}: {
  rpc: RpcClient;
  details: CommitDetailsDto | undefined;
  loading: boolean;
}) {
  return (
    <DetailsPanel
      details={details}
      loading={loading}
      onOpenFile={(file: CommitFileDto) => {
        if (details) void rpc.request(LOG_METHODS.openFileDiff, { sha: details.sha, file });
      }}
      onOpenAll={() => {
        if (details) void rpc.request(LOG_METHODS.openAllDiffs, { sha: details.sha });
      }}
      onCopySha={(sha: string) => void rpc.request(LOG_METHODS.copy, { text: sha })}
    />
  );
}
