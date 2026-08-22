/**
 * Commit Details pane (P12-T1 shell; rewritten fully by P12-T4): metadata,
 * refs and the message body. The changed-file list moved to its own pane —
 * the §2A layout stacks the two in the right column.
 */
import type { CommitDetailsDto } from '../../../src/shared/protocol';
import { ToolbarButton } from '../lib/Toolbar';

export interface DetailsPanelProps {
  details: CommitDetailsDto | undefined;
  loading: boolean;
  onCopySha: (sha: string) => void;
}

export function DetailsPanel({ details, loading, onCopySha }: DetailsPanelProps) {
  if (loading) {
    return <div className="gt-pane-empty gt-muted">Loading…</div>;
  }
  if (!details) {
    return <div className="gt-pane-empty gt-muted">Select a commit to see details.</div>;
  }

  const date = new Date(details.authorTime * 1000);
  return (
    <div className="gt-log-details" data-testid="details-panel">
      <div className="gt-details-header">
        <span className="gt-details-sha" title={details.sha}>
          {details.sha.slice(0, 12)}
        </span>
        <ToolbarButton icon="copy" label="Copy full revision number" onClick={() => onCopySha(details.sha)} />
      </div>
      <div className="gt-details-meta">
        <div>
          <strong>{details.authorName}</strong> &lt;{details.authorEmail}&gt; · {date.toLocaleString()}
        </div>
        {details.committerName !== details.authorName ? (
          <div className="gt-muted">
            committed by {details.committerName} · {new Date(details.committerTime * 1000).toLocaleString()}
          </div>
        ) : null}
        {details.refs.length > 0 ? (
          <div className="gt-details-refs">
            {details.refs.map((r) => (
              <span key={r} className="gt-ref-chip gt-ref-branch">
                {r}
              </span>
            ))}
          </div>
        ) : null}
      </div>
      <pre className="gt-details-body">{details.body}</pre>
    </div>
  );
}
