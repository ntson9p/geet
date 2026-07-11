import { describe, expect, it } from 'vitest';
import {
  addedLineNumbers,
  computeLineChanges,
  modifiedRanges,
} from '../../../../src/core/patch/lineDiff';
import { applyLineChanges } from '../../../../src/core/patch/patchBuilder';

/** The definitive correctness property: apply-all reproduces the target. */
function roundTrip(a: string, b: string): void {
  const changes = computeLineChanges(a, b);
  expect(applyLineChanges(a, b, changes)).toBe(b);
  expect(applyLineChanges(a, b, [])).toBe(a);
}

describe('computeLineChanges basics', () => {
  it('empty ↔ empty and identical texts produce no changes', () => {
    expect(computeLineChanges('', '')).toEqual([]);
    expect(computeLineChanges('a\nb\n', 'a\nb\n')).toEqual([]);
  });

  it('single middle modification', () => {
    const changes = computeLineChanges('one\ntwo\nthree\n', 'one\nTWO\nthree\n');
    expect(changes).toEqual([
      {
        originalStartLineNumber: 2,
        originalEndLineNumber: 2,
        modifiedStartLineNumber: 2,
        modifiedEndLineNumber: 2,
      },
    ]);
    roundTrip('one\ntwo\nthree\n', 'one\nTWO\nthree\n');
  });

  it('pure insertion (top / middle / bottom)', () => {
    roundTrip('a\nb\n', 'new\na\nb\n');
    roundTrip('a\nb\n', 'a\nnew\nb\n');
    roundTrip('a\nb\n', 'a\nb\nnew\n');
    const top = computeLineChanges('a\n', 'x\na\n');
    expect(top[0]).toMatchObject({ originalStartLineNumber: 0, originalEndLineNumber: 0 });
  });

  it('pure deletion', () => {
    roundTrip('a\nb\nc\n', 'a\nc\n');
    const del = computeLineChanges('a\nb\nc\n', 'a\nc\n');
    expect(del[0]).toMatchObject({ originalStartLineNumber: 2, originalEndLineNumber: 2, modifiedEndLineNumber: 0 });
  });

  it('replacement of unequal sizes', () => {
    roundTrip('a\nb\nc\nd\n', 'a\nX\nY\nZ\nQ\nd\n');
    roundTrip('a\nb\nc\nd\ne\n', 'a\nX\ne\n');
  });

  it('multiple separated hunks', () => {
    const a = 'l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\n';
    const b = 'l1\nL2\nl3\nl4\nINS\nl5\nl6\nl8\n';
    roundTrip(a, b);
    const changes = computeLineChanges(a, b);
    expect(changes.length).toBeGreaterThanOrEqual(3);
  });

  it('CRLF and missing trailing newline round-trip', () => {
    roundTrip('a\r\nb\r\n', 'a\r\nB!\r\n');
    roundTrip('a\nb', 'a\nB');
    roundTrip('a\nb\n', 'a\nb');
    roundTrip('a\nb', 'a\nb\n');
  });

  it('whole-file rewrite and empty transitions', () => {
    roundTrip('', 'a\nb\n');
    roundTrip('a\nb\n', '');
    roundTrip('a\nb\nc\n', 'x\ny\n');
  });
});

describe('computeLineChanges fuzz round-trips', () => {
  // Deterministic LCG so failures reproduce.
  let seed = 0x2f6e2b1;
  const rand = (): number => {
    seed = (seed * 48271) % 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const randomText = (maxLines: number): string => {
    const n = Math.floor(rand() * maxLines);
    const lines = Array.from({ length: n }, () =>
      String.fromCharCode(97 + Math.floor(rand() * 6)).repeat(1 + Math.floor(rand() * 3)),
    );
    return lines.join('\n') + (rand() > 0.2 && n > 0 ? '\n' : '');
  };
  const mutate = (text: string): string => {
    const lines = text.length === 0 ? [] : text.split('\n');
    const ops = 1 + Math.floor(rand() * 4);
    for (let i = 0; i < ops; i++) {
      const pos = Math.floor(rand() * (lines.length + 1));
      const r = rand();
      if (r < 0.34) {
        lines.splice(pos, 0, 'ins' + Math.floor(rand() * 10));
      } else if (r < 0.67 && lines.length > 0) {
        lines.splice(Math.min(pos, lines.length - 1), 1);
      } else if (lines.length > 0) {
        lines[Math.min(pos, lines.length - 1)] = 'mod' + Math.floor(rand() * 10);
      }
    }
    return lines.join('\n');
  };

  it('200 random pairs round-trip exactly', () => {
    for (let i = 0; i < 200; i++) {
      const a = randomText(30);
      const b = i % 3 === 0 ? randomText(30) : mutate(a);
      const changes = computeLineChanges(a, b);
      const result = applyLineChanges(a, b, changes);
      expect(result, `case ${i}\nA=${JSON.stringify(a)}\nB=${JSON.stringify(b)}`).toBe(b);
    }
  });
});

describe('range helpers', () => {
  it('modifiedRanges merges adjacent 0-based ranges', () => {
    const changes = computeLineChanges('a\nb\nc\nd\ne\n', 'A\nB\nc\nd\nE\n');
    expect(modifiedRanges(changes)).toEqual([
      [0, 1],
      [4, 4],
    ]);
  });

  it('addedLineNumbers lists modified-side line numbers', () => {
    const changes = computeLineChanges('a\nb\n', 'a\nNEW1\nNEW2\nb\n');
    expect(addedLineNumbers(changes)).toEqual([2, 3]);
  });
});
