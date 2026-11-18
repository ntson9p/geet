/**
 * The Branches panel's `@` (POST-P14co): typed in its filter, an `@` opens a
 * list of the repositories, each with a square checkbox, and what follows it
 * narrows that list by name. A tick picks a repository: the side bar's one pick
 * (`reposInView.ts`), which the Repositories panel highlights, the filter's pill
 * names and the Commit window follows. None ticked is every repository, as no
 * pill is; the list's first row, *All repositories*, says so and goes back to it.
 *
 * Pure: the filter's text and caret in; the mention, the rows and the next pick out.
 */
import type { BranchPanelRepoDto } from '../../../src/shared/protocol';
import { matchRanges, queryTokens, scopeReposOf } from './model';

/** The `@` the caret is after, and what was typed since: the picker's query. */
export interface Mention {
  /** Where the `@` is. */
  readonly start: number;
  /** Just past what was typed after it: the caret. */
  readonly end: number;
  /** What follows the `@`, up to the caret. */
  readonly query: string;
}

/**
 * The mention the caret is in: from an `@` that starts the text or follows a
 * space, up to the caret. A repository's name can hold spaces (`local - Copy`),
 * so the mention runs on over them; it ends where the caret is, and the
 * picker takes it out of the filter when it closes. An `@` inside a word
 * (`user@host`) is part of what is searched for, as before.
 */
export function mentionAt(text: string, caret: number | null | undefined): Mention | undefined {
  const end = Math.max(0, Math.min(caret ?? text.length, text.length));
  for (let at = end - 1; at >= 0; at--) {
    if (text[at] !== '@') continue;
    if (at > 0 && !/\s/u.test(text[at - 1]!)) continue;
    return { start: at, end, query: text.slice(at + 1, end) };
  }
  return undefined;
}

/** The filter's text without the mention: what the branches are filtered by. */
export function withoutMention(text: string, mention: Mention | undefined): string {
  return mention === undefined ? text : text.slice(0, mention.start) + text.slice(mention.end);
}

export type PickerRow =
  | {
      /** Every repository, which none ticked is: clears the pick. */
      readonly kind: 'all';
      readonly id: 'all';
      readonly ticked: boolean;
    }
  | {
      readonly kind: 'repo';
      readonly id: string;
      readonly repo: BranchPanelRepoDto;
      /** Picked: its branches are listed. Never while every repository is. */
      readonly ticked: boolean;
      /** Marked ranges of its name, for what was typed after the `@`. */
      readonly highlights: ReadonlyArray<readonly [number, number]>;
    };

/**
 * The picker's rows: *All repositories* while nothing is typed after the `@`,
 * then every repository whose name has each typed word, in the Repositories
 * panel's order. Ticked are the ones picked, and *All repositories* while
 * none is.
 */
export function pickerRows(
  repos: readonly BranchPanelRepoDto[],
  scope: readonly string[],
  query: string,
): PickerRow[] {
  const inView = new Set(scopeReposOf(repos, scope).map((r) => r.root));
  const narrowed = inView.size < repos.length;
  const tokens = queryTokens(query);
  const rows: PickerRow[] = [];
  if (tokens.length === 0) rows.push({ kind: 'all', id: 'all', ticked: !narrowed });
  for (const repo of repos) {
    const highlights = matchRanges(repo.label, tokens);
    if (highlights === undefined) continue;
    rows.push({
      kind: 'repo',
      id: `pick:${repo.root}`,
      repo,
      ticked: narrowed && inView.has(repo.root),
      highlights,
    });
  }
  return rows;
}

/**
 * The pick once `root`'s box is ticked or unticked. Ticked while every
 * repository is shown, it is the only one; unticking the last picked one, or
 * ticking the last not picked, shows every repository again, which is no pick.
 */
export function pickToggled(
  repos: readonly BranchPanelRepoDto[],
  scope: readonly string[],
  root: string,
): string[] {
  const inView = scopeReposOf(repos, scope).map((r) => r.root);
  const picked = inView.length < repos.length ? inView : [];
  const next = picked.includes(root) ? picked.filter((r) => r !== root) : [...picked, root];
  return next.length >= repos.length ? [] : next;
}
