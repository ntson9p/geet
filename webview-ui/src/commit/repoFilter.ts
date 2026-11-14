/**
 * POST-P14ce: what the Commit window says while its list is narrowed to the
 * repositories picked in the Repositories panel — the filter bar over the list,
 * and the list when those repositories have nothing to commit. Pure, so every
 * wording is unit-tested.
 */
import type { CommitFilterRepoDto, CommitRepoFilterDto } from '../../../src/shared/protocol';

/** The hover names this many of the repositories left out, and counts the rest. */
export const HOVER_LISTED = 10;

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

function total(repos: readonly CommitFilterRepoDto[], of: 'changes' | 'ticked'): number {
  return repos.reduce((n, repo) => n + repo[of], 0);
}

/** `api`, `api and web`, `api, web and docs`; `or` for a list of which none has something. */
export function namesText(names: readonly string[], joiner: 'and' | 'or' = 'and'): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} ${joiner} ${names[names.length - 1]}`;
}

export interface FilterBarText {
  /** Stands for the names where they do not fit: `2 of 5 repositories`. */
  readonly count: string;
  /**
   * After the names, what the list leaves out: `3 changes elsewhere`, or, when
   * some of it is ticked, `5 ticked elsewhere`, to be drawn as a warning. None
   * when the repositories left out have nothing.
   */
  readonly rest?: { readonly text: string; readonly warn: boolean };
  /** The bar's hover: what it shows, what it leaves out, and what that means for a commit. */
  readonly title: string;
  /** What a screen reader hears of the bar. */
  readonly label: string;
}

/** `staging`: a row is in the commit by being staged, so the bar says *staged* for *ticked*. */
export function filterBarText(filter: CommitRepoFilterDto, staging: boolean): FilterBarText {
  const shown = filter.shown.map((repo) => repo.label);
  const changes = total(filter.hidden, 'changes');
  const ticked = total(filter.hidden, 'ticked');
  const tick = staging ? 'staged' : 'ticked';
  const rest =
    ticked > 0
      ? { text: `${ticked} ${tick} elsewhere`, warn: true }
      : changes > 0
        ? { text: `${plural(changes, 'change', 'changes')} elsewhere`, warn: false }
        : undefined;
  const showing = `Showing ${namesText(shown)} only.`;
  const listed = filter.hidden.slice(0, HOVER_LISTED).map((repo) => {
    if (repo.changes === 0) return `${repo.label}, no changes`;
    const what = plural(repo.changes, 'change', 'changes');
    return repo.ticked > 0 ? `${repo.label}, ${what}, ${repo.ticked} ${tick}` : `${repo.label}, ${what}`;
  });
  const more = filter.hidden.length - listed.length;
  const notShown = listed.length > 0 ? ` Not shown: ${listed.join('; ')}${more > 0 ? `; and ${more} more` : ''}.` : '';
  const kept =
    ticked > 0
      ? ` ${staging ? 'Staged' : 'Ticked'} changes out of view stay ${tick}, and are not committed until shown.`
      : '';
  return {
    count: `${shown.length} of ${shown.length + filter.hidden.length} repositories`,
    ...(rest !== undefined ? { rest } : {}),
    title: `${showing}${notShown}${kept}`,
    label: rest !== undefined ? `${showing} ${rest.text[0]?.toUpperCase() ?? ''}${rest.text.slice(1)}.` : showing,
  };
}

export interface FilterEmptyText {
  /** `No changes in docs.` */
  readonly text: string;
  /** What the repositories left out have, beside the way to show them: `9 changes`. None: nothing to show. */
  readonly elsewhere?: string;
}

/**
 * The list when the repositories it shows have nothing to commit: which they
 * are, and, when the others have something, how much, beside Show all. With
 * nothing anywhere it is the window's plain `No changes.`
 */
export function filterEmptyText(filter: CommitRepoFilterDto): FilterEmptyText {
  const changes = total(filter.hidden, 'changes');
  if (changes === 0) return { text: 'No changes.' };
  const shown = filter.shown.map((repo) => repo.label);
  const where = shown.length <= 2 ? namesText(shown, 'or') : `the ${shown.length} repositories shown`;
  return { text: `No changes in ${where}.`, elsewhere: plural(changes, 'change', 'changes') };
}
