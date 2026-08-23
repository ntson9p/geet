/**
 * Apply Patch dialog (P13-T4): file picker → pre-apply summary (files, hunk
 * counts, missing-file warnings from `splitPatchFiles`) → the flags `--3way`,
 * `--reverse`, `-p<n>`, `--whitespace=fix`. A mailbox patch says so, and offers
 * the choice of replaying it as commits or applying it as content.
 */
import { useEffect, useMemo, useState } from 'react';
import {
  PATCH_DIALOG_METHODS,
  type ApplyPatchDialogParamsDto,
  type ApplyPatchDialogResultDto,
} from '../../../src/shared/protocol';
import { formatGitCommand } from '../../../src/scm/dialogs/commandLine';
import { Dialog } from '../lib/Dialog';
import { useDialog } from '../lib/useDialog';
import { ModifyOptions, OptionCheckbox, WillRun, type ModifyOption } from './ModifyOptions';

type Shown = 'reverse' | 'pDepth' | 'whitespace' | 'contentOnly';

/** The preview line: `git am -3` for a mailbox, `git apply …` otherwise. */
function previewArgs(
  params: ApplyPatchDialogParamsDto,
  o: { threeWay: boolean; reverse: boolean; pDepth: number; whitespaceFix: boolean; contentOnly: boolean },
): string[] {
  const file = params.patchPath.length > 0 ? params.patchPath : '<patch>';
  if (params.isMailbox && !o.contentOnly && !o.reverse) return ['am', '-3', file];
  const args = ['apply'];
  if (o.threeWay) args.push('--3way');
  if (o.reverse) args.push('--reverse');
  if (o.pDepth !== 1) args.push(`-p${o.pDepth}`);
  if (o.whitespaceFix) args.push('--whitespace=fix');
  args.push(file);
  return args;
}

