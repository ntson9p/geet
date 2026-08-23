/**
 * Manage Remotes dialog (P13-T4) — absent entirely before this: there was no
 * remote-management command in GitTree at all. A table of name / fetch URL /
 * push URL with add, edit, remove and `git remote prune`.
 *
 * Operations apply immediately over RPC rather than batching into an OK, which
 * is how IntelliJ's remotes dialog behaves and what makes add→fetch→remove a
 * round-trip the user can watch.
 */
import { useEffect, useState } from 'react';
import {
  REMOTES_DIALOG_METHODS,
  type RemotesDialogParamsDto,
  type RemoteRowDto,
  type RemotesOpResultDto,
} from '../../../src/shared/protocol';
import { validateRemoteEdit } from '../../../src/scm/dialogs/remoteArgs';
import { Dialog } from '../lib/Dialog';
import { useDialog } from '../lib/useDialog';
import { ToolbarButton } from '../lib/Toolbar';
import { ToolbarSeparator, ToolbarStrip } from '../lib/ToolbarStrip';

interface Draft {
  /** The row being edited, or undefined when adding a new remote. */
  readonly before?: RemoteRowDto;
  name: string;
  fetchUrl: string;
  pushUrl: string;
}

export function Remotes() {
  const { init, error, cancel, help, rpc } = useDialog<RemotesDialogParamsDto, unknown>();
  const [params, setParams] = useState<RemotesDialogParamsDto | undefined>(undefined);
  const [rows, setRows] = useState<RemoteRowDto[]>([]);
  const [selected, setSelected] = useState<string | undefined>(undefined);
  const [draft, setDraft] = useState<Draft | undefined>(undefined);
  const [message, setMessage] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!init) return;
    setParams(init.params);
    setRows(init.params.remotes);
    setSelected(init.params.remotes[0]?.name);
  }, [init]);

  const run = (method: string, payload: unknown): void => {
    setBusy(true);
    setMessage(undefined);
    rpc
      .request<RemotesOpResultDto>(method, payload)
      .then(
        (res) => {
          setRows(res.remotes);
          if (res.message !== undefined) setMessage(res.message);
          if (res.ok) setDraft(undefined);
        },
        (e: Error) => setMessage(e.message),
      )
      .finally(() => setBusy(false));
  };

  if (error !== undefined) return <div className="gt-dialog-unknown">{error}</div>;
  if (!params) return <div className="gt-dialog-unknown">Loading…</div>;

  const draftErrors =
    draft === undefined
      ? []
      : validateRemoteEdit(
          { name: draft.name, fetchUrl: draft.fetchUrl, pushUrl: draft.pushUrl },
          rows.map((r) => r.name),
          draft.before?.name,
        );

  return (
    <Dialog
      title={`Manage Remotes — ${params.repoLabel}`}
      onCancel={cancel}
      onHelp={help}
      onAction={(id) => {
        if (id === 'close') cancel();
      }}
      buttons={[{ id: 'close', label: 'Close', variant: 'default' }]}
      className="gt-op-dialog gt-remotes-dialog"
    >
      <ToolbarStrip ariaLabel="Remotes toolbar">
        <ToolbarButton
          icon="add"
          label="Add remote"
          disabled={busy}
          onClick={() => setDraft({ name: '', fetchUrl: '', pushUrl: '' })}
        />
        <ToolbarButton
          icon="edit"
          label="Edit remote"
          disabled={busy || selected === undefined}
          onClick={() => {
            const row = rows.find((r) => r.name === selected);
            if (row) setDraft({ before: row, ...row });
          }}
        />
        <ToolbarButton
          icon="trash"
          label="Remove remote"
          disabled={busy || selected === undefined}
          onClick={() => run(REMOTES_DIALOG_METHODS.remove, { name: selected })}
        />
        <ToolbarSeparator />
        <ToolbarButton
          icon="clear-all"
          label="Prune remote"
          disabled={busy || selected === undefined}
          onClick={() => run(REMOTES_DIALOG_METHODS.prune, { name: selected })}
        />
      </ToolbarStrip>

      <table className="gt-remotes-table" data-testid="remotes-table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Fetch URL</th>
            <th>Push URL</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={3} className="gt-muted" data-testid="remotes-empty">
                No remotes configured.
              </td>
            </tr>
          ) : (
            rows.map((r) => (
              <tr
                key={r.name}
                className={selected === r.name ? 'gt-active' : undefined}
                data-testid={`remote-row-${r.name}`}
                onClick={() => setSelected(r.name)}
              >
                <td>{r.name}</td>
                <td>{r.fetchUrl}</td>
                <td className={r.pushUrl.length === 0 ? 'gt-muted' : undefined}>
                  {r.pushUrl.length === 0 ? 'same as fetch' : r.pushUrl}
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>

      {draft !== undefined ? (
        <div className="gt-remotes-form" data-testid="remotes-form">
          <div className="gt-op-row">
            <label htmlFor="remote-name">Name:</label>
            <input
              id="remote-name"
              className="gt-input gt-ref-expression"
              data-testid="remote-name"
              value={draft.name}
              onChange={(e) => {
                const next = e.currentTarget.value;
                setDraft((d) => (d ? { ...d, name: next } : d));
              }}
            />
          </div>
          <div className="gt-op-row">
            <label htmlFor="remote-fetch">Fetch URL:</label>
            <input
              id="remote-fetch"
              className="gt-input gt-ref-expression"
              data-testid="remote-fetch"
              value={draft.fetchUrl}
              onChange={(e) => {
                const next = e.currentTarget.value;
                setDraft((d) => (d ? { ...d, fetchUrl: next } : d));
              }}
            />
          </div>
          <div className="gt-op-row">
            <label htmlFor="remote-push">Push URL:</label>
            <input
              id="remote-push"
              className="gt-input gt-ref-expression"
              data-testid="remote-push"
              placeholder="leave empty to use the fetch URL"
              value={draft.pushUrl}
              onChange={(e) => {
                const next = e.currentTarget.value;
                setDraft((d) => (d ? { ...d, pushUrl: next } : d));
              }}
            />
          </div>
          {draftErrors.length > 0 ? (
            <ul className="gt-modify-options-errors" data-testid="remote-errors">
              {draftErrors.map((m) => (
                <li key={m}>{m}</li>
              ))}
            </ul>
          ) : null}
          <div className="gt-op-row">
            <button
              type="button"
              className="gt-button gt-primary"
              data-testid="remote-save"
              disabled={busy || draftErrors.length > 0}
              onClick={() =>
                run(REMOTES_DIALOG_METHODS.save, {
                  ...(draft.before !== undefined ? { before: draft.before } : {}),
                  after: { name: draft.name, fetchUrl: draft.fetchUrl, pushUrl: draft.pushUrl },
                })
              }
            >
              Save
            </button>
            <button type="button" className="gt-button" onClick={() => setDraft(undefined)}>
              Cancel
            </button>
          </div>
        </div>
      ) : null}

      {message !== undefined ? (
        <div className="gt-modify-options-errors" data-testid="remotes-message">
          {message}
        </div>
      ) : null}
    </Dialog>
  );
}
