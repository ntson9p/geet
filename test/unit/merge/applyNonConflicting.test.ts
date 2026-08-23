import { describe, expect, it } from 'vitest';
import {
  applyNonConflicting,
  countMerge,
  mergeStatusText,
  nonConflictingSide,
  sideResolution,
} from '../../../src/merge/applyNonConflicting';
import type { ConflictBlock } from '../../../src/merge/mergeCompute';

/**
 * P13-T8 · §3.5. The magic wand only ever implemented "All"; these pin the
 * one-sided applies and the live counter that IntelliJ's toolbar shows.
 */

const OPTS = { whitespace: true };

let nextId = 1;
const block = (base: string[], ours: string[], theirs: string[]): ConflictBlock => ({
  id: nextId++,
  base,
  ours,
  theirs,
});

/** Only the left side moved. */
const leftOnly = (): ConflictBlock => block(['base\n'], ['mine\n'], ['base\n']);
/** Only the right side moved. */
const rightOnly = (): ConflictBlock => block(['base\n'], ['base\n'], ['theirs\n']);
/** Both made the same change. */
const identical = (): ConflictBlock => block(['base\n'], ['same\n'], ['same\n']);
/** A genuine conflict: both sides changed the same line differently. */
const realConflict = (): ConflictBlock => block(['base\n'], ['mine\n'], ['theirs\n']);

describe('nonConflictingSide', () => {
  it('names the side that moved', () => {
    expect(nonConflictingSide(leftOnly())).toBe('left');
    expect(nonConflictingSide(rightOnly())).toBe('right');
  });

  it('calls an identical change "both"', () => {
    expect(nonConflictingSide(identical())).toBe('both');
  });

  it('is undefined for a genuine conflict', () => {
    expect(nonConflictingSide(realConflict())).toBeUndefined();
  });
});

describe('sideResolution', () => {
  it('takes our lines for a left-only change, and only from the left', () => {
    expect(sideResolution(leftOnly(), 'left')).toEqual(['mine\n']);
    expect(sideResolution(leftOnly(), 'right')).toBeUndefined();
  });

  it('takes their lines for a right-only change, and only from the right', () => {
    expect(sideResolution(rightOnly(), 'right')).toEqual(['theirs\n']);
    expect(sideResolution(rightOnly(), 'left')).toBeUndefined();
  });

  it('resolves an identical change from either side, to the same content', () => {
    expect(sideResolution(identical(), 'left')).toEqual(['same\n']);
    expect(sideResolution(identical(), 'right')).toEqual(['same\n']);
  });

  it('never resolves a genuine conflict', () => {
    expect(sideResolution(realConflict(), 'left')).toBeUndefined();
    expect(sideResolution(realConflict(), 'right')).toBeUndefined();
  });
});

describe('applyNonConflicting', () => {
  const run = (side: 'left' | 'all' | 'right', blocks: ConflictBlock[]) => {
    const applied: Array<{ id: number; lines: string[] }> = [];
    const outcome = applyNonConflicting(blocks, side, OPTS, (b, lines) => {
      b.resolution = 'auto';
      b.resolvedLines = lines;
      applied.push({ id: b.id, lines });
    });
    return { outcome, applied };
  };

  it('Left applies only left-side changes and leaves right-side ones pending', () => {
    const left = leftOnly();
    const right = rightOnly();
    const conflict = realConflict();
    const { outcome } = run('left', [left, right, conflict]);

    expect(left.resolution).toBe('auto');
    expect(left.resolvedLines).toEqual(['mine\n']);
    // The acceptance line: the right-side change is still pending.
    expect(right.resolution).toBeUndefined();
    expect(conflict.resolution).toBeUndefined();
    expect(outcome.applied).toBe(1);
    expect(outcome.remaining).toBe(2);
  });

  it('Right is the mirror image', () => {
    const left = leftOnly();
    const right = rightOnly();
    const { outcome } = run('right', [left, right]);
    expect(right.resolvedLines).toEqual(['theirs\n']);
    expect(left.resolution).toBeUndefined();
    expect(outcome.applied).toBe(1);
  });

  it('All resolves both sides, and the wand rules a one-sided apply must not use', () => {
    // A disjoint interleave: both sides edited different lines of the base.
    const interleave = block(
      ['a\n', 'b\n', 'c\n'],
      ['A\n', 'b\n', 'c\n'],
      ['a\n', 'b\n', 'C\n'],
    );
    expect(sideResolution(interleave, 'left')).toBeUndefined();
    expect(sideResolution(interleave, 'right')).toBeUndefined();

    const { outcome } = run('all', [leftOnly(), rightOnly(), interleave, realConflict()]);
    expect(outcome.applied).toBe(3);
    expect(outcome.remaining).toBe(1);
    expect(interleave.resolution).toBe('auto');
  });

  it('Left then Right together settle everything All would, minus the two-sided rules', () => {
    const blocks = [leftOnly(), rightOnly(), identical(), realConflict()];
    run('left', blocks);
    const after = run('right', blocks);
    expect(after.outcome.remaining).toBe(1); // only the genuine conflict
  });

  it('never re-applies an already-resolved block', () => {
    const left = leftOnly();
    left.resolution = 'ours';
    const { outcome } = run('left', [left]);
    expect(outcome.applied).toBe(0);
  });

  it('applies nothing when there is nothing one-sided', () => {
    expect(run('left', [realConflict()]).outcome.applied).toBe(0);
    expect(run('right', [realConflict()]).outcome.applied).toBe(0);
  });
});

describe('countMerge', () => {
  it('splits resolvable changes from genuine conflicts', () => {
    const counts = countMerge([leftOnly(), rightOnly(), realConflict()], OPTS);
    expect(counts).toEqual({ changes: 2, conflicts: 1, left: 1, right: 1 });
  });

  it('counts an identical change on both sides', () => {
    const counts = countMerge([identical()], OPTS);
    expect(counts.left).toBe(1);
    expect(counts.right).toBe(1);
    expect(counts.changes).toBe(1);
  });

  it('ignores resolved blocks', () => {
    const left = leftOnly();
    left.resolution = 'ours';
    expect(countMerge([left, realConflict()], OPTS)).toEqual({
      changes: 0,
      conflicts: 1,
      left: 0,
      right: 0,
    });
  });

  it('is all zeroes when everything is resolved', () => {
    const b = leftOnly();
    b.resolution = 'auto';
    expect(countMerge([b], OPTS)).toEqual({ changes: 0, conflicts: 0, left: 0, right: 0 });
  });
});

describe('mergeStatusText', () => {
  it('uses IntelliJ’s wording, singular and plural', () => {
    expect(mergeStatusText({ changes: 0, conflicts: 2, left: 0, right: 0 })).toBe(
      'No changes. 2 conflicts.',
    );
    expect(mergeStatusText({ changes: 0, conflicts: 1, left: 0, right: 0 })).toBe(
      'No changes. 1 conflict.',
    );
    expect(mergeStatusText({ changes: 3, conflicts: 1, left: 0, right: 0 })).toBe(
      '3 changes, 1 conflict.',
    );
    expect(mergeStatusText({ changes: 1, conflicts: 0, left: 0, right: 0 })).toBe(
      '1 change, no conflicts.',
    );
  });

  it('says so when nothing is left', () => {
    expect(mergeStatusText({ changes: 0, conflicts: 0, left: 0, right: 0 })).toBe(
      'All changes applied.',
    );
  });
});
