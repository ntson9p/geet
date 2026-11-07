import { describe, expect, it } from 'vitest';
import { listWindow } from '../../../webview-ui/src/lib/listWindow';

describe('listWindow: the rows a VirtualList renders and reports', () => {
  it('at the top: from row 0 to a screenful and the overscan past it', () => {
    // 600 / 24 = 25 rows on screen, plus 6 overscan rows at each end.
    expect(listWindow(0, 600, 24, 1000)).toEqual({ scrollTop: 0, first: 0, last: 37 });
  });

  it('scrolled: the overscan starts above the row under the top edge', () => {
    expect(listWindow(30 * 24 + 10, 600, 24, 1000)).toEqual({ scrollTop: 730, first: 24, last: 61 });
  });

  it('never past the last row', () => {
    expect(listWindow(0, 600, 24, 10)).toEqual({ scrollTop: 0, first: 0, last: 9 });
  });

  it('takes another overscan', () => {
    expect(listWindow(240, 240, 24, 100, 2)).toEqual({ scrollTop: 240, first: 8, last: 22 });
  });
});
