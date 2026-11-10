import { describe, expect, it } from 'vitest';
import {
  conflictsPhrase,
  failureSentence,
  fetchedAgo,
  listNames,
  standing,
  standingAsFetched,
  summarizeProjectUpdate,
  type RepoUpdateResult,
} from '../../../src/scm/dialogs/updateReport';

/**
 * POST-P14aw — the words of Update Project across a project: what each
 * repository's line in the question says once fetched, and the one summary of
 * a run that no longer stops at the first repository that fails.
 */
describe('listNames', () => {
  it('joins names the way a sentence does', () => {
    expect(listNames([])).toBe('');
    expect(listNames(['a'])).toBe('a');
    expect(listNames(['a', 'b'])).toBe('a and b');
    expect(listNames(['a', 'b', 'c'])).toBe('a, b and c');
    expect(listNames(['a', 'b', 'c', 'd'])).toBe('a, b, c and d');
  });

  it('counts the rest past the limit', () => {
    expect(listNames(['a', 'b', 'c', 'd', 'e', 'f'])).toBe('a, b, c and 3 more');
    expect(listNames(['a', 'b', 'c', 'd'], 3)).toBe('a, b and 2 more');
  });
});

describe('standing', () => {
  it("says what there is to pull and to push, in the Branches panel's words", () => {
    expect(standing('main', 'origin/main', 3, 0)).toBe('main ← origin/main · 3 to pull');
    expect(standing('main', 'origin/main', 3, 1)).toBe('main ← origin/main · 3 to pull · 1 to push');
    expect(standing('main', 'origin/main', 0, 2)).toBe('main ← origin/main · 2 to push');
  });

  it('says up to date when there is neither', () => {
    expect(standing('feature/x', 'origin/feature/x', 0, 0)).toBe('feature/x ← origin/feature/x · up to date');
  });
});

/**
 * POST-P14bm — Update Project Without Fetching works from the last fetch, so
 * it says how old that is.
 */
describe('fetchedAgo', () => {
  const NOW = Date.UTC(2026, 10, 10, 12, 0, 0);
  const MIN = 60_000;
  const HOUR = 60 * MIN;
  const DAY = 24 * HOUR;

  it('says just now under a minute, and for a clock that runs behind the fetch', () => {
    expect(fetchedAgo(NOW, NOW)).toBe('just now');
    expect(fetchedAgo(NOW - 59_000, NOW)).toBe('just now');
    expect(fetchedAgo(NOW + 5 * MIN, NOW)).toBe('just now');
  });

  it('counts minutes, then hours, then days', () => {
    expect(fetchedAgo(NOW - MIN, NOW)).toBe('1 minute ago');
    expect(fetchedAgo(NOW - 59 * MIN, NOW)).toBe('59 minutes ago');
    expect(fetchedAgo(NOW - HOUR, NOW)).toBe('1 hour ago');
    expect(fetchedAgo(NOW - 23 * HOUR - 59 * MIN, NOW)).toBe('23 hours ago');
    expect(fetchedAgo(NOW - DAY, NOW)).toBe('1 day ago');
    expect(fetchedAgo(NOW - 59 * DAY, NOW)).toBe('59 days ago');
  });

  it('counts months past two of them, and years past two of those', () => {
    expect(fetchedAgo(NOW - 60 * DAY, NOW)).toBe('2 months ago');
    expect(fetchedAgo(NOW - 400 * DAY, NOW)).toBe('13 months ago');
    expect(fetchedAgo(NOW - 800 * DAY, NOW)).toBe('2 years ago');
  });
});

describe('standingAsFetched', () => {
  const NOW = Date.UTC(2026, 10, 10, 12, 0, 0);

  it("adds how long ago the upstream was fetched to the Branches panel's words", () => {
    expect(standingAsFetched('main', 'origin/main', 3, 0, NOW - 2 * 3_600_000, NOW)).toBe(
      'main ← origin/main · 3 to pull · fetched 2 hours ago',
    );
    expect(standingAsFetched('main', 'origin/main', 0, 0, NOW, NOW)).toBe(
      'main ← origin/main · up to date · fetched just now',
    );
  });

  it('leaves the age out when no fetch is known, rather than guess one', () => {
    expect(standingAsFetched('main', 'origin/main', 1, 2, undefined, NOW)).toBe(
      standing('main', 'origin/main', 1, 2),
    );
  });
});

