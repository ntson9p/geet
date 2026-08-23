/**
 * Rebase dialog (P13-T3) — onto-ref plus the flags behind it. `--interactive`
 * does not run `git rebase -i` (its editor is a terminal editor a webview
 * cannot serve): ticking it hands off to P5's interactive rebase surface, and
 * the dialog says so rather than pretending otherwise.
 */
import { useEffect, useMemo, useState } from 'react';
import type {
  RebaseDialogParamsDto,
  RebaseDialogResultDto,
} from '../../../src/shared/protocol';
import { formatGitCommand } from '../../../src/scm/dialogs/commandLine';
import {
  buildRebaseArgs,
  EMPTY_REBASE_OPTIONS,
  validateRebaseOptions,
  type RebaseOptions,
} from '../../../src/scm/dialogs/rebaseArgs';
import { Dialog } from '../lib/Dialog';
import { useDialog } from '../lib/useDialog';
import { ModifyOptions, OptionCheckbox, WillRun, type ModifyOption } from './ModifyOptions';
import { RefPicker } from './RefPicker';

type Shown = 'from' | 'interactive' | 'rebaseMerges' | 'autostash' | 'noVerify' | 'keepEmpty';

export function Rebase() {
  const { init, error, accept, cancel, help } = useDialog<
    RebaseDialogParamsDto,
    RebaseDialogResultDto
  >();
  const [params, setParams] = useState<RebaseDialogParamsDto | undefined>(undefined);
  const [options, setOptions] = useState<RebaseOptions>(EMPTY_REBASE_OPTIONS);
  const [shown, setShown] = useState<ReadonlySet<Shown>>(() => new Set());

  useEffect(() => {
    if (!init) return;
    setParams(init.params);
    setOptions({ ...EMPTY_REBASE_OPTIONS, onto: init.params.defaultOnto });
  }, [init]);

  const errors = useMemo(() => validateRebaseOptions(options), [options]);
  const argv = useMemo(() => buildRebaseArgs(options), [options]);

  if (error !== undefined) return <div className="gt-dialog-unknown">{error}</div>;
  if (!params) return <div className="gt-dialog-unknown">Loading…</div>;

  const toggleShown = (id: string): void => {
    const key = id as Shown;
    const wasShown = shown.has(key);
    setShown((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
    if (!wasShown) return;
    setOptions((o) => {
      switch (key) {
        case 'from':
          return { ...o, from: '' };
        case 'interactive':
          return { ...o, interactive: false };
        case 'rebaseMerges':
          return { ...o, rebaseMerges: false };
        case 'autostash':
          return { ...o, autostash: false };
        case 'noVerify':
          return { ...o, noVerify: false };
        case 'keepEmpty':
          return { ...o, keepEmpty: false };
      }
    });
  };

  const modify: ModifyOption[] = [
    { id: 'from', label: 'Rebase a range from', flag: '--onto', checked: shown.has('from') },
    {
      id: 'interactive',
      label: 'Interactive',
      flag: '--interactive',
      checked: shown.has('interactive'),
    },
    {
      id: 'rebaseMerges',
      label: 'Keep merge commits',
      flag: '--rebase-merges',
      checked: shown.has('rebaseMerges'),
    },
    { id: 'autostash', label: 'Autostash', flag: '--autostash', checked: shown.has('autostash') },
    { id: 'noVerify', label: 'Skip hooks', flag: '--no-verify', checked: shown.has('noVerify') },
    { id: 'keepEmpty', label: 'Keep empty commits', flag: '--keep-empty', checked: shown.has('keepEmpty') },
  ];

  return (
    <Dialog
      title={`Rebase ${params.currentBranch}`}
      onCancel={cancel}
      onHelp={help}
      onAction={(id) => {
        if (id === 'cancel') cancel();
        else if (id === 'rebase' && errors.length === 0) accept({ options });
      }}
      buttons={[
        {
          id: 'rebase',
          label: options.interactive ? 'Start Interactive Rebase' : 'Rebase',
          variant: 'default',
          disabled: errors.length > 0,
        },
        { id: 'cancel', label: 'Cancel', variant: 'secondary' },
      ]}
      className="gt-op-dialog"
    >
      <RefPicker
        id="rebase-onto"
        label={`Rebase ${params.currentBranch} onto:`}
        refs={params.refs}
        value={options.onto}
        onChange={(onto) => setOptions((o) => ({ ...o, onto }))}
        allowExpression
      />

      <ModifyOptions options={modify} onToggle={toggleShown} conflicts={errors}>
        {shown.has('from') ? (
          <RefPicker
            id="rebase-from"
            label="Replay commits after:"
            refs={params.refs}
            value={options.from}
            onChange={(from) => setOptions((o) => ({ ...o, from }))}
            allowExpression
          />
        ) : null}
        {shown.has('interactive') ? (
          <>
            <OptionCheckbox
              id="rebase-interactive"
              label="Edit the commit list before replaying"
              flag="--interactive"
              checked={options.interactive}
              onChange={(v) => setOptions((o) => ({ ...o, interactive: v }))}
            />
            {options.interactive ? (
              <div className="gt-muted gt-op-note" data-testid="rebase-interactive-note">
                Opens GitTree’s interactive rebase editor instead of git’s terminal editor.
              </div>
            ) : null}
          </>
        ) : null}
        {shown.has('rebaseMerges') ? (
          <OptionCheckbox
            id="rebase-merges"
            label="Recreate merge commits instead of flattening them"
            flag="--rebase-merges"
            checked={options.rebaseMerges}
            onChange={(v) => setOptions((o) => ({ ...o, rebaseMerges: v }))}
          />
        ) : null}
        {shown.has('autostash') ? (
          <OptionCheckbox
            id="rebase-autostash"
            label="Stash local changes and restore them afterwards"
            flag="--autostash"
            checked={options.autostash}
            onChange={(v) => setOptions((o) => ({ ...o, autostash: v }))}
          />
        ) : null}
        {shown.has('noVerify') ? (
          <OptionCheckbox
            id="rebase-no-verify"
            label="Skip the pre-rebase hook"
            flag="--no-verify"
            checked={options.noVerify}
            onChange={(v) => setOptions((o) => ({ ...o, noVerify: v }))}
          />
        ) : null}
        {shown.has('keepEmpty') ? (
          <OptionCheckbox
            id="rebase-keep-empty"
            label="Keep commits that become empty"
            flag="--keep-empty"
            checked={options.keepEmpty}
            onChange={(v) => setOptions((o) => ({ ...o, keepEmpty: v }))}
          />
        ) : null}
      </ModifyOptions>

      <WillRun show={params.showCommandLine} text={formatGitCommand(argv)} />
    </Dialog>
  );
}
