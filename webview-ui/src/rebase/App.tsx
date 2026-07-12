/**
 * Interactive Rebase dialog (P5-T2, IntelliJ parity): ordered rows
 * [⋮⋮ drag] [action ▾] [shortsha] [subject] [author · date] with pointer DnD,
 * per-row action dropdowns, inline reword/squash message editors, live
 * validation, and a progress mode once the rebase starts. Keyboard:
 * ArrowUp/Down roving focus, Alt+↑/↓ reorder, p/r/s/f/d action hotkeys,
 * Enter/F2 message editor.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  REBASE_METHODS,
  type RebaseActionDto,
  type RebaseRowDto,
  type RebaseStateDto,
} from '../../../src/shared/protocol';
import { RpcClient } from '../lib/rpc';
import { getVsCodeApi } from '../lib/vscodeApi';

const ACTIONS: RebaseActionDto[] = ['pick', 'reword', 'squash', 'fixup', 'drop'];
const HOTKEYS: Record<string, RebaseActionDto> = {
  p: 'pick',
  r: 'reword',
  s: 'squash',
  f: 'fixup',
  d: 'drop',
};

const rpc = new RpcClient();
const vscode = getVsCodeApi();

function effectiveMessage(row: RebaseRowDto): string {
  const custom = row.newMessage?.trim();
  return custom !== undefined && custom.length > 0 ? custom : row.message;
}

/** First non-drop row index (squash/fixup is invalid there). */
function firstKeptIndex(rows: readonly RebaseRowDto[]): number {
  return rows.findIndex((r) => r.action !== 'drop');
}

function validate(rows: readonly RebaseRowDto[]): string | undefined {
  if (rows.length === 0) return 'Nothing to rebase.';
  if (rows.every((r) => r.action === 'drop')) {
    return 'All commits are dropped — nothing would remain.';
  }
  const first = rows[firstKeptIndex(rows)];
  if (first && (first.action === 'squash' || first.action === 'fixup')) {
    return 'The first commit cannot be squashed or fixed up.';
  }
  return undefined;
}

/** IntelliJ prefill: messages of the squash group head + members up to idx. */
function combinedMessageFor(rows: readonly RebaseRowDto[], idx: number): string {
  const parts: string[] = [];
  let head = idx;
  for (let i = idx - 1; i >= 0; i--) {
    const r = rows[i];
    if (!r || r.action === 'drop') continue;
    head = i;
    if (r.action !== 'squash' && r.action !== 'fixup') break;
  }
  for (let i = head; i <= idx; i++) {
    const r = rows[i];
    if (!r || r.action === 'drop' || r.action === 'fixup') continue;
    parts.push(r.message);
  }
  return parts.join('\n\n');
}