describe('conflictsPhrase', () => {
  it('names up to three files', () => {
    expect(conflictsPhrase(['a.txt'])).toBe('conflicts in a.txt');
    expect(conflictsPhrase(['a.txt', 'src/b.ts'])).toBe('conflicts in a.txt and src/b.ts');
    expect(conflictsPhrase(['a', 'b', 'c'])).toBe('conflicts in a, b and c');
  });

  it('counts more than three, and says only conflicts with none known', () => {
    expect(conflictsPhrase(['a', 'b', 'c', 'd', 'e'])).toBe('conflicts in 5 files');
    expect(conflictsPhrase([])).toBe('conflicts');
  });
});

describe('failureSentence', () => {
  it('says where a fetch failed, and from which remote', () => {
    expect(
      failureSentence({ kind: 'failed', name: 'api', during: 'fetch', reason: 'Could not resolve host: github.com', remote: 'origin' }),
    ).toBe("Couldn't fetch api from origin: Could not resolve host: github.com.");
  });

  it('says what stopped an update, without doubling a full stop', () => {
    expect(
      failureSentence({ kind: 'failed', name: 'web', during: 'update', reason: 'origin/x no longer exists on the remote.' }),
    ).toBe("Couldn't update web: origin/x no longer exists on the remote.");
  });
});

describe('summarizeProjectUpdate', () => {
  const updated = (name: string, commits = 2, files = 3): RepoUpdateResult => ({ kind: 'updated', name, commits, files });
  const upToDate = (name: string): RepoUpdateResult => ({ kind: 'upToDate', name });

  it('totals what came in, and names what had nothing to pull', () => {
    const summary = summarizeProjectUpdate([updated('a', 1, 1), updated('b', 3, 4), upToDate('c')]);
    expect(summary).toEqual({
      kind: 'info',
      message: 'Updated a and b: 4 commits, 5 files changed. c was already up to date.',
      conflicts: false,
      failures: false,
    });
  });

  it('counts the repositories rather than naming more than four', () => {
    const many = ['a', 'b', 'c', 'd', 'e'].map((n) => updated(n, 1, 1));
    expect(summarizeProjectUpdate(many).message).toBe('Updated 5 repositories: 5 commits, 5 files changed.');
  });

  it('says once that everything is up to date', () => {
    expect(summarizeProjectUpdate([upToDate('a'), upToDate('b'), upToDate('c')]).message).toBe(
      'All 3 repositories are already up to date.',
    );
    expect(summarizeProjectUpdate([upToDate('a')]).message).toBe('a is already up to date.');
  });

  it('puts a conflict first, as a warning, and goes on to what was updated', () => {
    const summary = summarizeProjectUpdate([
      updated('a', 2, 2),
      { kind: 'conflicts', name: 'c', operation: 'merge', files: ['a.txt'] },
      updated('d', 2, 2),
      upToDate('e'),
      { kind: 'skipped', name: 'g', reason: 'no upstream branch' },
    ]);
    expect(summary.kind).toBe('warning');
    expect(summary.conflicts).toBe(true);
    expect(summary.failures).toBe(false);
    expect(summary.message).toBe(
      'c: the merge stopped on conflicts in a.txt. Updated a and d: 4 commits, 4 files changed. e was already up to date. Skipped g (no upstream branch).',
    );
  });

  it('names several conflicted repositories together', () => {
    const summary = summarizeProjectUpdate([
      { kind: 'conflicts', name: 'c', operation: 'rebase', files: ['a.txt'] },
      { kind: 'conflicts', name: 'd', operation: 'rebase', files: ['b.txt', 'c.txt'] },
    ]);
    expect(summary.message).toBe('c and d: the rebase stopped on conflicts.');
  });

  it('says why each failure failed, the fetch apart from the update', () => {
    const summary = summarizeProjectUpdate([
      { kind: 'failed', name: 'h', during: 'fetch', reason: 'the remote does not appear to be a git repository', remote: 'origin' },
      { kind: 'failed', name: 'b', during: 'update', reason: 'Your local changes to the following files would be overwritten by merge: notes.txt' },
      updated('a', 1, 1),
    ]);
    expect(summary.kind).toBe('warning');
    expect(summary.failures).toBe(true);
    expect(summary.message).toBe(
      "Couldn't fetch h from origin: the remote does not appear to be a git repository. Couldn't update b: Your local changes to the following files would be overwritten by merge: notes.txt. Updated a: 1 commit, 1 file changed.",
    );
  });

  it('names three failures and counts the rest', () => {
    const failed = ['a', 'b', 'c', 'd', 'e'].map(
      (name): RepoUpdateResult => ({ kind: 'failed', name, during: 'update', reason: 'refused' }),
    );
    const { message } = summarizeProjectUpdate(failed);
    expect(message).toContain("Couldn't update c: refused.");
    expect(message).not.toContain("Couldn't update d");
    expect(message).toContain("2 more couldn't be updated.");
  });

  it('says the rest are up to date, not were, when nothing was updated', () => {
    const { message } = summarizeProjectUpdate([
      { kind: 'failed', name: 'h', during: 'fetch', reason: 'offline' },
      upToDate('a'),
      upToDate('b'),
    ]);
    expect(message).toBe("Couldn't fetch h: offline. a and b are already up to date.");
  });

  it('warns when putting local changes back conflicted, though the update went in', () => {
    const summary = summarizeProjectUpdate([
      { kind: 'updated', name: 'b', commits: 1, files: 1, restoreConflicts: true },
    ]);
    expect(summary.kind).toBe('warning');
    expect(summary.conflicts).toBe(true);
    expect(summary.message).toBe(
      'In b, your local changes conflict with what came in; a copy is kept in the stash. Updated b: 1 commit, 1 file changed.',
    );
  });

  it('says what a Cancel left out', () => {
    const summary = summarizeProjectUpdate([updated('a', 1, 1), { kind: 'notAttempted', name: 'b' }]);
    expect(summary.kind).toBe('warning');
    expect(summary.failures).toBe(true);
    expect(summary.message).toBe('Updated a: 1 commit, 1 file changed. Cancelled before b.');
  });
});

