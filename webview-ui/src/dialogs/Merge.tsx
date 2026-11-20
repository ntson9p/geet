/**
 * Merge dialog (P13-T3) — the "Modify options" shape: a ref picker plus the
 * real git flags S4 says Geet hides today (`--no-ff`, `--ff-only`,
 * `--squash`, `--no-commit`, `--allow-unrelated-histories`, strategy and
 * strategy-option, custom message), with a dim "will run" line underneath.
 */
import { useEffect, useMemo, useState } from 'react';
import type {
  MergeDialogParamsDto,
  MergeDialogResultDto,
} from '../../../src/shared/protocol';
import { formatGitCommand } from '../../../src/scm/dialogs/commandLine';
import {
  buildMergeArgs,
  EMPTY_MERGE_OPTIONS,
  validateMergeOptions,
  type MergeOptions,
  type MergeStrategy,
  type MergeStrategyOption,
} from '../../../src/scm/dialogs/mergeArgs';
import { Dialog } from '../lib/Dialog';
import { useDialog } from '../lib/useDialog';
import { ModifyOptions, OptionCheckbox, WillRun, type ModifyOption } from './ModifyOptions';
import { RefPicker } from './RefPicker';

const STRATEGIES: MergeStrategy[] = ['', 'ort', 'recursive', 'resolve', 'octopus', 'ours', 'subtree'];
const STRATEGY_OPTIONS: MergeStrategyOption[] = ['', 'ours', 'theirs', 'ignore-space-change', 'patience'];

type Shown = 'noFf' | 'ffOnly' | 'squash' | 'noCommit' | 'unrelated' | 'strategy' | 'message';