function fmtDate(unixSecs: number): string {
  return new Date(unixSecs * 1000).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

export function App() {
  const [dto, setDto] = useState<RebaseStateDto | null>(null);
  const [rows, setRows] = useState<RebaseRowDto[]>([]);
  const [forceAck, setForceAck] = useState(false);
  const [focusIdx, setFocusIdx] = useState(0);
  const [editingIdx, setEditingIdx] = useState<number | null>(null);
  const [draft, setDraft] = useState('');
  const [drag, setDrag] = useState<{ from: number; over: number } | null>(null);
  const [startError, setStartError] = useState<string | undefined>(undefined);
  const listRef = useRef<HTMLDivElement | null>(null);
  const rowRefs = useRef(new Map<number, HTMLDivElement>());
  const dragRef = useRef<{ from: number; over: number } | null>(null);

  const adopt = useCallback((state: RebaseStateDto) => {
    setDto(state);
    if (state.phase === 'edit') setRows(state.rows);
  }, []);

  useEffect(() => {
    const restored = vscode.getState() as { focusIdx?: number } | undefined;
    if (restored?.focusIdx !== undefined) setFocusIdx(restored.focusIdx);
    void rpc.request<RebaseStateDto | undefined>(REBASE_METHODS.init).then((state) => {
      if (state) adopt(state);
    });
    const offState = rpc.onEvent(REBASE_METHODS.evtState, (params) =>
      adopt(params as RebaseStateDto),
    );
    const offReset = rpc.onEvent(REBASE_METHODS.evtResetAction, (params) => {
      const sha = (params as { sha?: string }).sha;
      setRows((rs) =>
        rs.map((r) => {
          if (r.sha !== sha) return r;
          const { newMessage: _drop, ...rest } = r;
          return { ...rest, action: 'pick' };
        }),
      );
    });
    return () => {
      offState();
      offReset();
    };
  }, [adopt]);

  useEffect(() => {
    vscode.setState({ focusIdx });
  }, [focusIdx]);

  const validation = useMemo(() => validate(rows), [rows]);
  const counts = useMemo(() => {
    const c: Record<RebaseActionDto, number> = { pick: 0, reword: 0, squash: 0, fixup: 0, drop: 0 };
    for (const r of rows) c[r.action] += 1;
    return c;
  }, [rows]);

  const moveRow = useCallback((from: number, to: number) => {
    setRows((rs) => {
      if (from === to || from < 0 || from >= rs.length || to < 0 || to > rs.length) return rs;
      const next = [...rs];
      const [row] = next.splice(from, 1);
      if (!row) return rs;
      next.splice(to > from ? to - 1 : to, 0, row);
      return next;
    });
  }, []);

  const setAction = useCallback(
    (idx: number, action: RebaseActionDto) => {
      setStartError(undefined);
      const target = rows[idx];
      if (!target) return;
      const next = rows.map((r, i) => (i === idx ? { ...r, action } : r));
      const issue = validate(next);
      // Block the structural first-row error outright; other issues surface
      // in the footer and merely disable Start.
      if (issue !== undefined && issue.includes('first commit') && validate(rows) === undefined) {
        setStartError(issue);
        return;
      }
      setRows(next);
      if (action === 'reword' || action === 'squash') {
        setEditingIdx(idx);
        setDraft(
          target.newMessage ??
            (action === 'squash' ? combinedMessageFor(next, idx) : target.message),
        );
      }
    },
    [rows],
  );

  const commitDraft = useCallback(() => {
    setEditingIdx((idx) => {
      if (idx !== null) {
        setRows((rs) => rs.map((r, i) => (i === idx ? { ...r, newMessage: draft } : r)));
      }
      return null;
    });
  }, [draft]);

  // ---- pointer DnD ---------------------------------------------------------
  const onHandlePointerDown = useCallback(
    (idx: number, e: React.PointerEvent) => {
      e.preventDefault();
      const start = { from: idx, over: idx };
      dragRef.current = start;
      setDrag(start);
      const onMove = (ev: PointerEvent): void => {
        const list = listRef.current;
        if (!list || !dragRef.current) return;
        const rect = list.getBoundingClientRect();
        if (ev.clientY < rect.top + 28) list.scrollTop -= 8;
        else if (ev.clientY > rect.bottom - 28) list.scrollTop += 8;
        let over = rowsLengthRef.current;
        for (let i = 0; i < rowsLengthRef.current; i++) {
          const el = rowRefs.current.get(i);
          if (!el) continue;
          const r = el.getBoundingClientRect();
          if (ev.clientY < r.top + r.height / 2) {
            over = i;
            break;
          }
        }
        dragRef.current = { ...dragRef.current, over };
        setDrag(dragRef.current);
      };
      const onUp = (): void => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        const d = dragRef.current;
        dragRef.current = null;
        setDrag(null);
        if (d) moveRow(d.from, d.over);
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    },
    [moveRow],
  );
  const rowsLengthRef = useRef(0);
  rowsLengthRef.current = rows.length;

  // ---- keyboard ------------------------------------------------------------
  const onRowKeyDown = useCallback(
    (idx: number, e: React.KeyboardEvent) => {
      if (editingIdx !== null) return;
      if (e.altKey && e.key === 'ArrowUp') {
        e.preventDefault();
        moveRow(idx, Math.max(0, idx - 1));
        setFocusIdx(Math.max(0, idx - 1));
      } else if (e.altKey && e.key === 'ArrowDown') {
        e.preventDefault();
        moveRow(idx, Math.min(rows.length, idx + 2));
        setFocusIdx(Math.min(rows.length - 1, idx + 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setFocusIdx(Math.max(0, idx - 1));
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        setFocusIdx(Math.min(rows.length - 1, idx + 1));
      } else if (e.key === 'Enter' || e.key === 'F2') {
        const row = rows[idx];
        if (row && (row.action === 'reword' || row.action === 'squash')) {
          e.preventDefault();
          setEditingIdx(idx);
          setDraft(
            row.newMessage ??
              (row.action === 'squash' ? combinedMessageFor(rows, idx) : row.message),
          );
        }
      } else {
        const action = HOTKEYS[e.key.toLowerCase()];
        if (action !== undefined && !e.ctrlKey && !e.metaKey && !e.altKey) {
          e.preventDefault();
          setAction(idx, action);
        }
      }
    },
    [editingIdx, moveRow, rows, setAction],
  );

  useEffect(() => {
    rowRefs.current.get(focusIdx)?.focus();
  }, [focusIdx, rows]);

  const start = useCallback(async () => {
    setStartError(undefined);
    const entries = rows.map((r) => {
      const msg = r.newMessage?.trim();
      return msg !== undefined && msg.length > 0 && (r.action === 'reword' || r.action === 'squash')
        ? { sha: r.sha, action: r.action, message: r.newMessage }
        : { sha: r.sha, action: r.action };
    });
    const res = await rpc.request<{ ok: boolean; error?: string }>(REBASE_METHODS.start, {
      entries,
      forceAcknowledged: forceAck,
    });
    if (!res.ok && res.error !== undefined) setStartError(res.error);
  }, [rows, forceAck]);

  if (!dto) {
    return <div className="gt-rb-empty">Loading…</div>;
  }

  // ---- progress / paused / done mode ---------------------------------------
  if (dto.phase !== 'edit') {
    const outcomeText =
      dto.outcome === 'completed'
        ? 'Rebase completed.'
        : dto.outcome === 'aborted'
          ? 'Rebase aborted — pre-rebase state restored.'
          : dto.outcome === 'failed'
            ? 'Rebase failed.'
            : dto.outcome === 'refused-merges'
              ? 'Refused: the range contains merge commits.'
              : undefined;
    return (
      <div className="gt-rb-root" data-testid="rebase-progress">
        <header className="gt-rb-header">
          <h1>
            Rebasing {dto.rows.length} commits onto <code>{dto.baseShort}</code>
          </h1>
          {dto.progress?.step !== undefined && dto.progress.total !== undefined && (
            <span className="gt-rb-progress" data-testid="rebase-step">
              {dto.progress.step}/{dto.progress.total}
            </span>
          )}
        </header>
        {dto.phase === 'paused' && (
          <div className="gt-rb-banner gt-rb-banner-warn" role="alert" data-testid="rebase-paused">
            Rebase paused{dto.conflicts && dto.conflicts.length > 0 ? ` — ${dto.conflicts.length} conflicted file(s)` : ''}.
            Resolve and stage the conflicts, then continue.
          </div>
        )}
        {dto.phase === 'done' && outcomeText !== undefined && (
          <div
            className={`gt-rb-banner ${dto.outcome === 'completed' ? 'gt-rb-banner-ok' : 'gt-rb-banner-warn'}`}
            role="status"
            data-testid="rebase-outcome"
          >
            {outcomeText}
          </div>
        )}
        <ol className="gt-rb-log" aria-live="polite" aria-label="Rebase log">
          {dto.log.map((line, i) => (
            <li key={i}>{line}</li>
          ))}
        </ol>
        <footer className="gt-rb-footer">
          {dto.phase === 'paused' && (
            <>
              <button onClick={() => void rpc.request(REBASE_METHODS.continue)}>Continue</button>
              <button onClick={() => void rpc.request(REBASE_METHODS.skip)}>Skip Commit</button>
              <button onClick={() => void rpc.request(REBASE_METHODS.abort)}>Abort</button>
            </>
          )}
          {dto.phase === 'done' && (
            <button onClick={() => void rpc.request(REBASE_METHODS.cancel)}>Close</button>
          )}
        </footer>
      </div>
    );
  }

  // ---- edit mode -----------------------------------------------------------
  const startDisabled = validation !== undefined || (dto.published && !forceAck);
  return (
    <div className="gt-rb-root" data-testid="rebase-edit">
      <header className="gt-rb-header">
        <h1>
          Rebasing {rows.length} commits on <strong>{dto.branch}</strong> onto{' '}
          <code>{dto.baseShort}</code>
        </h1>
      </header>
      {dto.published && (
        <div className="gt-rb-banner gt-rb-banner-warn" role="alert">
          <label>
            <input
              type="checkbox"
              checked={forceAck}
              onChange={(e) => setForceAck(e.currentTarget.checked)}
              data-testid="force-ack"
            />{' '}
            These commits are already published. I understand this rewrites shared history and will
            require a force push.
          </label>
        </div>
      )}
      <div
        ref={listRef}
        className="gt-rb-list"
        role="listbox"
        aria-label="Rebase plan"
        aria-dropeffect={drag ? 'move' : undefined}
      >
        {rows.map((row, idx) => {
          const isEditing = editingIdx === idx;
          const grouped = row.action === 'squash' || row.action === 'fixup';
          return (
            <div key={row.sha}>
              <div
                ref={(el) => {
                  if (el) rowRefs.current.set(idx, el);
                  else rowRefs.current.delete(idx);
                }}
                className={[
                  'gt-rb-row',
                  grouped ? 'gt-rb-row-grouped' : '',
                  row.action === 'drop' ? 'gt-rb-row-drop' : '',
                  drag?.over === idx ? 'gt-rb-drop-before' : '',
                  drag?.from === idx ? 'gt-rb-row-dragging' : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
                role="option"
                aria-selected={focusIdx === idx}
                aria-grabbed={drag?.from === idx}
                tabIndex={focusIdx === idx ? 0 : -1}
                data-gt-rebase-row={idx}
                data-vscode-context={JSON.stringify({
                  webviewSection: 'rebaseRow',
                  sha: row.sha,
                  preventDefaultContextMenuItems: true,
                })}
                onKeyDown={(e) => onRowKeyDown(idx, e)}
                onClick={() => setFocusIdx(idx)}
              >
                <span
                  className="gt-rb-handle"
                  aria-hidden="true"
                  data-testid={`drag-${idx}`}
                  onPointerDown={(e) => onHandlePointerDown(idx, e)}
                >
                  ⋮⋮
                </span>
                <select
                  className="gt-rb-action"
                  aria-label={`Action for ${row.shortSha}`}
                  value={row.action}
                  onChange={(e) => setAction(idx, e.currentTarget.value as RebaseActionDto)}
                  onClick={(e) => e.stopPropagation()}
                >
                  {ACTIONS.map((a) => (
                    <option key={a} value={a}>
                      {a}
                    </option>
                  ))}
                </select>
                <code className="gt-rb-sha">{row.shortSha}</code>
                <span className="gt-rb-subject" title={effectiveMessage(row)}>
                  {(row.action === 'reword' || row.action === 'squash') && row.newMessage
                    ? row.newMessage.split('\n')[0]
                    : row.subject}
                </span>
                <span className="gt-rb-meta">
                  {row.authorName} · {fmtDate(row.authorTime)}
                </span>
              </div>
              {isEditing && (
                <div className="gt-rb-editor">
                  <textarea
                    aria-label="Commit message"
                    data-testid="message-editor"
                    value={draft}
                    rows={5}
                    autoFocus
                    onChange={(e) => setDraft(e.currentTarget.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Escape') {
                        e.preventDefault();
                        setEditingIdx(null);
                      } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                        e.preventDefault();
                        commitDraft();
                      }
                    }}
                  />
                  <div className="gt-rb-editor-actions">
                    <button onClick={commitDraft} data-testid="message-ok">
                      OK
                    </button>
                    <button onClick={() => setEditingIdx(null)}>Cancel</button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
      <footer className="gt-rb-footer">
        <span className="gt-rb-summary" data-testid="summary">
          {counts.pick} picks · {counts.reword} rewords · {counts.squash} squashes ·{' '}
          {counts.fixup} fixups · {counts.drop} drops
        </span>
        {(validation ?? startError) !== undefined && (
          <span className="gt-rb-error" role="alert" data-testid="validation">
            {validation ?? startError}
          </span>
        )}
        <span className="gt-rb-spacer" />
        <button
          className="gt-rb-primary"
          disabled={startDisabled}
          onClick={() => void start()}
          data-testid="start"
        >
          Start Rebasing
        </button>
        <button onClick={() => void rpc.request(REBASE_METHODS.cancel)} data-testid="cancel">
          Cancel
        </button>
      </footer>
    </div>
  );
}