describe('summarizeProjectUpdate without fetching (POST-P14bm)', () => {
  const upToDate = (name: string): RepoUpdateResult => ({ kind: 'upToDate', name });

  it('says up to date with what was last fetched, never plain up to date', () => {
    expect(summarizeProjectUpdate([upToDate('api'), upToDate('web')], { withoutFetch: true }).message).toBe(
      'All 2 repositories are already up to date with what was last fetched.',
    );
    expect(summarizeProjectUpdate([upToDate('api')], { withoutFetch: true }).message).toBe(
      'api is already up to date with what was last fetched.',
    );
  });

  it('beside what it updated, says the rest were, as of the last fetch', () => {
    const summary = summarizeProjectUpdate(
      [{ kind: 'updated', name: 'api', commits: 2, files: 3 }, upToDate('web'), upToDate('docs')],
      { withoutFetch: true },
    );
    expect(summary.message).toBe(
      'Updated api: 2 commits, 3 files changed. web and docs were already up to date with what was last fetched.',
    );
    expect(summary.kind).toBe('info');
  });

  it('counts many as a number, and names a skipped one that was never fetched', () => {
    const many = ['a', 'b', 'c', 'd', 'e'].map(upToDate);
    const summary = summarizeProjectUpdate(
      [
        { kind: 'updated', name: 'api', commits: 1, files: 1 },
        ...many,
        { kind: 'skipped', name: 'web', reason: 'origin/main not fetched yet' },
      ],
      { withoutFetch: true },
    );
    expect(summary.message).toBe(
      'Updated api: 1 commit, 1 file changed. 5 repositories were already up to date with what was last fetched. Skipped web (origin/main not fetched yet).',
    );
  });

  it('words a fetched run exactly as before', () => {
    expect(summarizeProjectUpdate([upToDate('api'), upToDate('web')], { withoutFetch: false }).message).toBe(
      'All 2 repositories are already up to date.',
    );
    expect(summarizeProjectUpdate([upToDate('api'), upToDate('web')]).message).toBe(
      'All 2 repositories are already up to date.',
    );
  });
});
