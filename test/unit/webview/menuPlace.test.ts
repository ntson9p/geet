import { describe, expect, it } from 'vitest';
import { MENU_MARGIN, placeMenu } from '../../../webview-ui/src/lib/menuPlace';

const VIEW = { width: 1000, height: 600 };
const SIZE = { width: 220, height: 120 };

describe('placeMenu (where a menu stands in its webview)', () => {
  it('opens where it is asked to when it fits', () => {
    expect(placeMenu({ x: 100, y: 50 }, SIZE, VIEW)).toEqual({ x: 100, y: 50 });
  });

  it('is pushed back inside the webview, a margin from its edges', () => {
    expect(placeMenu({ x: 900, y: 550 }, SIZE, VIEW)).toEqual({
      x: VIEW.width - SIZE.width - MENU_MARGIN,
      y: VIEW.height - SIZE.height - MENU_MARGIN,
    });
    expect(placeMenu({ x: -20, y: -5 }, SIZE, VIEW)).toEqual({ x: MENU_MARGIN, y: MENU_MARGIN });
  });

  describe('a submenu (POST-P14cg)', () => {
    it('opens to the right of its menu when there is room', () => {
      // Its menu stands from 300 to 520; the submenu starts 2 pixels inside its right edge.
      expect(placeMenu({ x: 518, y: 80, flipX: 302 }, SIZE, VIEW)).toEqual({ x: 518, y: 80 });
    });

    it("opens leftwards from its menu's left edge when the right has no room, as VS Code's do", () => {
      // The eye's menu at the right end of the log's toolbar: 770 to 996.
      expect(placeMenu({ x: 994, y: 200, flipX: 772 }, SIZE, VIEW)).toEqual({ x: 772 - SIZE.width, y: 200 });
    });

    it('is pushed back inside when neither side has room', () => {
      const narrow = { width: 400, height: 600 };
      expect(placeMenu({ x: 300, y: 10, flipX: 100 }, SIZE, narrow)).toEqual({
        x: narrow.width - SIZE.width - MENU_MARGIN,
        y: 10,
      });
    });

    it('keeps a top-level menu, which has no parent edge, pushed back inside as before', () => {
      expect(placeMenu({ x: 994, y: 200 }, SIZE, VIEW)).toEqual({ x: VIEW.width - SIZE.width - MENU_MARGIN, y: 200 });
    });
  });
});
