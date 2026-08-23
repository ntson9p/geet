/**
 * New Worktree dialog (P13-T6): the path picker (defaulting to the sibling
 * `../<repo>-<branch>` IntelliJ uses), the branch mode — check out an existing
 * branch, create a new one from a start point, or detach at a revision —
 * `[ ] Open in new window`, and the options behind them.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  NewWorktreeDialogParamsDto,
  NewWorktreeDialogResultDto,
} from '../../../src/shared/protocol';
import { formatGitCommand } from '../../../src/scm/dialogs/commandLine';
import {
  buildWorktreeAddArgs,
  defaultWorktreePath,
  EMPTY_NEW_WORKTREE_OPTIONS,
  validateNewWorktree,
  type NewWorktreeOptions,
  type WorktreeBranchMode,
} from '../../../src/branches/worktreeArgs';
import { Dialog } from '../lib/Dialog';
import { useDialog } from '../lib/useDialog';
import { ModifyOptions, OptionCheckbox, WillRun, type ModifyOption } from './ModifyOptions';

const MODE_LABEL: Record<WorktreeBranchMode, string> = {
  existing: 'Check out an existing branch',
  new: 'Create a new branch',
  detach: 'Detach at a revision',
};

type Shown = 'noCheckout' | 'force';

export function NewWorktree() {
  const { init, error, accept, cancel, help } = useDialog<
    NewWorktreeDialogParamsDto,
    NewWorktreeDialogResultDto
  >();
  const [params, setParams] = useState<NewWorktreeDialogParamsDto | undefined>(undefined);
  const [options, setOptions] = useState<NewWorktreeOptions>(EMPTY_NEW_WORKTREE_OPTIONS);
  const [openInNewWindow, setOpenInNewWindow] = useState(true);
  const [pathTouched, setPathTouched] = useState(false);
  const [shown, setShown] = useState<ReadonlySet<Shown>>(() => new Set());

  useEffect(() => {
    if (!init) return;
    const p = init.params;
    setParams(p);
    setOptions({
      ...EMPTY_NEW_WORKTREE_OPTIONS,
      path: p.defaultPath,
      mode: 'existing',
      ref: p.seedBranch,
    });
  }, [init]);

  /** The path follows the chosen branch until the user types their own. */
  const retargetPath = useCallback(
    (next: NewWorktreeOptions): NewWorktreeOptions => {
      if (pathTouched || params === undefined) return next;
      const name = next.mode === 'new' ? next.newBranch : next.ref;
      return { ...next, path: defaultWorktreePath(params.repoRoot, name) };
    },
    [params, pathTouched],
  );

  const errors = useMemo(() => validateNewWorktree(options), [options]);
  const argv = useMemo(() => buildWorktreeAddArgs(options), [options]);

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
    setOptions((o) => (key === 'noCheckout' ? { ...o, noCheckout: false } : { ...o, force: false }));
  };

  const modify: ModifyOption[] = [
    {
      id: 'noCheckout',
      label: 'Do not check files out',
      flag: '--no-checkout',
      checked: shown.has('noCheckout'),
    },
    {
      id: 'force',
      label: 'Allow a branch checked out elsewhere',
      flag: '--force',
      checked: shown.has('force'),
    },
  ];

  return (
    <Dialog
      title={`New Worktree — ${params.repoLabel}`}
      onCancel={cancel}
      onHelp={help}
      onAction={(id) => {
        if (id === 'cancel') cancel();
        else if (id === 'create' && errors.length === 0) accept({ options, openInNewWindow });
      }}
      buttons={[
        { id: 'create', label: 'Create', variant: 'default', disabled: errors.length > 0 },
        { id: 'cancel', label: 'Cancel', variant: 'secondary' },
      ]}
      footerLeft={
        <label className="gt-checkbox">
          <input
            type="checkbox"
            data-testid="worktree-open-window"
            checked={openInNewWindow}
            onChange={(e) => setOpenInNewWindow(e.currentTarget.checked)}
          />
          <span className="gt-checkbox-body">Open in new window</span>
        </label>
      }
      className="gt-op-dialog"
    >
      <fieldset className="gt-op-modes">
        <legend className="gt-visually-hidden">Branch mode</legend>
        {(['existing', 'new', 'detach'] as WorktreeBranchMode[]).map((m) => (
          <label className="gt-radio" key={m}>
            <input
              type="radio"
              name="gt-worktree-mode"
              data-testid={`worktree-mode-${m}`}
              checked={options.mode === m}
              onChange={() =>
                setOptions((o) =>
                  retargetPath({
                    ...o,
                    mode: m,
                    // Switching to "new" keeps the selected branch as the start
                    // point, which is what "New Worktree from 'X'" means.
                    ref: m === 'new' ? o.ref : (o.ref || params.seedBranch),
                  }),
                )
              }
            />
            <span className="gt-radio-body">{MODE_LABEL[m]}</span>
          </label>
        ))}
      </fieldset>

      {options.mode === 'new' ? (
        <div className="gt-op-row">
          <label htmlFor="worktree-new-branch">New branch:</label>
          <input
            id="worktree-new-branch"
            className="gt-input gt-ref-expression"
            data-testid="worktree-new-branch"
            value={options.newBranch}
            onChange={(e) => {
              const next = e.currentTarget.value;
              setOptions((o) => retargetPath({ ...o, newBranch: next }));
            }}
          />
          <label htmlFor="worktree-start">from:</label>
          <select
            id="worktree-start"
            className="gt-input gt-ref-select"
            data-testid="worktree-start"
            value={options.ref}
            onChange={(e) => {
              const next = e.currentTarget.value;
              setOptions((o) => ({ ...o, ref: next }));
            }}
          >
            {params.branches.map((b) => (
              <option key={b} value={b}>
                {b}
              </option>
            ))}
          </select>
        </div>
      ) : options.mode === 'existing' ? (
        <div className="gt-op-row">
          <label htmlFor="worktree-branch">Branch:</label>
          <select
            id="worktree-branch"
            className="gt-input gt-ref-select"
            data-testid="worktree-branch"
            value={options.ref}
            onChange={(e) => {
              const next = e.currentTarget.value;
              setOptions((o) => retargetPath({ ...o, ref: next }));
            }}
          >
            {params.branches.map((b) => (
              <option key={b} value={b}>
                {b}
              </option>
            ))}
          </select>
        </div>
      ) : (
        <div className="gt-op-row">
          <label htmlFor="worktree-revision">Revision:</label>
          <input
            id="worktree-revision"
            className="gt-input gt-ref-expression"
            data-testid="worktree-revision"
            placeholder="a branch, tag or hash"
            value={options.ref}
            onChange={(e) => {
              const next = e.currentTarget.value;
              setOptions((o) => retargetPath({ ...o, ref: next }));
            }}
          />
        </div>
      )}

      <div className="gt-op-row">
        <label htmlFor="worktree-path">Location:</label>
        <input
          id="worktree-path"
          className="gt-input gt-ref-expression"
          data-testid="worktree-path"
          value={options.path}
          onChange={(e) => {
            const next = e.currentTarget.value;
            setPathTouched(true);
            setOptions((o) => ({ ...o, path: next }));
          }}
        />
      </div>

      <ModifyOptions options={modify} onToggle={toggleShown} conflicts={errors}>
        {shown.has('noCheckout') ? (
          <OptionCheckbox
            id="worktree-no-checkout"
            label="Create the worktree without populating it"
            flag="--no-checkout"
            checked={options.noCheckout}
            onChange={(v) => setOptions((o) => ({ ...o, noCheckout: v }))}
          />
        ) : null}
        {shown.has('force') ? (
          <OptionCheckbox
            id="worktree-force"
            label="Check out a branch that is already used by another worktree"
            flag="--force"
            checked={options.force}
            onChange={(v) => setOptions((o) => ({ ...o, force: v }))}
          />
        ) : null}
      </ModifyOptions>

      <WillRun show={params.showCommandLine} text={formatGitCommand(argv)} />
    </Dialog>
  );
}
