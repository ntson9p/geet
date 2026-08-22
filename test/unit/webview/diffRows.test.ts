import { describe, expect, it } from 'vitest';
import { applyLineChanges } from '../../../src/core/patch/patchBuilder';
import type { LineChangeDto } from '../../../src/shared/protocol';
import { buildDiffRows, includedLabel, type DiffRow } from '../../../webview-ui/src/lib/diffRows';

/** `left|right` per row, `.` for an absent side — readable alignment assertions. */
function render(rows: readonly DiffRow[]): string[] {
  return rows.map(
    (r) =>
      `${r.left ? `${r.left.lineNumber}:${r.left.text}` : '.'}|${
        r.right ? `${r.right.lineNumber}:${r.right.text}` : '.'
      }${r.changeIndex >= 0 ? ` #${r.changeIndex}${r.first ? '*' : ''}` : ''}`,
  );
}

describe('buildDiffRows', () => {
  it('renders an unchanged file as pure context', () => {
    expect(render(buildDiffRows('a\nb\n', 'a\nb\n', []))).toEqual(['1:a|1:a', '2:b|2:b']);
  });

  it('aligns insertions on the right with an empty left side', () => {
    // The §2A shelve fixture: two lines inserted at different points.
    const changes: LineChangeDto[] = [
      { originalStartLineNumber: 2, originalEndLineNumber: 0, modifiedStartLineNumber: 3, modifiedEndLineNumber: 3 },
      { originalStartLineNumber: 3, originalEndLineNumber: 0, modifiedStartLineNumber: 5, modifiedEndLineNumber: 5 },
    ];
    expect(render(buildDiffRows('abcx\nab\ndef\n', 'abcx\nab\n123\ndef\nxxx\n', changes))).toEqual([
      '1:abcx|1:abcx',
      '2:ab|2:ab',
      '.|3:123 #0*',
      '3:def|4:def',
      '.|5:xxx #1*',
    ]);
  });

  it('aligns deletions on the left with an empty right side', () => {
    const changes: LineChangeDto[] = [
      { originalStartLineNumber: 2, originalEndLineNumber: 3, modifiedStartLineNumber: 1, modifiedEndLineNumber: 0 },
    ];
    expect(render(buildDiffRows('a\nb\nc\nd\n', 'a\nd\n', changes))).toEqual([
      '1:a|1:a',
      '2:b|. #0*',
      '3:c|. #0',
      '4:d|2:d',
    ]);
  });

  it('pairs a modification side by side and marks only its first row', () => {
    const changes: LineChangeDto[] = [
      { originalStartLineNumber: 2, originalEndLineNumber: 3, modifiedStartLineNumber: 2, modifiedEndLineNumber: 3 },
    ];
    expect(render(buildDiffRows('a\nb\nc\n', 'a\nB\nC\n', changes))).toEqual([
      '1:a|1:a',
      '2:b|2:B #0*',
      '3:c|3:C #0',
    ]);
  });

  it('pads the shorter side when a modification changes line count', () => {
    const changes: LineChangeDto[] = [
      { originalStartLineNumber: 2, originalEndLineNumber: 2, modifiedStartLineNumber: 2, modifiedEndLineNumber: 4 },
    ];
    expect(render(buildDiffRows('a\nb\nz\n', 'a\nx\ny\nw\nz\n', changes))).toEqual([
      '1:a|1:a',
      '2:b|2:x #0*',
      '.|3:y #0',
      '.|4:w #0',
      '3:z|5:z',
    ]);
  });

  it('handles a file with no trailing newline', () => {
    const changes: LineChangeDto[] = [
      { originalStartLineNumber: 1, originalEndLineNumber: 1, modifiedStartLineNumber: 1, modifiedEndLineNumber: 1 },
    ];
    expect(render(buildDiffRows('a', 'b', changes))).toEqual(['1:a|1:b #0*']);
  });

  it('handles an empty original (whole file added)', () => {
    const changes: LineChangeDto[] = [
      { originalStartLineNumber: 0, originalEndLineNumber: 0, modifiedStartLineNumber: 1, modifiedEndLineNumber: 2 },
    ];
    expect(render(buildDiffRows('', 'x\ny\n', changes))).toEqual(['.|1:x #0*', '.|2:y #0']);
  });

  it('walks in step with applyLineChanges — every right-hand line is in the result', () => {
    const original = 'a\nb\nc\nd\ne\n';
    const modified = 'a\nB\nc\nQ\nd\ne\n';
    const changes: LineChangeDto[] = [
      { originalStartLineNumber: 2, originalEndLineNumber: 2, modifiedStartLineNumber: 2, modifiedEndLineNumber: 2 },
      { originalStartLineNumber: 3, originalEndLineNumber: 0, modifiedStartLineNumber: 4, modifiedEndLineNumber: 4 },
    ];
    const applied = applyLineChanges(original, modified, changes);
    expect(applied).toBe(modified);
    // Reading the right-hand column top to bottom must reproduce the result the
    // patch machinery writes — otherwise the diff would lie about the commit.
    const right = buildDiffRows(original, modified, changes)
      .map((r) => r.right?.text)
      .filter((t): t is string => t !== undefined);
    expect(right.join('\n') + '\n').toBe(applied);
  });
});

describe('includedLabel', () => {
  it('matches IntelliJ wording, singular and plural', () => {
    expect(includedLabel(2, 0, true)).toBe('2 differences, 0 included');
    expect(includedLabel(1, 1, true)).toBe('1 difference, 1 included');
    expect(includedLabel(2, 0, false)).toBe('2 differences');
  });
});
