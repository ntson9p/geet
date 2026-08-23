/**
 * Cherry-pick dialog (P13-T4): the commit list to replay, plus the flags that
 * were unreachable before — `-x` (append the source line), `--no-commit`, and
 * `-m <parent>`, which is the only way to cherry-pick a merge commit at all.
 * The mainline field appears only for a commit that actually has two parents.
 */
import { useEffect, useMemo, useState } from 'react';
import type {
  CherryPickDialogParamsDto,
  CherryPickDialogResultDto,
} from '../../../src/shared/protocol';
import { formatGitCommand } from '../../../src/scm/dialogs/commandLine';
import {
  buildCherryPickArgs,
  EMPTY_CHERRY_PICK_OPTIONS,
  validateCherryPickOptions,
  type CherryPickOptions,
} from '../../../src/scm/dialogs/cherryPickArgs';
import { Dialog } from '../lib/Dialog';
import { useDialog } from '../lib/useDialog';
import { ModifyOptions, OptionCheckbox, WillRun, type ModifyOption } from './ModifyOptions';

function shortDate(unixSeconds: number): string {
  if (!Number.isFinite(unixSeconds) || unixSeconds <= 0) return '';
  return new Date(unixSeconds * 1000).toLocaleDateString();
}

type Shown = 'noCommit' | 'mainline';

export function CherryPick() {
  const { init, error, accept, cancel, help } = useDialog<
    CherryPickDialogParamsDto,
    CherryPickDialogResultDto
  >();
  const [params, setParams] = useState<CherryPickDialogParamsDto | undefined>(undefined);
  const [picked, setPicked] = useState<readonly string[]>([]);
  const [options, setOptions] = useState<CherryPickOptions>(EMPTY_CHERRY_PICK_OPTIONS);
  const [shown, setShown] = useState<ReadonlySet<Shown>>(() => new Set());

  useEffect(() => {
    if (!init) return;
    setParams(init.params);
    const first = init.params.commits[0]?.sha;
    setPicked(first !== undefined ? [first] : []);
    setOptions({ ...EMPTY_CHERRY_PICK_OPTIONS, recordOrigin: init.params.recordOrigin });
  }, [init]);

  // The commits must reach git oldest-first, whatever order they were ticked in.
  const orderedShas = useMemo(() => {
    const order = new Map((params?.commits ?? []).map((c, i) => [c.sha, i]));
    return [...picked].sort((a, b) => (order.get(b) ?? 0) - (order.get(a) ?? 0));
  }, [params?.commits, picked]);

  const effective = useMemo<CherryPickOptions>(
    () => ({ ...options, shas: orderedShas }),
    [options, orderedShas],
  );
  const errors = useMemo(() => validateCherryPickOptions(effective), [effective]);
  const argv = useMemo(() => buildCherryPickArgs(effective), [effective]);

  if (error !== undefined) return <div className="gt-dialog-unknown">{error}</div>;
  if (!params) return <div className="gt-dialog-unknown">Loading…</div>;

  const onlyPicked =
    picked.length === 1 ? params.commits.find((c) => c.sha === picked[0]) : undefined;
  const canSetMainline = onlyPicked !== undefined && onlyPicked.parentCount > 1;

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
    setOptions((o) => (key === 'noCommit' ? { ...o, noCommit: false } : { ...o, mainline: 0 }));
  };

  const modify: ModifyOption[] = [
    { id: 'noCommit', label: 'Do not commit', flag: '--no-commit', checked: shown.has('noCommit') },
    {
      id: 'mainline',
      label: 'Mainline parent (merge commits)',
      flag: '-m',
      checked: shown.has('mainline'),
      disabled: !canSetMainline,
    },
  ];

  return (
    <Dialog
      title={`Cherry-Pick into ${params.currentBranch}`}
      onCancel={cancel}
      onHelp={help}
      onAction={(id) => {
        if (id === 'cancel') cancel();
        else if (id === 'pick' && errors.length === 0) accept({ options: effective });
      }}
      buttons={[
        { id: 'pick', label: 'Cherry-Pick', variant: 'default', disabled: errors.length > 0 },
        { id: 'cancel', label: 'Cancel', variant: 'secondary' },
      ]}
      footerLeft={
        <label className="gt-checkbox">
          <input
            type="checkbox"
            data-testid="cherry-record-origin"
            checked={options.recordOrigin}
            onChange={(e) => {
              const next = e.currentTarget.checked;
              setOptions((o) => ({ ...o, recordOrigin: next }));
            }}
          />
          <span className="gt-checkbox-body">Record the source commit (-x)</span>
        </label>
      }
      className="gt-op-dialog"
    >
      <div className="gt-cherry-count" data-testid="cherry-count">
        {picked.length} of {params.commits.length} commit{params.commits.length === 1 ? '' : 's'}
      </div>
      <ul className="gt-cherry-list" data-testid="cherry-list">
        {params.commits.map((c) => (
          <li key={c.sha} className="gt-cherry-row">
            <label className="gt-checkbox">
              <input
                type="checkbox"
                aria-label={c.subject}
                data-testid={`cherry-${c.sha.slice(0, 7)}`}
                checked={picked.includes(c.sha)}
                onChange={(e) => {
                  const on = e.currentTarget.checked;
                  setPicked((prev) =>
                    on ? [...prev, c.sha] : prev.filter((s) => s !== c.sha),
                  );
                }}
              />
              <span className="gt-checkbox-body">
                <span className="gt-cherry-line">
                  <code className="gt-cherry-sha">{c.sha.slice(0, 7)}</code>
                  <span className="gt-cherry-subject">{c.subject}</span>
                  {c.parentCount > 1 ? <span className="gt-cherry-merge">merge</span> : null}
                  <span className="gt-muted">
                    {c.authorName} · {shortDate(c.authorTime)}
                  </span>
                </span>
              </span>
            </label>
          </li>
        ))}
      </ul>

      <ModifyOptions options={modify} onToggle={toggleShown} conflicts={errors}>
        {shown.has('noCommit') ? (
          <OptionCheckbox
            id="cherry-no-commit"
            label="Stage the result without committing"
            flag="--no-commit"
            checked={options.noCommit}
            onChange={(v) => setOptions((o) => ({ ...o, noCommit: v }))}
          />
        ) : null}
        {shown.has('mainline') ? (
          <div className="gt-op-row">
            <label htmlFor="cherry-mainline">Mainline parent:</label>
            <input
              id="cherry-mainline"
              className="gt-input"
              data-testid="cherry-mainline"
              type="number"
              min={0}
              max={Math.max(1, onlyPicked?.parentCount ?? 1)}
              disabled={!canSetMainline}
              value={options.mainline}
              onChange={(e) => {
                const next = Number(e.currentTarget.value) || 0;
                setOptions((o) => ({ ...o, mainline: next }));
              }}
            />
            <span className="gt-muted">0 = not a merge pick</span>
          </div>
        ) : null}
      </ModifyOptions>

      <WillRun show={params.showCommandLine} text={formatGitCommand(argv)} />
    </Dialog>
  );
}
