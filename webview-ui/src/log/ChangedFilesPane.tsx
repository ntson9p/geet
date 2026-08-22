/**
 * Changed Files pane (P12-T1 shell; upgraded by P12-T3). Shows the selected
 * commit's files — flat or grouped by folder — with the multi-diff and
 * grouping toggles that used to crowd the details panel.
 */
import { useMemo } from 'react';
import type { CommitDetailsDto, CommitFileDto } from '../../../src/shared/protocol';
import { statusColor, statusIcon, type StatusKind } from '../lib/status';

export interface ChangedFilesPaneProps {
  details: CommitDetailsDto | undefined;
  loading: boolean;
  onOpenFile: (file: CommitFileDto) => void;
  /** The pane toolbar lives in the pane header; grouping state is lifted. */
  rollup: boolean;
}

function kindOf(status: string): StatusKind {
  switch (status.charAt(0)) {
    case 'A':
      return 'added';
    case 'D':
      return 'deleted';
    case 'R':
    case 'C':
      return 'renamed';
    default:
      return 'modified';
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

export function ChangedFilesPane({ details, loading, onOpenFile, rollup }: ChangedFilesPaneProps) {
  const groups = useMemo(() => (details ? groupByFolder(details.files) : []), [details]);

  if (loading) return <div className="gt-pane-empty gt-muted">Loading…</div>;
  if (!details) return <div className="gt-pane-empty gt-muted">Select a commit to see its files.</div>;

  return (
    <div className="gt-details-files" role="list" aria-label="Changed files" data-testid="changed-files">
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
  );
}

function FileRow({
  file,
  indent,
  onOpen,
}: {
  file: CommitFileDto;
  indent?: boolean;
  onOpen: (f: CommitFileDto) => void;
}) {
  const kind = kindOf(file.status);
  return (
    <button
      type="button"
      role="listitem"
      className={`gt-details-file${indent === true ? ' gt-indent' : ''}`}
      onClick={() => onOpen(file)}
      title={file.origPath !== undefined ? `${file.origPath} → ${file.path}` : file.path}
    >
      <span
        className={`codicon codicon-${statusIcon(kind)}`}
        style={{ color: statusColor(kind) }}
        aria-hidden="true"
      />
      <span className="gt-details-filename">{file.path}</span>
      {file.origPath !== undefined ? <span className="gt-muted"> ← {file.origPath}</span> : null}
    </button>
  );
}

/** `1 file` / `12 files` for the pane header. */
export function changedFilesLabel(details: CommitDetailsDto | undefined): string {
  const n = details?.files.length ?? 0;
  return `${n} ${n === 1 ? 'file' : 'files'}`;
}
