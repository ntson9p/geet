import { describe, expect, it } from 'vitest';
import {
  changeAt,
  computeChanges,
  nextChange,
  originalLinesOf,
  prevChange,
  toChanges,
} from '../../../src/scm/gutter/changeModel';
import type { LineChange } from '../../../src/core/patch/patchBuilder';

/** Shorthand for the shape the model reports, minus the source LineChange. */
const rows = (text: string, mod: string) =>
  computeChanges(text, mod).map((c) => `${c.kind} ${c.startLine}-${c.endLine}`);

const L = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join('\n') + '\n';

describe('changeModel — conversion to editor space', () => {
  it('reports an insertion over the lines it added', () => {
    // 5 lines, two inserted after line 2 → 0-based rows 2..3.
    const base = L(5);
    const mod = 'line 1\nline 2\nNEW A\nNEW B\nline 3\nline 4\nline 5\n';
    expect(rows(base, mod)).toEqual(['added 2-3']);
  });

  it('reports a modification over the modified lines only', () => {
    const base = L(5);
    const mod = base.replace('line 3', 'line 3 CHANGED');
    expect(rows(base, mod)).toEqual(['modified 2-2']);
  });

  it('anchors a deletion to the line that now follows it', () => {
    // Delete lines 3 and 4; line 5 becomes 0-based row 2.
    const base = L(5);
    const mod = 'line 1\nline 2\nline 5\n';
    expect(rows(base, mod)).toEqual(['deleted 2-2']);
  });

  it('anchors a deletion at the top of the file to line 0', () => {
    const base = L(4);
    const mod = 'line 3\nline 4\n';
    expect(rows(base, mod)).toEqual(['deleted 0-0']);
  });

  it('handles an empty original as one insertion covering every line', () => {
    expect(rows('', 'a\nb\nc\n')).toEqual(['added 0-2']);
  });

  it('handles an emptied file as a single deletion anchored at the top', () => {
    expect(rows(L(3), '')).toEqual(['deleted 0-0']);
  });

  it('reports nothing for identical text', () => {
    expect(rows(L(6), L(6))).toEqual([]);
  });

  it('keeps adjacent changes distinct rather than merging them', () => {
    const base = L(6);
    const mod = base.replace('line 2', 'X').replace('line 4', 'Y');
    expect(rows(base, mod)).toEqual(['modified 1-1', 'modified 3-3']);
  });

  it('treats a missing trailing newline as a change, not as nothing', () => {
    expect(rows('a\nb\n', 'a\nb')).not.toEqual([]);
  });

  it('never emits a range whose end precedes its start', () => {
    const odd: LineChange[] = [
      { originalStartLineNumber: 3, originalEndLineNumber: 0, modifiedStartLineNumber: 4, modifiedEndLineNumber: 2 },
    ];
    for (const c of toChanges(odd)) expect(c.endLine).toBeGreaterThanOrEqual(c.startLine);
  });
});

describe('changeModel — navigation', () => {
  const base = L(20);
  const mod = base.replace('line 3', 'A').replace('line 10', 'B').replace('line 17', 'C');
  const changes = computeChanges(base, mod); // rows 2, 9, 16

  it('finds the change under a line, and nothing between changes', () => {
    expect(changeAt(changes, 2)?.startLine).toBe(2);
    expect(changeAt(changes, 5)).toBeUndefined();
  });

  it('walks forward through every change and then stops', () => {
    const seen: number[] = [];
    let line = -1;
    for (;;) {
      const n = nextChange(changes, line);
      if (!n) break;
      seen.push(n.startLine);
      line = n.startLine;
    }
    expect(seen).toEqual([2, 9, 16]);
  });

  it('does NOT wrap at the last change — that is the whole point of T7', () => {
    expect(nextChange(changes, 16)).toBeUndefined();
    expect(nextChange(changes, 999)).toBeUndefined();
  });

  it('walks backward and stops at the first change', () => {
    expect(prevChange(changes, 16)?.startLine).toBe(9);
    expect(prevChange(changes, 9)?.startLine).toBe(2);
    expect(prevChange(changes, 2)).toBeUndefined();
  });

  it('is exact about strictness: a line inside a change is not its own next', () => {
    expect(nextChange(changes, 2)?.startLine).toBe(9);
  });
});

describe('changeModel — original text for the popup', () => {
  it('returns the replaced lines for a modification', () => {
    const base = L(5);
    const mod = base.replace('line 3', 'line 3 CHANGED');
    const c = computeChanges(base, mod)[0]!;
    expect(originalLinesOf(base, c)).toEqual(['line 3']);
  });

  it('returns the removed lines for a deletion', () => {
    const base = L(5);
    const mod = 'line 1\nline 2\nline 5\n';
    const c = computeChanges(base, mod)[0]!;
    expect(originalLinesOf(base, c)).toEqual(['line 3', 'line 4']);
  });

  it('returns nothing for an insertion — there was no original text', () => {
    const base = L(3);
    const mod = 'line 1\nNEW\nline 2\nline 3\n';
    const c = computeChanges(base, mod)[0]!;
    expect(originalLinesOf(base, c)).toEqual([]);
  });

  it('does not report a phantom blank line for a whole-file deletion', () => {
    const base = L(3);
    const c = computeChanges(base, '')[0]!;
    expect(originalLinesOf(base, c)).toEqual(['line 1', 'line 2', 'line 3']);
  });
});
