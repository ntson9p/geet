/**
 * Reset dialog (P13-T3) — a revision field (ref picker *or* a raw
 * hash/`HEAD~2` expression) and the four-mode radio `Soft · Mixed · Hard ·
 * Keep`. `Keep` was missing from every Geet surface before P12-T7.6 and is
 * the mode most users actually want: it moves HEAD like `--hard` but refuses
 * rather than discarding local changes.
 *
 * The impact line under the radio is live and mode-specific, so the difference
 * between "unstages 3 changes" and "DISCARDS 3 changes" is visible before the
 * button is pressed, not after.
 */
import { useEffect, useMemo, useState } from 'react';
import type {
  ResetDialogParamsDto,
  ResetDialogResultDto,
} from '../../../src/shared/protocol';
import { formatGitCommand } from '../../../src/scm/dialogs/commandLine';
import {
  buildResetArgs,
  describeResetImpact,
  RESET_MODES,
  validateResetOptions,
  type ResetMode,
} from '../../../src/scm/dialogs/resetArgs';
import { Dialog } from '../lib/Dialog';
import { useDialog } from '../lib/useDialog';
import { WillRun } from './ModifyOptions';
import { RefPicker } from './RefPicker';

const MODE_LABEL: Record<ResetMode, string> = {
  soft: 'Soft — keep the index and the working tree',
  mixed: 'Mixed — reset the index, keep the working tree',
  hard: 'Hard — discard everything after the revision',
  keep: 'Keep — like hard, but refuses to discard local changes',
};

export function Reset() {
  const { init, error, accept, cancel, help } = useDialog<
    ResetDialogParamsDto,
    ResetDialogResultDto
  >();
  const [params, setParams] = useState<ResetDialogParamsDto | undefined>(undefined);
  const [ref, setRef] = useState('');
  const [mode, setMode] = useState<ResetMode>('mixed');

  useEffect(() => {
    if (!init) return;
    setParams(init.params);
    setRef(init.params.defaultRef);
  }, [init]);

  const errors = useMemo(() => validateResetOptions({ ref, mode }), [mode, ref]);
  const argv = useMemo(() => buildResetArgs({ ref, mode }), [mode, ref]);

  if (error !== undefined) return <div className="gt-dialog-unknown">{error}</div>;
  if (!params) return <div className="gt-dialog-unknown">Loading…</div>;

  const impact = describeResetImpact(mode, params.dirtyCount, params.stagedCount);

  return (
    <Dialog
      title={`Reset ${params.currentBranch}`}
      onCancel={cancel}
      onHelp={help}
      onAction={(id) => {
        if (id === 'cancel') cancel();
        else if (id === 'reset' && errors.length === 0) accept({ ref, mode });
      }}
      buttons={[
        { id: 'reset', label: 'Reset', variant: 'default', disabled: errors.length > 0 },
        { id: 'cancel', label: 'Cancel', variant: 'secondary' },
      ]}
      className="gt-op-dialog"
    >
      <RefPicker
        id="reset-ref"
        label={`Reset ${params.currentBranch} to:`}
        refs={params.refs}
        value={ref}
        onChange={setRef}
        allowExpression
      />

      <fieldset className="gt-op-modes">
        <legend className="gt-visually-hidden">Reset mode</legend>
        {RESET_MODES.map((m) => (
          <label className="gt-radio" key={m}>
            <input
              type="radio"
              name="gt-reset-mode"
              data-testid={`reset-mode-${m}`}
              checked={mode === m}
              onChange={() => setMode(m)}
            />
            <span className="gt-radio-body">{MODE_LABEL[m]}</span>
          </label>
        ))}
      </fieldset>

      <div
        className={`gt-op-impact${mode === 'hard' ? ' gt-op-impact-danger' : ''}`}
        data-testid="reset-impact"
      >
        {impact}
      </div>

      <WillRun show={params.showCommandLine} text={formatGitCommand(argv)} />
    </Dialog>
  );
}
