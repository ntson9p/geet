/**
 * Stash dialog (P13-T4): a message field plus `--keep-index`,
 * `--include-untracked` and `--all`. `--staged` is offered only when the git
 * build has it (2.35+), because a greyed control with no reason is worse than
 * no control at all — the note says which version it needs.
 */
import { useEffect, useMemo, useState } from 'react';
import type {
  StashDialogParamsDto,
  StashDialogResultDto,
} from '../../../src/shared/protocol';
import { formatGitCommand } from '../../../src/scm/dialogs/commandLine';
import {
  buildStashPushArgs,
  EMPTY_STASH_PUSH_OPTIONS,
  validateStashPushOptions,
  type StashPushArgsOptions,
} from '../../../src/scm/dialogs/stashArgs';
import { Dialog } from '../lib/Dialog';
import { useDialog } from '../lib/useDialog';
import { ModifyOptions, OptionCheckbox, WillRun, type ModifyOption } from './ModifyOptions';

type Shown = 'keepIndex' | 'all' | 'staged';

export function Stash() {
  const { init, error, accept, cancel, help } = useDialog<
    StashDialogParamsDto,
    StashDialogResultDto
  >();
  const [params, setParams] = useState<StashDialogParamsDto | undefined>(undefined);
  const [options, setOptions] = useState<StashPushArgsOptions>(EMPTY_STASH_PUSH_OPTIONS);
  const [shown, setShown] = useState<ReadonlySet<Shown>>(() => new Set());

  useEffect(() => {
    if (!init) return;
    setParams(init.params);
    setOptions({
      ...EMPTY_STASH_PUSH_OPTIONS,
      includeUntracked: init.params.includeUntrackedDefault,
    });
  }, [init]);

  const errors = useMemo(() => validateStashPushOptions(options), [options]);
  const argv = useMemo(() => buildStashPushArgs(options), [options]);

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
        case 'keepIndex':
          return { ...o, keepIndex: false };
        case 'all':
          return { ...o, all: false };
        case 'staged':
          return { ...o, staged: false };
      }
    });
  };

  const modify: ModifyOption[] = [
    { id: 'keepIndex', label: 'Keep index', flag: '--keep-index', checked: shown.has('keepIndex') },
    { id: 'all', label: 'Include ignored files', flag: '--all', checked: shown.has('all') },
    {
      id: 'staged',
      label: 'Only staged changes',
      flag: '--staged',
      checked: shown.has('staged'),
      disabled: !params.canStashStaged,
    },
  ];

  return (
    <Dialog
      title={`Stash Changes — ${params.repoLabel}`}
      onCancel={cancel}
      onHelp={help}
      onAction={(id) => {
        if (id === 'cancel') cancel();
        else if (id === 'stash' && errors.length === 0) accept({ options });
      }}
      buttons={[
        { id: 'stash', label: 'Create Stash', variant: 'default', disabled: errors.length > 0 },
        { id: 'cancel', label: 'Cancel', variant: 'secondary' },
      ]}
      footerLeft={
        <label className={`gt-checkbox${options.staged || options.all ? ' gt-disabled' : ''}`}>
          <input
            type="checkbox"
            data-testid="stash-untracked"
            disabled={options.staged || options.all}
            checked={options.includeUntracked && !options.staged}
            onChange={(e) => {
              const next = e.currentTarget.checked;
              setOptions((o) => ({ ...o, includeUntracked: next }));
            }}
          />
          <span className="gt-checkbox-body">
            Include untracked files
            <span className="gt-muted"> ({params.untrackedCount})</span>
          </span>
        </label>
      }
      className="gt-op-dialog"
    >
      <div className="gt-op-row gt-op-row-block">
        <label htmlFor="stash-message">Message:</label>
        <input
          id="stash-message"
          className="gt-input gt-stash-message"
          data-testid="stash-message"
          placeholder="Optional — git writes a WIP message when empty"
          value={options.message}
          onChange={(e) => {
            const next = e.currentTarget.value;
            setOptions((o) => ({ ...o, message: next }));
          }}
        />
      </div>

      <div className="gt-muted" data-testid="stash-summary">
        {params.dirtyCount} changed file{params.dirtyCount === 1 ? '' : 's'} ·{' '}
        {params.stagedCount} staged · {params.untrackedCount} untracked
      </div>

      <ModifyOptions options={modify} onToggle={toggleShown} conflicts={errors}>
        {shown.has('keepIndex') ? (
          <OptionCheckbox
            id="stash-keep-index"
            label="Leave staged changes applied in the working tree"
            flag="--keep-index"
            checked={options.keepIndex}
            onChange={(v) => setOptions((o) => ({ ...o, keepIndex: v }))}
          />
        ) : null}
        {shown.has('all') ? (
          <OptionCheckbox
            id="stash-all"
            label="Stash ignored files too"
            flag="--all"
            checked={options.all}
            onChange={(v) => setOptions((o) => ({ ...o, all: v }))}
          />
        ) : null}
        {shown.has('staged') ? (
          <>
            <OptionCheckbox
              id="stash-staged"
              label="Stash only what is staged"
              flag="--staged"
              checked={options.staged}
              disabled={!params.canStashStaged}
              // `--staged` dominates: clear what it excludes rather than leaving
              // a default behind that only the validator would ever notice.
              onChange={(v) =>
                setOptions((o) =>
                  v
                    ? { ...o, staged: true, includeUntracked: false, all: false, keepIndex: false }
                    : { ...o, staged: false, includeUntracked: params.includeUntrackedDefault },
                )
              }
            />
            {params.canStashStaged ? null : (
              <div className="gt-muted gt-op-note" data-testid="stash-staged-note">
                Your git build is older than 2.35, which is where --staged arrived.
              </div>
            )}
          </>
        ) : null}
      </ModifyOptions>

      <WillRun show={params.showCommandLine} text={formatGitCommand(argv)} />
    </Dialog>
  );
}
