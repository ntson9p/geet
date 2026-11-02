/**
 * The words of Update Project across a project (POST-P14aw), vscode-free so
 * every combination is unit-testable: where each repository stands once
 * fetched, as the question lists it, and the one summary of the run.
 *
 * The run no longer stops at the first repository that fails. Each one's
 * update is its own merge or rebase in its own repository, so a conflict in one
 * makes the others no less safe to update, and IntelliJ's update carries on
 * too. What that asks of the summary is to say all of it, worst news first.
 */
import { plural } from '../resultMessages';

/** `a`, `a and b`, `a, b and c`; past `max`, `a, b, c and 2 more`. */
export function listNames(names: readonly string[], max = 4): string {
  if (names.length === 0) return '';
  if (names.length === 1) return names[0]!;
  if (names.length > max) {
    return `${names.slice(0, max - 1).join(', ')} and ${names.length - (max - 1)} more`;
  }
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]!}`;
}

/** A sentence, with its full stop: git's own reasons sometimes end in one. */
function sentence(text: string): string {
  return /[.!?]$/u.test(text) ? text : `${text}.`;
}

/**
 * Where a branch stands against its upstream once fetched, in the Branches
 * panel's words: `main ← origin/main · 3 to pull · 1 to push`.
 */
export function standing(branch: string, upstream: string, behind: number, ahead: number): string {
  const parts = [`${branch} ← ${upstream}`];
  if (behind > 0) parts.push(`${behind} to pull`);
  if (ahead > 0) parts.push(`${ahead} to push`);
  if (behind === 0 && ahead === 0) parts.push('up to date');
  return parts.join(' · ');
}

/** `conflicts in a.txt`, `… in a.txt and b.txt`, and past three, `conflicts in 5 files`. */
export function conflictsPhrase(files: readonly string[]): string {
  if (files.length === 0) return 'conflicts';
  if (files.length > 3) return `conflicts in ${files.length} files`;
  return `conflicts in ${listNames(files, 3)}`;
}

/** One repository's part in a project-wide update. */
export type RepoUpdateResult =
  | {
      readonly kind: 'updated';
      readonly name: string;
      readonly commits: number;
      readonly files: number;
      /** Putting the user's own changes back conflicted with what came in. */
      readonly restoreConflicts?: boolean;
    }
  | { readonly kind: 'upToDate'; readonly name: string }
  | {
      readonly kind: 'conflicts';
      readonly name: string;
      readonly operation: 'merge' | 'rebase';
      readonly files: readonly string[];
    }
  | {
      readonly kind: 'failed';
      readonly name: string;
      /** Whether it got as far as fetching. */
      readonly during: 'fetch' | 'update';
      readonly reason: string;
      readonly remote?: string;
    }
  | { readonly kind: 'skipped'; readonly name: string; readonly reason: string }
  /** Cancelled before its turn came. */
  | { readonly kind: 'notAttempted'; readonly name: string };

export interface ProjectUpdateSummary {
  /** A warning whenever something needs looking at. */
  readonly kind: 'info' | 'warning';
  readonly message: string;
  /** Repositories left with conflicts to resolve, the merge's or the put-back changes'. */
  readonly conflicts: boolean;
  /** Something was not updated, because it failed or was cancelled. */
  readonly failures: boolean;
}

/** `Couldn't fetch x from origin: …` or `Couldn't update x: …`. */
export function failureSentence(result: Extract<RepoUpdateResult, { kind: 'failed' }>): string {
  return result.during === 'fetch'
    ? sentence(`Couldn't fetch ${result.name}${result.remote !== undefined ? ` from ${result.remote}` : ''}: ${result.reason}`)
    : sentence(`Couldn't update ${result.name}: ${result.reason}`);
}

/**
 * The one notification for the whole run. Problems come first — the toast
 * shows its first line until it is expanded — then what went through, what had
 * nothing to pull, and what was never in scope.
 */
export function summarizeProjectUpdate(results: readonly RepoUpdateResult[]): ProjectUpdateSummary {
  const of = <K extends RepoUpdateResult['kind']>(kind: K): Array<Extract<RepoUpdateResult, { kind: K }>> =>
    results.filter((r): r is Extract<RepoUpdateResult, { kind: K }> => r.kind === kind);
  const updated = of('updated');
  const upToDate = of('upToDate');
  const conflicted = of('conflicts');
  const failed = of('failed');
  const skipped = of('skipped');
  const notAttempted = of('notAttempted');
  const restored = updated.filter((r) => r.restoreConflicts === true);

  const parts: string[] = [];
  if (conflicted.length === 1) {
    const only = conflicted[0]!;
    parts.push(`${only.name}: the ${only.operation} stopped on ${conflictsPhrase(only.files)}.`);
  } else if (conflicted.length > 1) {
    const operation = conflicted.every((r) => r.operation === 'rebase') ? 'rebase' : 'merge';
    parts.push(`${listNames(conflicted.map((r) => r.name))}: the ${operation} stopped on conflicts.`);
  }
  for (const r of failed.slice(0, 3)) parts.push(failureSentence(r));
  if (failed.length > 3) parts.push(`${failed.length - 3} more couldn't be updated.`);
  if (restored.length > 0) {
    parts.push(
      `In ${listNames(restored.map((r) => r.name))}, your local changes conflict with what came in; a copy is kept in the stash.`,
    );
  }

  if (updated.length > 0) {
    const commits = updated.reduce((n, r) => n + r.commits, 0);
    const files = updated.reduce((n, r) => n + r.files, 0);
    const who =
      updated.length > 4 ? `${updated.length} repositories` : listNames(updated.map((r) => r.name));
    parts.push(
      `Updated ${who}: ${plural(commits, 'commit', 'commits')}, ${plural(files, 'file', 'files')} changed.`,
    );
  }
  if (upToDate.length > 0) {
    const nothingElse = upToDate.length === results.length - skipped.length;
    // Beside what was just updated, the rest *were* up to date; on their own, they *are*.
    const one = updated.length > 0 ? 'was' : 'is';
    const many = updated.length > 0 ? 'were' : 'are';
    if (nothingElse && upToDate.length > 1) {
      parts.push(`All ${upToDate.length} repositories are already up to date.`);
    } else if (upToDate.length > 4) {
      parts.push(`${upToDate.length} repositories ${many} already up to date.`);
    } else {
      parts.push(`${listNames(upToDate.map((r) => r.name))} ${upToDate.length === 1 ? one : many} already up to date.`);
    }
  }
  if (notAttempted.length > 0) {
    parts.push(`Cancelled before ${listNames(notAttempted.map((r) => r.name))}.`);
  }
  if (skipped.length > 0) {
    parts.push(`Skipped ${listNames(skipped.map((r) => `${r.name} (${r.reason})`))}.`);
  }

  const conflicts = conflicted.length > 0 || restored.length > 0;
  const failures = failed.length > 0 || notAttempted.length > 0;
  return {
    kind: conflicts || failures ? 'warning' : 'info',
    message: parts.join(' '),
    conflicts,
    failures,
  };
}
