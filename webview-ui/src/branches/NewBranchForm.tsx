/**
 * New Branch, in the panel (new-way-4): one name, a start point, and — with
 * several repositories — which of them get the branch. It replaces a chain of
 * input boxes asked once per repository with one form that says, before you
 * press Create, everything that would make Create fail: a name git would
 * refuse, a name a chosen repository already has, a start point it lacks.
 *
 * The name is cleaned as you type, as IntelliJ's field does: a space becomes
 * `_`, characters git forbids vanish.
 */
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { cleanUpBranchNameOnTyping } from '../../../src/core/git/refName';
import type {
  BranchPanelCreateDto,
  BranchPanelCreateResultDto,
  BranchPanelRepoDto,
} from '../../../src/shared/protocol';
import { eligibleRepos, formProblem, fromText } from './newBranch';
import { Codicon } from './Rows';

export interface NewBranchRequest {
  /** `HEAD`, or the ref the branch starts from. */
  readonly from: string;
  /** The repositories it is offered in, ticked to start with. */
  readonly roots: readonly string[];
  /** A name to start with: what the filter held when "Create branch" was clicked. */
  readonly name?: string;
}

export interface NewBranchFormProps {
  readonly repos: readonly BranchPanelRepoDto[];
  readonly request: NewBranchRequest;
  readonly colorOf: (repo: BranchPanelRepoDto) => string;
  readonly onCreate: (dto: BranchPanelCreateDto) => Promise<BranchPanelCreateResultDto>;
  readonly onClose: () => void;
}

export function NewBranchForm({ repos, request, colorOf, onCreate, onClose }: NewBranchFormProps) {
  const eligible = useMemo(() => eligibleRepos(repos, request.from), [repos, request.from]);
  const [name, setName] = useState(() => cleanUpBranchNameOnTyping(request.name ?? ''));
  const [checkout, setCheckout] = useState(true);
  const [chosenRoots, setChosenRoots] = useState<ReadonlySet<string>>(() => {
    const asked = new Set(request.roots);
    const start = eligible.filter((r) => asked.has(r.root)).map((r) => r.root);
    return new Set(start.length > 0 ? start : eligible.map((r) => r.root));
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const chosen = eligible.filter((r) => chosenRoots.has(r.root));
  const problem = formProblem(name, chosen, checkout, request.from);
  const canCreate = !busy && name.trim().length > 0 && problem === undefined;

  const submit = async (): Promise<void> => {
    if (!canCreate) return;
    setBusy(true);
    setError(undefined);
    try {
      const result = await onCreate({
        name: name.trim(),
        from: request.from,
        roots: chosen.map((r) => r.root),
        checkout,
      });
      if (result.ok) onClose();
      else setError(result.error ?? 'The branch could not be created.');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const message = error ?? problem;
  return (
    <form
      className="gtp-form"
      aria-label="New branch"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <div className="gtp-form-title">
        <Codicon name="git-branch" />
        <span className="gtp-ellipsis">
          New branch from <strong>{fromText(request.from, chosen.length > 0 ? chosen : eligible)}</strong>
        </span>
        <span className="gtp-spacer" />
        <button
          type="button"
          className="gt-toolbar-button gtp-icon-button"
          title="Cancel (Escape)"
          aria-label="Cancel"
          onClick={onClose}
        >
          <Codicon name="close" />
        </button>
      </div>
      <input
        ref={inputRef}
        className="gt-input gtp-form-name"
        type="text"
        value={name}
        placeholder="Branch name, e.g. feature/login"
        aria-label="Branch name"
        aria-invalid={problem !== undefined}
        spellCheck={false}
        onChange={(e) => {
          setName(cleanUpBranchNameOnTyping(e.currentTarget.value));
          setError(undefined);
        }}
      />
      <label className="gtp-check">
        <input type="checkbox" checked={checkout} onChange={(e) => setCheckout(e.currentTarget.checked)} />
        <span>Check it out</span>
      </label>
      {repos.length > 1 ? (
        <div className="gtp-form-repos" role="group" aria-label="Repositories">
          {repos.map((repo) => {
            const can = eligible.includes(repo);
            const on = can && chosenRoots.has(repo.root);
            return (
              <button
                key={repo.root}
                type="button"
                className={`gtp-repo-chip${on ? ' gtp-chip-on' : ''}`}
                disabled={!can}
                aria-pressed={on}
                title={can ? undefined : `${repo.label} has no “${request.from}”`}
                style={{ '--gtp-repo': colorOf(repo) } as CSSProperties}
                onClick={() =>
                  setChosenRoots((prev) => {
                    const next = new Set(prev);
                    if (next.has(repo.root)) next.delete(repo.root);
                    else next.add(repo.root);
                    return next;
                  })
                }
              >
                <span className="gtp-marker" data-state={on ? 'current' : 'has'} />
                {repo.label}
              </button>
            );
          })}
        </div>
      ) : null}
      <div className="gtp-form-footer">
        {message !== undefined ? (
          <span className={`gtp-form-message${error !== undefined ? ' gtp-error' : ''}`} role="alert">
            {message}
          </span>
        ) : (
          <span className="gtp-form-message gtp-info">
            {chosen.length > 1 ? `In ${chosen.length} repositories` : ''}
          </span>
        )}
        <span className="gtp-spacer" />
        <button type="submit" className="gt-button gt-primary" disabled={!canCreate}>
          {busy ? 'Creating…' : 'Create'}
        </button>
      </div>
    </form>
  );
}