export function Merge() {
  const { init, error, accept, cancel, help } = useDialog<
    MergeDialogParamsDto,
    MergeDialogResultDto
  >();
  const [params, setParams] = useState<MergeDialogParamsDto | undefined>(undefined);
  const [options, setOptions] = useState<MergeOptions>(EMPTY_MERGE_OPTIONS);
  const [shown, setShown] = useState<ReadonlySet<Shown>>(() => new Set());

  useEffect(() => {
    if (!init) return;
    setParams(init.params);
    setOptions({ ...EMPTY_MERGE_OPTIONS, ref: init.params.defaultRef });
  }, [init]);

  const errors = useMemo(() => validateMergeOptions(options), [options]);
  const argv = useMemo(() => buildMergeArgs(options), [options]);

  if (error !== undefined) return <div className="gt-dialog-unknown">{error}</div>;
  if (!params) return <div className="gt-dialog-unknown">Loading…</div>;

  const toggleShown = (id: string): void => {
    const key = id as Shown;
    setShown((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
    // Hiding an option must also turn it off — a flag the user cannot see must
    // never survive in the command.
    if (shown.has(key)) {
      setOptions((o) => {
        switch (key) {
          case 'noFf':
            return { ...o, noFf: false };
          case 'ffOnly':
            return { ...o, ffOnly: false };
          case 'squash':
            return { ...o, squash: false };
          case 'noCommit':
            return { ...o, noCommit: false };
          case 'unrelated':
            return { ...o, allowUnrelatedHistories: false };
          case 'strategy':
            return { ...o, strategy: '', strategyOption: '' };
          case 'message':
            return { ...o, message: '' };
        }
      });
    }
  };

  const modify: ModifyOption[] = [
    { id: 'noFf', label: 'Create a merge commit', flag: '--no-ff', checked: shown.has('noFf') },
    { id: 'ffOnly', label: 'Fast-forward only', flag: '--ff-only', checked: shown.has('ffOnly') },
    { id: 'squash', label: 'Squash', flag: '--squash', checked: shown.has('squash') },
    { id: 'noCommit', label: 'Do not commit', flag: '--no-commit', checked: shown.has('noCommit') },
    {
      id: 'unrelated',
      label: 'Allow unrelated histories',
      flag: '--allow-unrelated-histories',
      checked: shown.has('unrelated'),
    },
    { id: 'strategy', label: 'Strategy', flag: '-s / -X', checked: shown.has('strategy') },
    { id: 'message', label: 'Custom message', flag: '-m', checked: shown.has('message') },
  ];

  return (
    <Dialog
      title={`Merge into ${params.currentBranch}`}
      onCancel={cancel}
      onHelp={help}
      onAction={(id) => {
        if (id === 'cancel') cancel();
        else if (id === 'merge' && errors.length === 0) accept({ options });
      }}
      buttons={[
        { id: 'merge', label: 'Merge', variant: 'default', disabled: errors.length > 0 },
        { id: 'cancel', label: 'Cancel', variant: 'secondary' },
      ]}
      className="gt-op-dialog"
    >
      <RefPicker
        id="merge-ref"
        label={`Merge into ${params.currentBranch}:`}
        refs={params.refs}
        value={options.ref}
        onChange={(ref) => setOptions((o) => ({ ...o, ref }))}
      />

      <ModifyOptions options={modify} onToggle={toggleShown} conflicts={errors}>
        {shown.has('noFf') ? (
          <OptionCheckbox
            id="merge-no-ff"
            label="Create a merge commit even if fast-forward is possible"
            flag="--no-ff"
            checked={options.noFf}
            onChange={(v) => setOptions((o) => ({ ...o, noFf: v }))}
          />
        ) : null}
        {shown.has('ffOnly') ? (
          <OptionCheckbox
            id="merge-ff-only"
            label="Refuse unless the merge can fast-forward"
            flag="--ff-only"
            checked={options.ffOnly}
            onChange={(v) => setOptions((o) => ({ ...o, ffOnly: v }))}
          />
        ) : null}
        {shown.has('squash') ? (
          <OptionCheckbox
            id="merge-squash"
            label="Squash the commits, staging without committing"
            flag="--squash"
            checked={options.squash}
            onChange={(v) => setOptions((o) => ({ ...o, squash: v }))}
          />
        ) : null}
        {shown.has('noCommit') ? (
          <OptionCheckbox
            id="merge-no-commit"
            label="Merge but do not commit"
            flag="--no-commit"
            checked={options.noCommit}
            onChange={(v) => setOptions((o) => ({ ...o, noCommit: v }))}
          />
        ) : null}
        {shown.has('unrelated') ? (
          <OptionCheckbox
            id="merge-unrelated"
            label="Allow histories with no common ancestor"
            flag="--allow-unrelated-histories"
            checked={options.allowUnrelatedHistories}
            onChange={(v) => setOptions((o) => ({ ...o, allowUnrelatedHistories: v }))}
          />
        ) : null}
        {shown.has('strategy') ? (
          <div className="gt-op-row">
            <label htmlFor="merge-strategy">Strategy:</label>
            <select
              id="merge-strategy"
              className="gt-input"
              data-testid="merge-strategy"
              value={options.strategy}
              onChange={(e) => {
                // Read the value NOW: React clears `currentTarget` before a
                // functional updater runs, and reading it there throws.
                const next = e.currentTarget.value as MergeStrategy;
                setOptions((o) => ({ ...o, strategy: next }));
              }}
            >
              {STRATEGIES.map((s) => (
                <option key={s} value={s}>
                  {s === '' ? '(default)' : s}
                </option>
              ))}
            </select>
            <label htmlFor="merge-strategy-option">Option:</label>
            <select
              id="merge-strategy-option"
              className="gt-input"
              data-testid="merge-strategy-option"
              value={options.strategyOption}
              onChange={(e) => {
                const next = e.currentTarget.value as MergeStrategyOption;
                setOptions((o) => ({ ...o, strategyOption: next }));
              }}
            >
              {STRATEGY_OPTIONS.map((s) => (
                <option key={s} value={s}>
                  {s === '' ? '(none)' : s}
                </option>
              ))}
            </select>
          </div>
        ) : null}
        {shown.has('message') ? (
          <div className="gt-op-row gt-op-row-block">
            <label htmlFor="merge-message">Commit message:</label>
            <textarea
              id="merge-message"
              className="gt-input gt-op-message"
              data-testid="merge-message"
              rows={3}
              value={options.message}
              onChange={(e) => {
                const next = e.currentTarget.value;
                setOptions((o) => ({ ...o, message: next }));
              }}
            />
          </div>
        ) : null}
      </ModifyOptions>

      <WillRun show={params.showCommandLine} text={formatGitCommand(argv)} />
    </Dialog>
  );
}
