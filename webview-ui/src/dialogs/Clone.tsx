/**
 * Clone dialog (P13-T4): URL + directory + `[ ] Recursive submodules`,
 * `--depth` and `--branch`, with the destination validated as empty *before*
 * the button is pressed. URL entry only — Geet has no provider integrations
 * to enumerate repositories from (deviation D11).
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  CLONE_DIALOG_METHODS,
  type CloneDialogParamsDto,
  type CloneDialogResultDto,
} from '../../../src/shared/protocol';
import { formatGitCommand } from '../../../src/scm/dialogs/commandLine';
import {
  buildCloneArgs,
  EMPTY_CLONE_OPTIONS,
  suggestedDirName,
  validateCloneOptions,
  type CloneOptions,
} from '../../../src/scm/dialogs/cloneArgs';
import { Dialog } from '../lib/Dialog';
import { useDialog } from '../lib/useDialog';
import { ModifyOptions, OptionCheckbox, WillRun, type ModifyOption } from './ModifyOptions';

type Shown = 'depth' | 'branch';

/** Joins with whichever separator the parent already uses. */
function joinPath(parent: string, name: string): string {
  if (parent.length === 0) return name;
  const sep = parent.includes('\\') && !parent.includes('/') ? '\\' : '/';
  return `${parent.replace(/[\\/]+$/u, '')}${sep}${name}`;
}

export function Clone() {
  const { init, error, accept, cancel, help, rpc } = useDialog<
    CloneDialogParamsDto,
    CloneDialogResultDto
  >();
  const [params, setParams] = useState<CloneDialogParamsDto | undefined>(undefined);
  const [options, setOptions] = useState<CloneOptions>(EMPTY_CLONE_OPTIONS);
  const [shown, setShown] = useState<ReadonlySet<Shown>>(() => new Set());
  const [openAfter, setOpenAfter] = useState<'window' | 'add' | 'none'>('window');
  const [dirTouched, setDirTouched] = useState(false);
  const [dirProblem, setDirProblem] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (init) setParams(init.params);
  }, [init]);

  // Re-check the destination whenever it settles — "clone into a non-empty
  // directory is blocked with a clear reason" has to be visible before Apply.
  useEffect(() => {
    const dir = options.directory.trim();
    if (dir.length === 0) {
      setDirProblem(undefined);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      rpc
        .request<{ ok: boolean; reason?: string }>(CLONE_DIALOG_METHODS.checkDirectory, {
          directory: dir,
        })
        .then(
          (res) => {
            if (!cancelled) setDirProblem(res.ok ? undefined : res.reason);
          },
          () => undefined,
        );
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [options.directory, rpc]);

  const setUrl = useCallback(
    (url: string) => {
      setOptions((o) => {
        // Fill the destination from the URL until the user edits it themselves.
        if (dirTouched || params === undefined) return { ...o, url };
        const name = suggestedDirName(url);
        return {
          ...o,
          url,
          directory: name.length > 0 ? joinPath(params.defaultParent, name) : '',
        };
      });
    },
    [dirTouched, params],
  );

  const errors = useMemo(() => validateCloneOptions(options), [options]);
  const argv = useMemo(() => buildCloneArgs(options), [options]);

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
    setOptions((o) => (key === 'depth' ? { ...o, depth: 0 } : { ...o, branch: '' }));
  };

  const modify: ModifyOption[] = [
    { id: 'depth', label: 'Shallow clone', flag: '--depth', checked: shown.has('depth') },
    { id: 'branch', label: 'Clone a specific branch', flag: '--branch', checked: shown.has('branch') },
  ];

  const blocked = errors.length > 0 || dirProblem !== undefined;

  return (
    <Dialog
      title="Clone Repository"
      onCancel={cancel}
      onHelp={help}
      onAction={(id) => {
        if (id === 'cancel') cancel();
        else if (id === 'clone' && !blocked) accept({ options, openAfter });
      }}
      buttons={[
        { id: 'clone', label: 'Clone', variant: 'default', disabled: blocked },
        { id: 'cancel', label: 'Cancel', variant: 'secondary' },
      ]}
      footerLeft={
        <>
          <label htmlFor="clone-open-after">After cloning:</label>
          <select
            id="clone-open-after"
            className="gt-input"
            data-testid="clone-open-after"
            value={openAfter}
            onChange={(e) => {
              const v = e.currentTarget.value;
              setOpenAfter(v === 'add' ? 'add' : v === 'none' ? 'none' : 'window');
            }}
          >
            <option value="window">Open in a new window</option>
            <option value="add">Add to this workspace</option>
            <option value="none">Do nothing</option>
          </select>
        </>
      }
      className="gt-op-dialog"
    >
      <div className="gt-op-row">
        <label htmlFor="clone-url">URL:</label>
        <input
          id="clone-url"
          className="gt-input gt-ref-expression"
          data-testid="clone-url"
          placeholder="https://host/team/repo.git"
          value={options.url}
          onChange={(e) => setUrl(e.currentTarget.value)}
        />
      </div>

      <div className="gt-op-row">
        <label htmlFor="clone-dir">Directory:</label>
        <input
          id="clone-dir"
          className="gt-input gt-ref-expression"
          data-testid="clone-dir"
          value={options.directory}
          onChange={(e) => {
            const next = e.currentTarget.value;
            setDirTouched(true);
            setOptions((o) => ({ ...o, directory: next }));
          }}
        />
        <button
          type="button"
          className="gt-button"
          data-testid="clone-browse"
          onClick={() => {
            void rpc
              .request<{ directory: string }>(CLONE_DIALOG_METHODS.browse)
              .then((res) => {
                if (res.directory.length === 0) return;
                setDirTouched(true);
                setOptions((o) => ({ ...o, directory: res.directory }));
              });
          }}
        >
          Browse…
        </button>
      </div>

      {dirProblem !== undefined ? (
        <div className="gt-modify-options-errors" data-testid="clone-dir-problem">
          {dirProblem}
        </div>
      ) : null}

      <ModifyOptions options={modify} onToggle={toggleShown} conflicts={errors}>
        <OptionCheckbox
          id="clone-submodules"
          label="Clone submodules too"
          flag="--recurse-submodules"
          checked={options.recursiveSubmodules}
          onChange={(v) => setOptions((o) => ({ ...o, recursiveSubmodules: v }))}
        />
        {shown.has('depth') ? (
          <div className="gt-op-row">
            <label htmlFor="clone-depth">Depth:</label>
            <input
              id="clone-depth"
              className="gt-input"
              data-testid="clone-depth"
              type="number"
              min={0}
              value={options.depth}
              onChange={(e) => {
                const next = Number(e.currentTarget.value) || 0;
                setOptions((o) => ({ ...o, depth: next }));
              }}
            />
            <span className="gt-muted">0 = full history</span>
          </div>
        ) : null}
        {shown.has('branch') ? (
          <div className="gt-op-row">
            <label htmlFor="clone-branch">Branch:</label>
            <input
              id="clone-branch"
              className="gt-input gt-ref-expression"
              data-testid="clone-branch"
              placeholder="the remote's default"
              value={options.branch}
              onChange={(e) => {
                const next = e.currentTarget.value;
                setOptions((o) => ({ ...o, branch: next }));
              }}
            />
          </div>
        ) : null}
      </ModifyOptions>

      <WillRun show={params.showCommandLine} text={formatGitCommand(argv)} />
    </Dialog>
  );
}
