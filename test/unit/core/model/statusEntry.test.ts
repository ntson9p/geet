/**
 * POST-QA: which index edits may run through a conflict pause's hold — only
 * once no conflict is left, when they build the commit that ends the pause.
 */
import { describe, expect, it } from 'vitest';
import { noConflictsLeft, type StatusEntry } from '../../../../src/core/model/statusEntry';

const entry = (p: string, kind: StatusEntry['kind'], x = 'M', y = '.'): StatusEntry =>
  ({ kind, path: p, x, y }) as StatusEntry;

describe('noConflictsLeft', () => {
  it('is false while any path is unmerged', () => {
    expect(noConflictsLeft([entry('a.ts', 'ordinary'), entry('c.ts', 'unmerged', 'U', 'U')])).toBe(false);
  });

  it('is true once every conflict is resolved, staged or not', () => {
    expect(
      noConflictsLeft([
        entry('a.ts', 'ordinary'),
        entry('b.ts', 'ordinary', '.', 'M'),
        entry('n.ts', 'untracked', '?', '?'),
        entry('r.ts', 'renamed', 'R'),
      ]),
    ).toBe(true);
    expect(noConflictsLeft([])).toBe(true);
  });
});
