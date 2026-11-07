/**
 * Console tab (P12-T8, gap analysis S10): the structured mirror of every git
 * run — timestamp, argv, exit code, duration, output head — over the host's
 * redacted 2000-entry ring. One collapsible row per command, failures
 * pre-expanded and coloured, a filter box, Copy command / Copy output, Clear.
 *
 * Read-only by design: re-running arbitrary logged mutations from a log pane
 * is a footgun (deviation recorded in the phase plan).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { LOG_METHODS, type LogConsoleEntryDto } from '../../../src/shared/protocol';
import type { RpcClient } from '../lib/rpc';
import { ToolbarButton } from '../lib/Toolbar';
import { ToolbarSpacer, ToolbarStrip } from '../lib/ToolbarStrip';

export interface ConsolePaneProps {
  rpc: RpcClient;
  onCopy: (text: string) => void;
}

function timeOf(ts: number): string {
  return new Date(ts).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

export function ConsolePane({ rpc, onCopy }: ConsolePaneProps) {
  const [entries, setEntries] = useState<LogConsoleEntryDto[]>([]);
  const [filter, setFilter] = useState('');
  // Seqs whose expansion the user flipped away from the default (failures
  // default open, successes closed) — XOR keeps failed rows collapsible.
  const [toggled, setToggled] = useState<ReadonlySet<number>>(() => new Set());
  const lastSeq = useRef(0);
  const listRef = useRef<HTMLDivElement | null>(null);

  const pull = useCallback(() => {
    void rpc
      .request<{ entries: LogConsoleEntryDto[] }>(LOG_METHODS.consoleEntries, {
        afterSeq: lastSeq.current,
      })
      .then((res) => {
        const fresh = res?.entries ?? [];
        if (fresh.length === 0) return;
        setEntries((prev) => {
          const merged = [...prev, ...fresh];
          // Mirror the host cap so the DOM cannot outgrow the ring.
          return merged.length > 2000 ? merged.slice(merged.length - 2000) : merged;
        });
        const last = fresh[fresh.length - 1];
        if (last) lastSeq.current = last.seq;
        requestAnimationFrame(() => {
          listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
        });
      });
  }, [rpc]);

  useEffect(() => {
    pull();
    // On change, refetch the whole (capped) ring rather than the delta: a
    // host-side clear resets seq below ours, and the full read is cheap.
    const off = rpc.onEvent(LOG_METHODS.evtConsole, () => {
      void rpc
        .request<{ entries: LogConsoleEntryDto[] }>(LOG_METHODS.consoleEntries, {})
        .then((res) => {
          const all = res?.entries ?? [];
          setEntries(all);
          lastSeq.current = all[all.length - 1]?.seq ?? 0;
        });
    });
    return off;
  }, [pull, rpc]);

  const visible = entries.filter(
    (e) =>
      filter.trim().length === 0 ||
      `${e.repo !== undefined ? `[${e.repo}] ` : ''}git ${e.argv.join(' ')} ${e.output}`
        .toLowerCase()
        .includes(filter.trim().toLowerCase()),
  );

  return (
    <div className="gt-console" data-testid="console-pane">
      <ToolbarStrip ariaLabel="Console actions">
        <input
          className="gt-input gt-console-filter"
          placeholder="Filter commands"
          aria-label="Filter commands"
          value={filter}
          onChange={(e) => setFilter(e.currentTarget.value)}
        />
        <ToolbarSpacer />
        <span className="gt-muted gt-console-count" data-testid="console-count">
          {entries.length}
        </span>
        <ToolbarButton
          icon="clear-all"
          label="Clear console"
          onClick={() => {
            void rpc.request(LOG_METHODS.consoleClear);
            setEntries([]);
            lastSeq.current = 0;
          }}
        />
      </ToolbarStrip>
      <div className="gt-console-list" ref={listRef}>
        {visible.length === 0 ? (
          <div className="gt-pane-empty gt-muted">No git commands yet.</div>
        ) : (
          visible.map((e) => {
            const failed = e.exitCode !== 0;
            const open = failed !== toggled.has(e.seq);
            return (
              <div
                key={e.seq}
                className={`gt-console-entry${failed ? ' gt-console-failed' : ''}`}
                data-testid={`console-entry-${e.seq}`}
              >
                <div className="gt-console-head">
                  <button
                    type="button"
                    className="gt-console-toggle"
                    aria-expanded={open}
                    aria-label={`Toggle output of git ${e.argv[0] ?? ''}`}
                    onClick={() =>
                      setToggled((prev) => {
                        const next = new Set(prev);
                        if (next.has(e.seq)) next.delete(e.seq);
                        else next.add(e.seq);
                        return next;
                      })
                    }
                  >
                    <span
                      className={`codicon codicon-chevron-${open ? 'down' : 'right'}`}
                      aria-hidden="true"
                    />
                  </button>
                  <span className="gt-muted gt-console-time">{timeOf(e.ts)}</span>
                  {e.repo !== undefined ? (
                    <span className="gt-muted gt-console-repo" title={`Ran in ${e.repo}`}>
                      [{e.repo}]
                    </span>
                  ) : null}
                  <code className="gt-console-cmd">git {e.argv.join(' ')}</code>
                  <span className={`gt-console-exit${failed ? ' gt-console-exit-bad' : ''}`}>
                    → {e.exitCode}
                  </span>
                  <span className="gt-muted gt-console-time">{e.durationMs}ms</span>
                  <ToolbarButton
                    icon="copy"
                    label="Copy command"
                    onClick={() => onCopy(`git ${e.argv.join(' ')}`)}
                  />
                  <ToolbarButton
                    icon="output"
                    label="Copy output"
                    disabled={e.output.length === 0}
                    onClick={() => onCopy(e.output)}
                  />
                </div>
                {open && e.output.length > 0 ? (
                  <pre className="gt-console-output">{e.output}</pre>
                ) : null}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
