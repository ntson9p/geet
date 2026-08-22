/**
 * Commit Details pane (P12-T4) — the §2A layout: subject → `<hash> <author>`
 * → `<email> on <date> at <time>` → ref chips; plus what the old panel
 * lacked: the committer line when it differs, the GPG signature state,
 * clickable parent links (feeding Go to Parent Commit), and a lazy
 * `Contained in branches … Show all` that never runs `--contains` on
 * selection. The body linkifies URLs and configured issue keys, and stays
 * selectable text.
 */
import { useEffect, useMemo, useState } from 'react';
import type { CommitDetailsDto } from '../../../src/shared/protocol';
import { ToolbarButton } from '../lib/Toolbar';
import { linkifyBody, signatureLabel } from './linkify';

export interface DetailsPanelProps {
  details: CommitDetailsDto | undefined;
  loading: boolean;
  issue?: { pattern: string; url: string };
  onCopy: (text: string) => void;
  onGoTo: (sha: string) => void;
  fetchContained: (sha: string) => Promise<string[]>;
}

function chipType(ref: string): 'tag' | 'head' | 'branch' {
  if (ref.startsWith('tag: ')) return 'tag';
  if (ref === 'HEAD' || ref.startsWith('HEAD ->')) return 'head';
  return 'branch';
}

export function DetailsPanel({ details, loading, issue, onCopy, onGoTo, fetchContained }: DetailsPanelProps) {
  const [contained, setContained] = useState<string[] | undefined>(undefined);
  const [containedLoading, setContainedLoading] = useState(false);

  // A new commit invalidates the lazily fetched list.
  useEffect(() => {
    setContained(undefined);
    setContainedLoading(false);
  }, [details?.sha]);

  const segments = useMemo(
    () => (details ? linkifyBody(details.body, issue) : []),
    [details, issue],
  );

  if (loading) {
    return <div className="gt-pane-empty gt-muted">Loading…</div>;
  }
  if (!details) {
    return <div className="gt-pane-empty gt-muted">Select a commit to see details.</div>;
  }

  const subject = details.body.split('\n', 1)[0] ?? '';
  const date = new Date(details.authorTime * 1000);
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
        <ToolbarButton icon="copy" label="Copy Revision Number" onClick={() => onCopy(details.sha)} />
        <ToolbarButton icon="note" label="Copy Subject" onClick={() => onCopy(subject)} />
      </div>
      <div className="gt-details-meta">
        <div className="gt-muted">
          {details.authorEmail} on {date.toLocaleDateString()} at{' '}
          {date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        </div>
        {details.committerName !== details.authorName ? (
          <div className="gt-muted" data-testid="details-committer">
            committed by {details.committerName} ·{' '}
            {new Date(details.committerTime * 1000).toLocaleString()}
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
        {details.parents.length > 0 ? (
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