export function ApplyPatch() {
  const { init, error, accept, cancel, help, rpc } = useDialog<
    ApplyPatchDialogParamsDto,
    ApplyPatchDialogResultDto
  >();
  const [params, setParams] = useState<ApplyPatchDialogParamsDto | undefined>(undefined);
  const [shown, setShown] = useState<ReadonlySet<Shown>>(() => new Set());
  const [threeWay, setThreeWay] = useState(true);
  const [reverse, setReverse] = useState(false);
  const [pDepth, setPDepth] = useState(1);
  const [whitespaceFix, setWhitespaceFix] = useState(false);
  const [contentOnly, setContentOnly] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (init) setParams(init.params);
  }, [init]);

  const argv = useMemo(
    () =>
      params
        ? previewArgs(params, { threeWay, reverse, pDepth, whitespaceFix, contentOnly })
        : [],
    [contentOnly, pDepth, params, reverse, threeWay, whitespaceFix],
  );

  if (error !== undefined) return <div className="gt-dialog-unknown">{error}</div>;
  if (!params) return <div className="gt-dialog-unknown">Loading…</div>;

  const chooseFile = (): void => {
    setBusy(true);
    rpc
      .request<ApplyPatchDialogParamsDto>(PATCH_DIALOG_METHODS.choose)
      .then(
        (next) => setParams(next),
        () => undefined,
      )
      .finally(() => setBusy(false));
  };

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
    if (key === 'reverse') setReverse(false);
    else if (key === 'pDepth') setPDepth(1);
    else if (key === 'whitespace') setWhitespaceFix(false);
    else setContentOnly(false);
  };

  const modify: ModifyOption[] = [
    { id: 'reverse', label: 'Reverse the patch', flag: '--reverse', checked: shown.has('reverse') },
    { id: 'pDepth', label: 'Strip path components', flag: '-p<n>', checked: shown.has('pDepth') },
    {
      id: 'whitespace',
      label: 'Fix whitespace errors',
      flag: '--whitespace=fix',
      checked: shown.has('whitespace'),
    },
    {
      id: 'contentOnly',
      label: 'Apply as content, not commits',
      flag: 'skip git am',
      checked: shown.has('contentOnly'),
      disabled: !params.isMailbox,
    },
  ];

  const totalHunks = params.summary.reduce((n, f) => n + f.hunks, 0);
  const missing = params.summary.filter((f) => f.missing);
  const canApply = params.patchPath.length > 0 && params.error === undefined && !busy;

  return (
    <Dialog
      title={`Apply Patch — ${params.repoLabel}`}
      onCancel={cancel}
      onHelp={help}
      onAction={(id) => {
        if (id === 'cancel') cancel();
        else if (id === 'apply' && canApply) {
          accept({
            patchPath: params.patchPath,
            threeWay,
            reverse,
            pDepth,
            whitespaceFix,
            contentOnly,
          });
        }
      }}
      buttons={[
        { id: 'apply', label: 'Apply', variant: 'default', disabled: !canApply },
        { id: 'cancel', label: 'Cancel', variant: 'secondary' },
      ]}
      className="gt-op-dialog"
    >
      <div className="gt-op-row">
        <label htmlFor="patch-path">Patch file:</label>
        <input
          id="patch-path"
          className="gt-input gt-ref-expression"
          data-testid="patch-path"
          readOnly
          value={params.patchPath}
          placeholder="Choose a .patch or .diff file"
        />
        <button type="button" className="gt-button" data-testid="patch-choose" onClick={chooseFile}>
          Choose…
        </button>
      </div>

      {params.error !== undefined ? (
        <div className="gt-modify-options-errors" data-testid="patch-error">
          {params.error}
        </div>
      ) : params.summary.length > 0 ? (
        <>
          <div className="gt-muted" data-testid="patch-summary">
            {params.summary.length} file{params.summary.length === 1 ? '' : 's'} · {totalHunks} hunk
            {totalHunks === 1 ? '' : 's'}
            {params.isMailbox ? ' · mailbox patch (replays as commits)' : ''}
          </div>
          <ul className="gt-patch-list" data-testid="patch-files">
            {params.summary.map((f) => (
              <li key={f.relPath} className={f.missing ? 'gt-patch-missing' : undefined}>
                <code>{f.relPath}</code>
                <span className="gt-muted">
                  {' '}
                  {f.status} · {f.hunks} hunk{f.hunks === 1 ? '' : 's'}
                  {f.missing ? ' · not in the working tree' : ''}
                </span>
              </li>
            ))}
          </ul>
          {missing.length > 0 ? (
            <div className="gt-modify-options-errors" data-testid="patch-missing">
              {missing.length} file{missing.length === 1 ? '' : 's'} the patch edits{' '}
              {missing.length === 1 ? 'is' : 'are'} missing here — those hunks will be rejected.
            </div>
          ) : null}
        </>
      ) : null}

      <ModifyOptions options={modify} onToggle={toggleShown}>
        <OptionCheckbox
          id="patch-3way"
          label="Fall back to a three-way merge"
          flag="--3way"
          checked={threeWay}
          onChange={setThreeWay}
        />
        {shown.has('reverse') ? (
          <OptionCheckbox
            id="patch-reverse"
            label="Undo a previously applied patch"
            flag="--reverse"
            checked={reverse}
            onChange={setReverse}
          />
        ) : null}
        {shown.has('pDepth') ? (
          <div className="gt-op-row">
            <label htmlFor="patch-p">Strip components:</label>
            <input
              id="patch-p"
              className="gt-input"
              data-testid="patch-p"
              type="number"
              min={0}
              max={9}
              value={pDepth}
              onChange={(e) => setPDepth(Number(e.currentTarget.value) || 0)}
            />
          </div>
        ) : null}
        {shown.has('whitespace') ? (
          <OptionCheckbox
            id="patch-whitespace"
            label="Fix whitespace errors while applying"
            flag="--whitespace=fix"
            checked={whitespaceFix}
            onChange={setWhitespaceFix}
          />
        ) : null}
        {shown.has('contentOnly') ? (
          <OptionCheckbox
            id="patch-content-only"
            label="Apply the changes without replaying the commits"
            checked={contentOnly}
            disabled={!params.isMailbox}
            onChange={setContentOnly}
          />
        ) : null}
      </ModifyOptions>

      <WillRun show={params.showCommandLine} text={formatGitCommand(argv)} />
    </Dialog>
  );
}
