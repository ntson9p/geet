import { describe, expect, it } from 'vitest';
import type { StatusEntry } from '../../../src/core/git/parsers/statusV2';
import { repoBusyReason } from '../../../src/core/model/repoBusy';

/**
 * POST-P14ax — a repository whose mutations the conflict lifecycle holds: an
 * operation across repositories skips it rather than wait there for good.
 */
const unmerged = { kind: 'unmerged', path: 'a.txt' } as unknown as StatusEntry;
const modified = { kind: 'ordinary', path: 'b.txt', x: '.', y: 'M' } as unknown as StatusEntry;

describe('repoBusyReason', () => {
  it('names the operation in progress, a rebase by one word', () => {
    expect(repoBusyReason({ inProgressOp: { kind: 'merge' }, statusEntries: [] } as never)).toBe('a merge is in progress');
    expect(repoBusyReason({ inProgressOp: { kind: 'rebase-interactive' }, statusEntries: [] } as never)).toBe(
      'a rebase is in progress',
    );
    expect(repoBusyReason({ inProgressOp: { kind: 'cherry-pick' }, statusEntries: [unmerged] } as never)).toBe(
      'a cherry-pick is in progress',
    );
  });

  it('counts conflicts with no operation behind them: a stash that did not go back cleanly', () => {
    expect(repoBusyReason({ statusEntries: [modified, unmerged] })).toBe('it has conflicts to resolve');
  });

  it('is nothing for a repository that can take an operation', () => {
    expect(repoBusyReason({ statusEntries: [modified] })).toBeUndefined();
    expect(repoBusyReason({ statusEntries: [] })).toBeUndefined();
  });
});
