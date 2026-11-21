/**
 * `Files Merged with Conflicts` dialog (P13-T8 · S7): the gate IntelliJ shows
 * the moment a merge conflicts — the file list with `Accept Yours`,
 * `Accept Theirs`, `Resolve Simple` and `Merge…`.
 *
 * The `geet.conflicts` tree view remains the persistent surface; this is the
 * modal moment, not a replacement for it.
 */
import { useEffect, useMemo, useState } from 'react';
import type {
  ConflictsDialogParamsDto,
  ConflictsDialogResultDto,
} from '../../../src/shared/protocol';
import { Dialog } from '../lib/Dialog';
import { statusColor } from '../lib/status';
import { useDialog } from '../lib/useDialog';

/** Conflict kinds a line-level merge can actually open. */
const KIND_LABEL: Record<string, string> = {
  'both-modified': 'modified on both sides',
  'added-by-both': 'added on both sides',
  'deleted-by-us': 'deleted by you',
  'deleted-by-them': 'deleted by them',
  'added-by-us': 'added by you',
  'added-by-them': 'added by them',
};

export function FilesMergedWithConflicts() {
  const { init, error, accept, cancel, help } = useDialog<
    ConflictsDialogParamsDto,
    ConflictsDialogResultDto
  >();
  const [params, setParams] = useState<ConflictsDialogParamsDto | undefined>(undefined);
  const [checked, setChecked] = useState<ReadonlySet<string>>(() => new Set());

  useEffect(() => {
    if (!init) return;
    setParams(init.params);
    setChecked(new Set(init.params.files.map((f) => f.path)));
  }, [init]);

  const files = useMemo(() => params?.files ?? [], [params]);
  const chosen = useMemo(() => files.filter((f) => checked.has(f.path)), [checked, files]);
  const mergeable = chosen.filter((f) => f.mergeable);

  if (error !== undefined) return <div className="gt-dialog-unknown">{error}</div>;
  if (!params) return <div className="gt-dialog-unknown">Loading…</div>;

  const paths = chosen.map((f) => f.path);

  return (
    <Dialog
      title={`Files Merged with Conflicts — ${params.repoLabel}`}
      onCancel={cancel}
      onHelp={help}
      onAction={(id) => {
        if (id === 'close') {
          cancel();
          return;
        }
        if (id === 'merge') {
          const first = mergeable[0];
          if (first) accept({ action: 'merge', paths: [first.path] });
          return;
        }
        if (id === 'yours' || id === 'theirs') {
          accept({ action: id === 'yours' ? 'acceptYours' : 'acceptTheirs', paths });
          return;
        }
        if (id === 'simple') accept({ action: 'resolveSimple', paths });
      }}
      buttons={[
        {
          id: 'merge',
          label: 'Merge…',
          variant: 'default',
          disabled: mergeable.length === 0,
        },
        { id: 'yours', label: 'Accept Yours', variant: 'secondary', disabled: paths.length === 0 },
        { id: 'theirs', label: 'Accept Theirs', variant: 'secondary', disabled: paths.length === 0 },
        { id: 'close', label: 'Close', variant: 'secondary' },
      ]}
      footerLeft={
        <button
          type="button"
          className="gt-button"
          data-testid="conflicts-simple"
          onClick={() => accept({ action: 'resolveSimple', paths })}
        >
          Resolve Simple Conflicts
        </button>
      }
      className="gt-op-dialog"
    >
      <div className="gt-muted" data-testid="conflicts-summary">
        {params.operation} produced {files.length} conflicted file
        {files.length === 1 ? '' : 's'} · {chosen.length} selected
      </div>

      <ul className="gt-conflicts-list" data-testid="conflicts-list">
        {files.map((f) => (
          <li key={f.path}>
            <label className="gt-checkbox">
              <input
                type="checkbox"
                aria-label={f.path}
                data-testid={`conflict-${f.path}`}
                checked={checked.has(f.path)}
                onChange={(e) => {
                  const on = e.currentTarget.checked;
                  setChecked((prev) => {
                    const next = new Set(prev);
                    if (on) next.add(f.path);
                    else next.delete(f.path);
                    return next;
                  });
                }}
              />
              <span className="gt-checkbox-body">
                <span style={{ color: statusColor('conflicted', params.colors) }}>{f.path}</span>
                <span className="gt-muted"> · {KIND_LABEL[f.kind] ?? f.kind}</span>
                {f.mergeable ? null : (
                  <span className="gt-muted"> · no line merge</span>
                )}
              </span>
            </label>
          </li>
        ))}
      </ul>
    </Dialog>
  );
}
