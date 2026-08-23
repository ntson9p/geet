import { describe, expect, it } from 'vitest';
import { landingLine, navigationStep, type NavInput } from '../../../src/diff/navigationStep';
import { computeChanges } from '../../../src/scm/gutter/changeModel';

const L = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join('\n') + '\n';
/** Changes at rows 2, 9 and 16. */
const CHANGES = computeChanges(
  L(20),
  L(20).replace('line 3', 'A').replace('line 10', 'B').replace('line 17', 'C'),
);

const step = (o: Partial<NavInput>) =>
  navigationStep({
    changes: CHANGES,
    line: -1,
    direction: 'next',
    index: 0,
    total: 3,
    armed: false,
    ...o,
  });

describe('cross-file change navigation (P14-T7)', () => {
  it('walks every change in the file before considering the next one', () => {
    expect(step({ line: -1 })).toEqual({ kind: 'reveal', line: 2 });
    expect(step({ line: 2 })).toEqual({ kind: 'reveal', line: 9 });
    expect(step({ line: 9 })).toEqual({ kind: 'reveal', line: 16 });
  });

  it('arms at the last change instead of jumping — the whole point', () => {
    // This is exactly where VS Code wraps to the top of the same file.
    expect(step({ line: 16 })).toEqual({ kind: 'arm', toIndex: 1 });
  });

  it('crosses only on the second press, landing on the first change', () => {
    expect(step({ line: 16, armed: true })).toEqual({
      kind: 'cross',
      toIndex: 1,
      landOn: 'first',
    });
  });

  it('never wraps at the end of the last file, armed or not', () => {
    expect(step({ line: 16, index: 2 })).toEqual({ kind: 'end' });
    expect(step({ line: 16, index: 2, armed: true })).toEqual({ kind: 'end' });
  });

  it('mirrors the whole gesture backwards, landing on the previous file last change', () => {
    expect(step({ direction: 'prev', line: 16 })).toEqual({ kind: 'reveal', line: 9 });
    expect(step({ direction: 'prev', line: 2, index: 1 })).toEqual({ kind: 'arm', toIndex: 0 });
    expect(step({ direction: 'prev', line: 2, index: 1, armed: true })).toEqual({
      kind: 'cross',
      toIndex: 0,
      landOn: 'last',
    });
    // Backwards out of the first file has nowhere to go.
    expect(step({ direction: 'prev', line: 2, index: 0, armed: true })).toEqual({ kind: 'end' });
  });

  it('arms rather than ending when a file has no changes but a neighbour exists', () => {
    // A rename with no content edit still sits in the sequence.
    expect(step({ changes: [], line: 0, index: 1 })).toEqual({ kind: 'arm', toIndex: 2 });
  });

  it('ends immediately for a single-file sequence with nothing further', () => {
    expect(step({ line: 16, index: 0, total: 1 })).toEqual({ kind: 'end' });
    expect(step({ changes: [], line: 0, index: 0, total: 1 })).toEqual({ kind: 'end' });
  });
});

describe('landing line', () => {
  it('lands on the first change going forwards and the last going backwards', () => {
    expect(landingLine(CHANGES, 'first')).toBe(2);
    expect(landingLine(CHANGES, 'last')).toBe(16);
  });

  it('reports undefined for a file with no changes rather than throwing', () => {
    expect(landingLine([], 'first')).toBeUndefined();
    expect(landingLine([], 'last')).toBeUndefined();
  });
});
