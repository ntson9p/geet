/**
 * Commit details panel (P4-T3 step 5): metadata, refs, body, changed-file
 * tree with folder rollup toggle; file click opens the diff host-side.
 */
import { useMemo, useState } from 'react';
import type { CommitDetailsDto, CommitFileDto } from '../../../src/shared/protocol';
import { ToolbarButton } from '../lib/Toolbar';

export interface DetailsPanelProps {
  details: CommitDetailsDto | undefined;
  loading: boolean;
  onOpenFile: (file: CommitFileDto) => void;
  onOpenAll: () => void;
  onCopySha: (sha: string) => void;
}

function statusIcon(status: string): string {
  switch (status.charAt(0)) {
    case 'A':
      return 'diff-added';
    case 'D':
      return 'diff-removed';
    case 'R':
      return 'diff-renamed';
    case 'C':
      return 'diff-added';
    default:
      return 'diff-modified';
  }
}

interface FolderGroup {
  dir: string;
  files: CommitFileDto[];
}

function groupByFolder(files: readonly CommitFileDto[]): FolderGroup[] {
  const map = new Map<string, CommitFileDto[]>();
  for (const f of files) {
    const dir = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : '.';
    const list = map.get(dir) ?? [];
    list.push(f);
    map.set(dir, list);
  }
  return [...map.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([dir, groupFiles]) => ({ dir, files: groupFiles }));
}

export function DetailsPanel({ details, loading, onOpenFile, onOpenAll, onCopySha }: DetailsPanelProps) {
  const [rollup, setRollup] = useState(true);
  const groups = useMemo(() => (details ? groupByFolder(details.files) : []), [details]);

  if (loading) {
    return <div className="gt-log-details gt-muted">Loading…</div>;
  }
  if (!details) {
    return <div className="gt-log-details gt-muted">Select a commit to see details.</div>;
  }

  const date = new Date(details.authorTime * 1000);
  return (
    <div className="gt-log-details" data-testid="details-panel">
      <div className="gt-details-header">
        <span className="gt-details-sha" title={details.sha}>
          {details.sha.slice(0, 12)}
        </span>
        <ToolbarButton icon="copy" label="Copy full revision number" onClick={() => onCopySha(details.sha)} />
        <ToolbarButton icon="diff-multiple" label="Show all files in multi-diff" onClick={onOpenAll} />
        <ToolbarButton
          icon={rollup ? 'list-tree' : 'list-flat'}
          label={rollup ? 'Flat file list' : 'Group by folder'}
          onClick={() => setRollup(!rollup)}
        />
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
      <div className="gt-details-files" role="list" aria-label="Changed files">
        {rollup
          ? groups.map((g) => (
              <div key={g.dir}>
                <div className="gt-details-folder gt-muted">{g.dir}</div>
                {g.files.map((f) => (
                  <FileRow key={f.path} file={f} indent onOpen={onOpenFile} />
                ))}
              </div>
            ))
          : details.files.map((f) => <FileRow key={f.path} file={f} onOpen={onOpenFile} />)}
      </div>
    </div>
  );
}

function FileRow({ file, indent, onOpen }: { file: CommitFileDto; indent?: boolean; onOpen: (f: CommitFileDto) => void }) {
  return (
    <button
      type="button"
      role="listitem"
      className={`gt-details-file${indent ? ' gt-indent' : ''}`}
      onClick={() => onOpen(file)}
      title={file.origPath !== undefined ? `${file.origPath} → ${file.path}` : file.path}
    >
      <span className={`codicon codicon-${statusIcon(file.status)}`} aria-hidden="true" />
      <span className="gt-details-filename">{file.path}</span>
      {file.origPath !== undefined ? <span className="gt-muted"> ← {file.origPath}</span> : null}
    </button>
  );
}
