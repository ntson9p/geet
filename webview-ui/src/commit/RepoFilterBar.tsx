/**
 * POST-P14ce: the bar over the Commit window's list while the list is narrowed
 * to the repositories picked in the Repositories panel, so the narrowing is
 * seen where commits are made, that panel folded away or not.
 *
 *   [filter] ● api ● web · 3 changes elsewhere                Show all
 *
 * It names the repositories shown, in their colours, or counts them when the
 * names do not fit (`2 of 5 repositories`); then what the list leaves out, as a
 * warning when some of that is ticked, since Commit leaves it out. A name
 * brings the Repositories panel into view on its row; Show all shows every
 * repository again, in both panels. The hover lists what is left out.
 */
import { useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import type { CommitRepoFilterDto } from '../../../src/shared/protocol';
import { useElementSize } from '../lib/useElementSize';
import { filterBarText, namesText } from './repoFilter';

export interface RepoFilterBarProps {
  readonly filter: CommitRepoFilterDto;
  /** With staging a row is in the commit by being staged, and the bar says so. */
  readonly staging: boolean;
  /** A repository's colour: its dot in the Repositories panel. */
  readonly colorOf: (colorIdx: number) => string;
  readonly onShowAll: () => void;
  /** The Repositories panel, with the keyboard on this repository's row. */
  readonly onReveal: (root: string) => void;
  /**
   * POST-P14cf: the list's menu payload (`listContext`): a right-click on the
   * bar opens the menu of the list it narrows.
   */
  readonly menuContext?: string;
}

export function RepoFilterBar({ filter, staging, colorOf, onShowAll, onReveal, menuContext }: RepoFilterBarProps) {
  const text = filterBarText(filter, staging);
  const labels = filter.shown.map((repo) => repo.label);
  const [barRef, bar] = useElementSize<HTMLDivElement>();
  // The bar as it would be with every name in it, drawn unseen: what it needs.
  const probeRef = useRef<HTMLDivElement | null>(null);
  const [needed, setNeeded] = useState(0);
  const probeKey = `${filter.shown.map((repo) => `${repo.root}\n${repo.label}`).join('\n')}\n${text.rest?.text ?? ''}`;
  useLayoutEffect(() => {
    setNeeded(probeRef.current?.offsetWidth ?? 0);
  }, [probeKey]);
  // One repository is always named, its name cut short if it must be; several
  // are named while every name fits with what is left out, else counted.
  const named = filter.shown.length <= 1 || bar.width === 0 || needed <= bar.width;

  const dot = (colorIdx: number) => (
    <span
      className="gt-commit-filter-dot"
      style={{ '--gt-repo': colorOf(colorIdx) } as CSSProperties}
      aria-hidden="true"
    />
  );
  const rest = (probe: boolean) =>
    text.rest !== undefined ? (
      <span
        className={`gt-commit-filter-rest${text.rest.warn ? ' gt-warn' : ''}`}
        {...(probe ? {} : { 'data-testid': 'commit-filter-rest' })}
      >
        · {text.rest.text}
      </span>
    ) : null;

  return (
    <div
      className="gt-commit-filter"
      role="group"
      aria-label={text.label}
      title={text.title}
      data-testid="commit-filter"
      data-vscode-context={menuContext}
      ref={barRef}
    >
      <span className="codicon codicon-filter gt-commit-filter-icon" aria-hidden="true" />
      <span className="gt-commit-filter-names">
        {named ? (
          filter.shown.map((repo) => (
            <button
              key={repo.root}
              type="button"
              className="gt-commit-filter-repo"
              title={`Show ${repo.label} in the Repositories panel`}
              data-testid="commit-filter-repo"
              onClick={() => onReveal(repo.root)}
            >
              {dot(repo.colorIdx)}
              <span className="gt-commit-filter-name">{repo.label}</span>
            </button>
          ))
        ) : (
          <button
            type="button"
            className="gt-commit-filter-repo"
            title={`Show ${namesText(labels)} in the Repositories panel`}
            data-testid="commit-filter-count"
            onClick={() => {
              const first = filter.shown[0];
              if (first !== undefined) onReveal(first.root);
            }}
          >
            <span className="gt-commit-filter-name">{text.count}</span>
          </button>
        )}
      </span>
      {rest(false)}
      <button
        type="button"
        className="gt-commit-filter-all"
        title="Show every repository"
        aria-label="Show all repositories"
        data-testid="commit-filter-show-all"
        onClick={onShowAll}
      >
        Show all
      </button>
      <div className="gt-commit-filter gt-commit-filter-probe" ref={probeRef} aria-hidden="true">
        <span className="codicon codicon-filter gt-commit-filter-icon" />
        <span className="gt-commit-filter-names">
          {filter.shown.map((repo) => (
            <span key={repo.root} className="gt-commit-filter-repo">
              {dot(repo.colorIdx)}
              <span className="gt-commit-filter-name">{repo.label}</span>
            </span>
          ))}
        </span>
        {rest(true)}
        <span className="gt-commit-filter-all">Show all</span>
      </div>
    </div>
  );
}
