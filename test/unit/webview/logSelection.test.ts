import { describe, expect, it } from 'vitest';
import {
  EMPTY_SELECTION,
  clickSelection,
  contextSelection,
  extendSelection,
  inGraphOrder,
  rowOrder,
  selectAll,
  shiftTarget,
  type LogSelection,
} from '../../../webview-ui/src/log/logSelection';

// Ten loaded commits, newest first, as the log lists them.
const ROWS = ['r0', 'r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7', 'r8', 'r9'];
const ORDER = rowOrder(ROWS);
const PLAIN = { toggle: false, range: false };
const CTRL = { toggle: true, range: false };
const SHIFT = { toggle: false, range: true };
const CTRL_SHIFT = { toggle: true, range: true };

const click = (current: LogSelection, index: number, mods = PLAIN): LogSelection =>
  clickSelection(ROWS, ORDER, current, index, mods);

describe("clickSelection (IntelliJ's log table)", () => {
  it('a click selects that commit alone and anchors there', () => {
    expect(click({ shas: ['r1', 'r4'], anchor: 'r1' }, 6)).toEqual({ shas: ['r6'], anchor: 'r6' });
  });

  it('Ctrl+click adds a commit, keeping graph order whatever the click order', () => {
    const one = click(EMPTY_SELECTION, 5);
    const two = click(one, 2, CTRL);
    expect(two).toEqual({ shas: ['r2', 'r5'], anchor: 'r2' });
  });

  it('Ctrl+click on a selected commit takes it out', () => {
    expect(click({ shas: ['r2', 'r5'], anchor: 'r2' }, 5, CTRL)).toEqual({ shas: ['r2'], anchor: 'r5' });
  });

  it('Shift+click selects the run from the anchor, and nothing else', () => {
    const start = click(click(EMPTY_SELECTION, 2), 8, CTRL); // anchor r8
    expect(click(start, 5, SHIFT)).toEqual({ shas: ['r5', 'r6', 'r7', 'r8'], anchor: 'r8' });
  });

  it('Shift+click runs either way from the anchor, and keeps the anchor for the next one', () => {
    const anchored = click(EMPTY_SELECTION, 4);
    const down = click(anchored, 6, SHIFT);
    expect(down.shas).toEqual(['r4', 'r5', 'r6']);
    expect(click(down, 2, SHIFT)).toEqual({ shas: ['r2', 'r3', 'r4'], anchor: 'r4' });
  });

  it('Ctrl+Shift+click adds the run to what is selected', () => {
    const start = click(click(EMPTY_SELECTION, 0), 7, CTRL); // r0, r7; anchor r7
    expect(click(start, 9, CTRL_SHIFT).shas).toEqual(['r0', 'r7', 'r8', 'r9']);
  });

  it('Shift+click with nothing selected starts the run at the clicked commit', () => {
    expect(click(EMPTY_SELECTION, 3, SHIFT)).toEqual({ shas: ['r3'], anchor: 'r3' });
  });

  it('an anchor no longer loaded falls back to the clicked row', () => {
    expect(click({ shas: [], anchor: 'gone' }, 3, SHIFT).shas).toEqual(['r3']);
  });

  it('ignores a click past the loaded rows', () => {
    const current = { shas: ['r1'], anchor: 'r1' };
    expect(click(current, 42)).toBe(current);
  });
});

describe('extendSelection (Shift with ↑ ↓ PageUp PageDown Home End)', () => {
  it('runs from the anchor to the new lead, replacing what else was selected', () => {
    const current = { shas: ['r1', 'r6'], anchor: 'r6' };
    expect(extendSelection(ROWS, ORDER, current, 8, 6)).toEqual({ shas: ['r6', 'r7', 'r8'], anchor: 'r6' });
  });

  it('with no anchor yet, starts at the row the key was pressed on', () => {
    expect(extendSelection(ROWS, ORDER, EMPTY_SELECTION, 4, 3)).toEqual({ shas: ['r3', 'r4'], anchor: 'r3' });
  });
});

describe('selectAll (Ctrl+A)', () => {
  it('selects every loaded commit and keeps the anchor', () => {
    expect(selectAll(ROWS, { shas: ['r3'], anchor: 'r3' })).toEqual({ shas: ROWS, anchor: 'r3' });
    expect(selectAll(ROWS, EMPTY_SELECTION).anchor).toBe('r0');
  });
});

describe('contextSelection (right-click)', () => {
  it('keeps the selection when the click is inside it', () => {
    const current = { shas: ['r2', 'r3', 'r7'], anchor: 'r2' };
    expect(contextSelection(ROWS, current, 3)).toBe(current);
  });

  it('selects the commit alone when the click is outside it', () => {
    expect(contextSelection(ROWS, { shas: ['r2', 'r3'], anchor: 'r2' }, 6)).toEqual({ shas: ['r6'], anchor: 'r6' });
  });
});

describe('inGraphOrder', () => {
  it('sorts newest first and drops duplicates and commits not loaded', () => {
    expect(inGraphOrder(['r7', 'r1', 'x', 'r7', 'r4'], ORDER)).toEqual(['r1', 'r4', 'r7']);
  });
});

describe('shiftTarget', () => {
  it('moves the lead like the plain keys, clamped to the list', () => {
    expect(shiftTarget('ArrowDown', 3, 5, 10)).toBe(4);
    expect(shiftTarget('ArrowUp', 0, 5, 10)).toBe(0);
    expect(shiftTarget('PageDown', 7, 5, 10)).toBe(9);
    expect(shiftTarget('PageUp', 7, 5, 10)).toBe(2);
    expect(shiftTarget('Home', 7, 5, 10)).toBe(0);
    expect(shiftTarget('End', 2, 5, 10)).toBe(9);
    expect(shiftTarget('Enter', 2, 5, 10)).toBeUndefined();
  });
});
