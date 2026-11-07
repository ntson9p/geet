import { describe, expect, it } from 'vitest';
import { scrollAnchor } from '../../../webview-ui/src/log/scrollAnchor';

const ROW = 24;
const VIEW = 600;
const shas = Array.from({ length: 100 }, (_, i) => `c${i}`);
const none = (): boolean => false;
const selected =
  (...picked: string[]) =>
  (sha: string): boolean =>
    picked.includes(sha);

describe("scrollAnchor: where the log stands when history moves (IntelliJ's SelectionSnapshot)", () => {
  it('a list on top goes back to the top, so a new commit is the first row on screen', () => {
    expect(scrollAnchor(shas, { scrollTop: 0, height: VIEW }, ROW, none)).toEqual({ kind: 'top' });
  });

  it('is still on top while the first row is only partly scrolled away', () => {
    expect(scrollAnchor(shas, { scrollTop: ROW - 1, height: VIEW }, ROW, none)).toEqual({ kind: 'top' });
  });

  it('on top, a selected row on screen does not hold the list where it was', () => {
    // IntelliJ: `isOnTop && permanentGraphChanged` wins over the selection.
    expect(scrollAnchor(shas, { scrollTop: 0, height: VIEW }, ROW, selected('c3'))).toEqual({ kind: 'top' });
  });

  it('scrolled by a whole row, the list is no longer on top', () => {
    expect(scrollAnchor(shas, { scrollTop: ROW, height: VIEW }, ROW, none)).toEqual({
      kind: 'row',
      sha: 'c1',
      gap: 0,
    });
  });

  it('scrolled, the row under the top edge keeps its distance from it, to the pixel', () => {
    expect(scrollAnchor(shas, { scrollTop: 30 * ROW + 10, height: VIEW }, ROW, none)).toEqual({
      kind: 'row',
      sha: 'c30',
      gap: -10,
    });
  });

  it('the first selected row on screen is the anchor, at its own distance', () => {
    // Rows 30 to 54 are on screen; 40 and 45 are selected, and 40 comes first.
    expect(scrollAnchor(shas, { scrollTop: 30 * ROW, height: VIEW }, ROW, selected('c45', 'c40'))).toEqual({
      kind: 'row',
      sha: 'c40',
      gap: 10 * ROW,
    });
  });

  it('a selection off screen leaves the row under the top edge the anchor', () => {
    expect(scrollAnchor(shas, { scrollTop: 30 * ROW, height: VIEW }, ROW, selected('c10', 'c90'))).toEqual({
      kind: 'row',
      sha: 'c30',
      gap: 0,
    });
  });

  it("a selected row cut off by the bottom edge is on screen; the next one down is not", () => {
    // 600 px from row 30 ends inside row 54 (1296 to 1319); row 55 starts at 1320.
    expect(scrollAnchor(shas, { scrollTop: 30 * ROW, height: VIEW }, ROW, selected('c54'))).toEqual({
      kind: 'row',
      sha: 'c54',
      gap: 24 * ROW,
    });
    expect(scrollAnchor(shas, { scrollTop: 30 * ROW, height: VIEW }, ROW, selected('c55'))).toEqual({
      kind: 'row',
      sha: 'c30',
      gap: 0,
    });
  });

  it('a list scrolled past its last commit (the "Load more" row) anchors on the last commit', () => {
    expect(scrollAnchor(shas.slice(0, 5), { scrollTop: 5 * ROW, height: VIEW }, ROW, none)).toEqual({
      kind: 'row',
      sha: 'c4',
      gap: -ROW,
    });
  });

  it('a list with no rows has nothing to keep', () => {
    expect(scrollAnchor([], { scrollTop: 0, height: VIEW }, ROW, none)).toBeUndefined();
  });
});
