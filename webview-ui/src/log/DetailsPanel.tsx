/**
 * Commit Details pane (P12-T4) — the §2A layout: subject → `<hash> <author>`
 * → `<email> on <date> at <time>` → ref chips; plus what the old panel
 * lacked: the committer line when it differs, the GPG signature state,
 * clickable parent links (feeding Go to Parent Commit), and a lazy
 * `Contained in branches … Show all` that never runs `--contains` on
 * selection. The body linkifies URLs and configured issue keys, and stays
 * selectable text.
 *
 * Several selected commits stack, as IntelliJ's `CommitDetailsListPanel` does:
 * one block per commit in graph order, a rule between them, at most the first
 * 50, and `(showing 50 of N selected commits)` below when there were more.
 *
 * The Push dialog shows the same block for its selected commit, without what
 * only the log can act on: copying, parents to go to, the branches holding it.
 */
import { useEffect, useMemo, useState } from 'react';
import type { CommitDetailsDto, LogDateFormat } from '../../../src/shared/protocol';
import { createDetailsDate, createLogDateFormat } from './dateFormat';
import { ToolbarButton } from '../lib/Toolbar';
import { linkifyBody, signatureLabel } from './linkify';

export interface DetailsPanelProps {
  /** The selected commits' details, in graph order (the first 50 at most). */
  details: readonly CommitDetailsDto[];
  /** How many commits are selected, which may be more than `details` holds. */
  selectedCount: number;
  loading: boolean;
  issue?: { pattern: string; url: string };
  /** Omitted: no copy buttons. */
  onCopy?: (text: string) => void;
  /** Omitted: no parent links. */
  onGoTo?: (sha: string) => void;
  /** Omitted: no `Contained in branches`. */
  fetchContained?: (sha: string) => Promise<string[]>;
  /** The Date column's format, so the two agree; the Push dialog's own is `locale`. */
  dateFormat?: LogDateFormat;
}

function chipType(ref: string): 'tag' | 'head' | 'branch' {
  if (ref.startsWith('tag: ')) return 'tag';
  if (ref === 'HEAD' || ref.startsWith('HEAD ->')) return 'head';
  return 'branch';
}

export function DetailsPanel({
  details,
  selectedCount,
  loading,
  issue,
  onCopy,
  onGoTo,
  fetchContained,
  dateFormat = 'locale',
}: DetailsPanelProps) {
  if (loading && details.length === 0) {
    return <div className="gt-pane-empty gt-muted">Loading…</div>;
  }
  if (details.length === 0) {
    return <div className="gt-pane-empty gt-muted">Select a commit to see details.</div>;
  }
  if (details.length === 1) {
    return (
      <CommitDetailsBlock
        details={details[0]!}
        issue={issue}
        onCopy={onCopy}
        onGoTo={onGoTo}
        fetchContained={fetchContained}
        dateFormat={dateFormat}
      />
    );
  }
  return (
    <div className="gt-log-details-list" data-testid="details-list">
      {details.map((d, i) => (
        <div key={d.sha}>
          {i > 0 ? <hr className="gt-details-rule" /> : null}
          <CommitDetailsBlock
            details={d}
            issue={issue}
            onCopy={onCopy}
            onGoTo={onGoTo}
            fetchContained={fetchContained}
            dateFormat={dateFormat}
          />
        </div>
      ))}
      {selectedCount > details.length ? (
        <>
          <hr className="gt-details-rule" />
          <div className="gt-details-overflow gt-muted" data-testid="details-overflow">
            (showing {details.length} of {selectedCount} selected commits)
          </div>
        </>
      ) : null}
    </div>
  );
}

interface CommitDetailsBlockProps {
  details: CommitDetailsDto;
  issue?: { pattern: string; url: string } | undefined;
  onCopy?: ((text: string) => void) | undefined;
  onGoTo?: ((sha: string) => void) | undefined;
  fetchContained?: ((sha: string) => Promise<string[]>) | undefined;
  dateFormat: LogDateFormat;
}

