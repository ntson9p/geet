/**
 * POST-QA: IntelliJ's `GitUnresolvedMergeCheckProvider` — unresolved conflicts
 * stop a commit, and a merge commit asks before leaving changes out.
 */
import { describe, expect, it } from 'vitest';
import {
  excludedFromMergeCommit,
  hasUnresolvedConflicts,
  pathListDetail,
} from '../../../src/commit/mergeCommitChecks';
import type { StatusEntry } from '../../../src/core/model/statusEntry';

const entry = (p: string, kind: StatusEntry['kind'], x = 'M', y = '.'): StatusEntry =>
  ({ kind, path: p, x, y }) as StatusEntry;

describe('hasUnresolvedConflicts', () => {
  it('is true with any unmerged path, whatever else there is', () => {
    expect(hasUnresolvedConflicts([entry('a.ts', 'ordinary'), entry('b.ts', 'unmerged', 'U', 'U')])).toBe(true);
  });

  it('is false with none, untracked and renamed files included', () => {
    expect(
      hasUnresolvedConflicts([entry('a.ts', 'ordinary'), entry('n.ts', 'untracked', '?', '?'), entry('r.ts', 'renamed', 'R')]),
    ).toBe(false);
    expect(hasUnresolvedConflicts([])).toBe(false);
  });
});

describe('excludedFromMergeCommit', () => {
  const none = (): boolean => false;

  it('lists what is changed but not ticked, once, in order', () => {
    expect(excludedFromMergeCommit(['a.ts', 'b.ts', 'c.ts', 'b.ts'], ['a.ts'], none)).toEqual(['b.ts', 'c.ts']);
  });

  it('is empty when everything is ticked', () => {
    expect(excludedFromMergeCommit(['a.ts', 'src/b.ts'], ['src/b.ts', 'a.ts'], none)).toEqual([]);
  });

  it('never asks about unversioned files', () => {
    expect(excludedFromMergeCommit(['a.ts', 'new.ts'], [], (p) => p === 'new.ts')).toEqual(['a.ts']);
  });

  it('matches a path whichever way its separators lean', () => {
    expect(excludedFromMergeCommit(['src/b.ts'], ['src\\b.ts'], none)).toEqual([]);
  });
});

describe('pathListDetail', () => {
  const more = (n: number): string => `… and ${n} more`;

  it('puts a path on each line', () => {
    expect(pathListDetail(['a.ts', 'b.ts'], more)).toBe('a.ts\nb.ts');
  });

  it('stops at the limit and says how many more there are', () => {
    const paths = Array.from({ length: 13 }, (_, i) => `f${i}.ts`);
    const lines = pathListDetail(paths, more).split('\n');
    expect(lines).toHaveLength(11);
    expect(lines[9]).toBe('f9.ts');
    expect(lines[10]).toBe('… and 3 more');
    expect(pathListDetail(paths, more, 13).split('\n')).toHaveLength(13);
  });
});
