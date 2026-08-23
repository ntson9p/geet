/**
 * Update Project dialog (P13-T2) — the §2A layout: the merge/rebase radio pair,
 * `[ ] Do not show again`, and the footer
 * `[Reset to the Remote Branch] [OK] [Cancel]`.
 *
 * `Do not show again` is only meaningful for the OK path — it remembers *which
 * strategy* to run next time, so it is disabled while `Reset to the Remote
 * Branch` is the action in question rather than silently recording a choice
 * the user never made.
 */
import { useEffect, useState } from 'react';
import type {
  UpdateDialogParamsDto,
  UpdateDialogResultDto,
} from '../../../src/shared/protocol';
import { formatGitCommands } from '../../../src/scm/dialogs/commandLine';
import { buildUpdatePlan } from '../../../src/scm/dialogs/updateArgs';
import { Dialog } from '../lib/Dialog';
import { useDialog } from '../lib/useDialog';

export function UpdateProject() {
  const { init, error, accept, cancel, help } = useDialog<
    UpdateDialogParamsDto,
    UpdateDialogResultDto
  >();
  const [params, setParams] = useState<UpdateDialogParamsDto | undefined>(undefined);
  const [strategy, setStrategy] = useState<'merge' | 'rebase'>('merge');
  const [dontShowAgain, setDontShowAgain] = useState(false);

  useEffect(() => {
    if (!init) return;
    setParams(init.params);
    setStrategy(init.params.strategy);
  }, [init]);

  if (error !== undefined) return <div className="gt-dialog-unknown">{error}</div>;
  if (!params) return <div className="gt-dialog-unknown">Loading…</div>;

  const upstream = params.upstream ?? '';
  const plan = buildUpdatePlan('update', strategy, upstream, params.remote);
  const resetPlan = buildUpdatePlan('reset', strategy, upstream, params.remote);

  return (
    <Dialog
      title="Update Project"
      onCancel={cancel}
      onHelp={help}
      onAction={(id) => {
        if (id === 'cancel') cancel();
        else if (id === 'ok') accept({ action: 'update', strategy, dontShowAgain });
        else if (id === 'reset') accept({ action: 'reset', strategy, dontShowAgain: false });
      }}
      buttons={[
        { id: 'ok', label: 'OK', variant: 'default' },
        { id: 'cancel', label: 'Cancel', variant: 'secondary' },
      ]}
      footerLeft={
        <button
          type="button"
          className="gt-button"
          data-testid="update-reset"
          onClick={() => accept({ action: 'reset', strategy, dontShowAgain: false })}
        >
          Reset to the Remote Branch
        </button>
      }
      className="gt-update-dialog"
    >
      <div className="gt-update-summary" data-testid="update-summary">
        <span className="gt-update-branch">{params.branch}</span>
        <span className="gt-muted"> ← </span>
        <span className="gt-update-upstream">{upstream}</span>
        <span className="gt-muted">
          {' '}
          · {params.behind} behind · {params.ahead} ahead
        </span>
      </div>

      <fieldset className="gt-update-strategies">
        <legend className="gt-visually-hidden">Update strategy</legend>
        <label className="gt-radio">
          <input
            type="radio"
            name="gt-update-strategy"
            data-testid="update-merge"
            checked={strategy === 'merge'}
            onChange={() => setStrategy('merge')}
          />
          <span className="gt-radio-body">Merge incoming changes into the current branch</span>
        </label>
        <label className="gt-radio">
          <input
            type="radio"
            name="gt-update-strategy"
            data-testid="update-rebase"
            checked={strategy === 'rebase'}
            onChange={() => setStrategy('rebase')}
          />
          <span className="gt-radio-body">
            Rebase the current branch on top of incoming changes
          </span>
        </label>
      </fieldset>

      <label className="gt-checkbox gt-update-remember">
        <input
          type="checkbox"
          data-testid="update-dont-show"
          checked={dontShowAgain}
          onChange={(e) => setDontShowAgain(e.currentTarget.checked)}
        />
        <span className="gt-checkbox-body">Do not show again</span>
      </label>
      {dontShowAgain ? (
        <div className="gt-muted gt-update-remember-note" data-testid="update-remember-note">
          Ctrl+T will run {strategy === 'rebase' ? 'Rebase' : 'Merge'} directly. Restore the dialog
          with “GitTree: Update Project Strategy…”.
        </div>
      ) : null}

      {params.showCommandLine ? (
        <div className="gt-update-cmd" data-testid="update-command">
          <div>
            <span className="gt-muted">will run:&nbsp;</span>
            <code>{formatGitCommands(plan)}</code>
          </div>
          <div>
            <span className="gt-muted">reset runs:&nbsp;</span>
            <code>{formatGitCommands(resetPlan)}</code>
          </div>
        </div>
      ) : null}
    </Dialog>
  );
}
