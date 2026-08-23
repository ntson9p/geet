/**
 * Unstash dialog (P13-T4): the stash list, `[x] Pop stash`, `[ ] Reinstate
 * index`, the target-changelist selector, and an `InlineDiff` preview of the
 * selected file inside the stash — so the user can see what is about to land
 * before it lands.
 */
import { useEffect, useMemo, useState } from 'react';
import {
  UNSTASH_DIALOG_METHODS,
  type RollbackFileDiffDto,
  type UnstashDialogParamsDto,
  type UnstashDialogResultDto,
  type UnstashFileDto,
} from '../../../src/shared/protocol';
import { formatGitCommand } from '../../../src/scm/dialogs/commandLine';
import { buildStashApplyArgs } from '../../../src/scm/dialogs/stashArgs';
import { Dialog } from '../lib/Dialog';
import { InlineDiff } from '../lib/InlineDiff';
import { kindOf, statusColor } from '../lib/status';
import { useDialog } from '../lib/useDialog';
import { useElementSize } from '../lib/useElementSize';
import { WillRun } from './ModifyOptions';

function shortDate(unixSeconds: number | undefined): string {
  if (unixSeconds === undefined || !Number.isFinite(unixSeconds) || unixSeconds <= 0) return '';
  return new Date(unixSeconds * 1000).toLocaleDateString();
}

export function Unstash() {
  const { init, error, accept, cancel, help, rpc } = useDialog<
    UnstashDialogParamsDto,
    UnstashDialogResultDto
  >();
  const [params, setParams] = useState<UnstashDialogParamsDto | undefined>(undefined);
  const [index, setIndex] = useState(0);
  const [pop, setPop] = useState(true);
  const [reinstateIndex, setReinstateIndex] = useState(false);
  const [changelistId, setChangelistId] = useState('');
  const [files, setFiles] = useState<UnstashFileDto[]>([]);
  const [selected, setSelected] = useState<string | undefined>(undefined);
  const [diff, setDiff] = useState<RollbackFileDiffDto | undefined>(undefined);
  const [diffRef, diffSize] = useElementSize<HTMLDivElement>();

  useEffect(() => {
    if (!init) return;
    setParams(init.params);
    setIndex(init.params.entries[0]?.index ?? 0);
    setChangelistId(init.params.activeChangelistId);
  }, [init]);

  useEffect(() => {
    if (!params) return;
    let cancelled = false;
    setSelected(undefined);
    rpc.request<UnstashFileDto[]>(UNSTASH_DIALOG_METHODS.files, { index }).then(
      (next) => {
        if (!cancelled) setFiles(next);
      },
      () => {
        if (!cancelled) setFiles([]);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [index, params, rpc]);

  useEffect(() => {
    if (selected === undefined) {
      setDiff(undefined);
      return;
    }
    let cancelled = false;
    rpc
      .request<RollbackFileDiffDto>(UNSTASH_DIALOG_METHODS.fileDiff, { index, relPath: selected })
      .then(
        (next) => {
          if (!cancelled) setDiff(next);
        },
        () => {
          if (!cancelled) setDiff(undefined);
        },
      );
    return () => {
      cancelled = true;
    };
  }, [index, rpc, selected]);

  const argv = useMemo(
    () => buildStashApplyArgs({ index, pop, reinstateIndex }),
    [index, pop, reinstateIndex],
  );

  if (error !== undefined) return <div className="gt-dialog-unknown">{error}</div>;
  if (!params) return <div className="gt-dialog-unknown">Loading…</div>;

  return (
    <Dialog
      title={`Unstash Changes — ${params.repoLabel}`}
      onCancel={cancel}
      onHelp={help}
      onAction={(id) => {
        if (id === 'cancel') cancel();
        else if (id === 'unstash') accept({ index, pop, reinstateIndex, changelistId });
      }}
      buttons={[
        { id: 'unstash', label: pop ? 'Pop' : 'Apply', variant: 'default' },
        { id: 'cancel', label: 'Cancel', variant: 'secondary' },
      ]}
      footerLeft={
        <>
          <label className="gt-checkbox">
            <input
              type="checkbox"
              data-testid="unstash-pop"
              checked={pop}
              onChange={(e) => setPop(e.currentTarget.checked)}
            />
            <span className="gt-checkbox-body">Pop stash</span>
          </label>
          <label className="gt-checkbox">
            <input
              type="checkbox"
              data-testid="unstash-reinstate"
              checked={reinstateIndex}
              onChange={(e) => setReinstateIndex(e.currentTarget.checked)}
            />
            <span className="gt-checkbox-body">Reinstate index</span>
          </label>
        </>
      }
      className="gt-op-dialog"
    >
      <div className="gt-op-row">
        <label htmlFor="unstash-entry">Stash:</label>
        <select
          id="unstash-entry"
          className="gt-input gt-ref-select"
          data-testid="unstash-entry"
          value={String(index)}
          onChange={(e) => setIndex(Number(e.currentTarget.value) || 0)}
        >
          {params.entries.map((s) => (
            <option key={s.index} value={String(s.index)}>
              {`stash@{${s.index}} — ${s.message}${s.date !== undefined ? ` · ${shortDate(s.date)}` : ''}`}
            </option>
          ))}
        </select>
      </div>

      {params.changelists.length > 0 ? (
        <div className="gt-op-row">
          <label htmlFor="unstash-changelist">Into changelist:</label>
          <select
            id="unstash-changelist"
            className="gt-input gt-ref-select"
            data-testid="unstash-changelist"
            value={changelistId}
            onChange={(e) => setChangelistId(e.currentTarget.value)}
          >
            {params.changelists.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
        </div>
      ) : null}

      <div className="gt-unstash-files" data-testid="unstash-files">
        {files.length === 0 ? (
          <div className="gt-muted gt-unstash-empty">No files in this stash.</div>
        ) : (
          <ul>
            {files.map((f) => (
              <li key={f.path}>
                <button
                  type="button"
                  className={`gt-unstash-file${selected === f.path ? ' gt-active' : ''}`}
                  onClick={() => setSelected(f.path)}
                >
                  <span style={{ color: statusColor(kindOf(f.status)) }}>{f.status}</span>{' '}
                  {f.path}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="gt-unstash-diff" ref={diffRef} data-testid="unstash-diff">
        {selected === undefined ? (
          <div className="gt-muted gt-unstash-empty">Select a file to preview it.</div>
        ) : !diff ? (
          <div className="gt-muted gt-unstash-empty">Loading changes…</div>
        ) : diff.wholeFileOnly ? (
          <div className="gt-muted gt-unstash-empty" data-testid="unstash-whole-file">
            {selected} has no line diff to show.
          </div>
        ) : (
          <InlineDiff
            originalText={diff.originalText}
            modifiedText={diff.modifiedText}
            changes={diff.changes}
            leftLabel="stash base"
            rightLabel={selected}
            height={Math.max(0, diffSize.height)}
          />
        )}
      </div>

      <WillRun show={params.showCommandLine} text={formatGitCommand(argv)} />
    </Dialog>
  );
}