/** One commit's details. */
function CommitDetailsBlock({
  details,
  issue,
  onCopy,
  onGoTo,
  fetchContained,
  dateFormat,
}: CommitDetailsBlockProps) {
  const [contained, setContained] = useState<string[] | undefined>(undefined);
  const [containedLoading, setContainedLoading] = useState(false);

  // A new commit invalidates the lazily fetched list.
  useEffect(() => {
    setContained(undefined);
    setContainedLoading(false);
  }, [details.sha]);

  const segments = useMemo(() => linkifyBody(details.body, issue), [details, issue]);

  const subject = details.body.split('\n', 1)[0] ?? '';
  const authored = useMemo(() => createDetailsDate(dateFormat)(details.authorTime), [dateFormat, details.authorTime]);
  const committedAt = useMemo(
    () => createLogDateFormat(dateFormat)(details.committerTime),
    [dateFormat, details.committerTime],
  );
  const signature = signatureLabel(details.signature);

  return (
    <div className="gt-log-details" data-testid="details-panel">
      <div className="gt-details-subject" data-testid="details-subject">
        {subject}
      </div>
      <div className="gt-details-header">
        <span className="gt-details-sha" title={details.sha}>
          {details.sha.slice(0, 12)}
        </span>
        <span className="gt-details-author">{details.authorName}</span>
        {onCopy !== undefined ? (
          <>
            <ToolbarButton icon="copy" label="Copy Revision Number" onClick={() => onCopy(details.sha)} />
            <ToolbarButton icon="note" label="Copy Subject" onClick={() => onCopy(subject)} />
          </>
        ) : null}
      </div>
      <div className="gt-details-meta">
        <div className="gt-muted">
          {details.authorEmail} on {authored.date} at {authored.time}
        </div>
        {details.committerName !== details.authorName ? (
          <div className="gt-muted" data-testid="details-committer">
            committed by {details.committerName} · {committedAt}
          </div>
        ) : null}
        {signature !== undefined ? (
          <div
            className={`gt-details-signature${details.signature === 'B' ? ' gt-signature-bad' : ''}`}
            data-testid="details-signature"
          >
            <span
              className={`codicon codicon-${details.signature === 'G' ? 'verified' : 'unverified'}`}
              aria-hidden="true"
            />{' '}
            {signature}
          </div>
        ) : null}
        {details.refs.length > 0 ? (
          <div className="gt-details-refs">
            {details.refs.map((r) => (
              <span key={r} className={`gt-ref-chip gt-ref-${chipType(r)}`}>
                {r}
              </span>
            ))}
          </div>
        ) : null}
        {onGoTo !== undefined && details.parents.length > 0 ? (
          <div className="gt-details-parents">
            {details.parents.map((p) => (
              <button
                key={p}
                type="button"
                className="gt-details-parent"
                data-testid={`details-parent-${p.slice(0, 7)}`}
                title={`Go to parent ${p}`}
                onClick={() => onGoTo(p)}
              >
                parent {p.slice(0, 7)}
              </button>
            ))}
          </div>
        ) : null}
        {fetchContained === undefined ? null : (
        <div className="gt-details-contained">
          {contained === undefined ? (
            <button
              type="button"
              className="gt-details-contained-link"
              data-testid="details-contained-link"
              disabled={containedLoading}
              onClick={() => {
                setContainedLoading(true);
                fetchContained(details.sha).then(
                  (branches) => {
                    setContained(branches);
                    setContainedLoading(false);
                  },
                  () => setContainedLoading(false),
                );
              }}
            >
              {containedLoading ? 'Loading…' : 'Contained in branches: Show all'}
            </button>
          ) : (
            <div className="gt-details-refs" data-testid="details-contained">
              <span className="gt-muted">Contained in: </span>
              {contained.length === 0 ? (
                <span className="gt-muted">no branches</span>
              ) : (
                contained.map((b) => (
                  <span key={b} className="gt-ref-chip gt-ref-branch">
                    {b}
                  </span>
                ))
              )}
            </div>
          )}
        </div>
        )}
      </div>
      <pre className="gt-details-body" data-testid="details-body">
        {segments.map((s, i) =>
          s.href !== undefined ? (
            <a key={i} href={s.href}>
              {s.text}
            </a>
          ) : (
            <span key={i}>{s.text}</span>
          ),
        )}
      </pre>
    </div>
  );
}
