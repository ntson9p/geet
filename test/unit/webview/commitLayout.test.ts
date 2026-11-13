/**
 * POST-P14ca: how the Commit tab shares its height between the list and the
 * message box, and where the options popup opens. What a real window does at
 * those sizes is the Playwright suite's (commit.spec.ts, "a compact Commit tab").
 */
import { describe, expect, it } from 'vitest';
import {
  clampMessageHeight,
  fitMessageHeight,
  LIST_FLOOR_PX,
  LIST_FLOOR_ROWS,
  LIST_ROW_PX,
  MESSAGE_LINES,
  popupPlacement,
  savedMessageHeight,
} from '../../../webview-ui/src/commit/commitLayout';

const MIN = 28; // one line, its padding and border
const NATURAL = 65; // three lines

describe('the message box in a view of any size', () => {
  it('starts at three lines, and keeps three rows of the list', () => {
    expect(MESSAGE_LINES).toBe(3);
    expect(LIST_FLOOR_ROWS).toBe(3);
    expect(LIST_FLOOR_PX).toBe(3 * LIST_ROW_PX);
  });

  it('gets the height it was given while the list keeps its floor', () => {
    expect(fitMessageHeight({ preferred: NATURAL, min: MIN, room: 400, listFloor: LIST_FLOOR_PX })).toBe(NATURAL);
    expect(fitMessageHeight({ preferred: 200, min: MIN, room: 400, listFloor: LIST_FLOOR_PX })).toBe(200);
  });

  it('gives way before the list goes under its floor, the list first down to it', () => {
    // 100 px between them: the list keeps 66, the box gets the other 34.
    expect(fitMessageHeight({ preferred: NATURAL, min: MIN, room: 100, listFloor: LIST_FLOOR_PX })).toBe(34);
  });

  it('never goes under one line: past that, the list gives up the rest', () => {
    expect(fitMessageHeight({ preferred: NATURAL, min: MIN, room: 70, listFloor: LIST_FLOOR_PX })).toBe(MIN);
    expect(fitMessageHeight({ preferred: NATURAL, min: MIN, room: 0, listFloor: LIST_FLOOR_PX })).toBe(MIN);
  });

  it('a height under one line, from an old state, is drawn as one line', () => {
    expect(fitMessageHeight({ preferred: 5, min: MIN, room: 400, listFloor: LIST_FLOOR_PX })).toBe(MIN);
  });

  it('comes back to its height as the view grows again', () => {
    const at = (room: number): number => fitMessageHeight({ preferred: 120, min: MIN, room, listFloor: LIST_FLOOR_PX });
    expect([at(80), at(150), at(186), at(400)]).toEqual([MIN, 84, 120, 120]);
  });
});

describe('a drag or a key on the divider', () => {
  const fit = { min: MIN, room: 300, listFloor: LIST_FLOOR_PX };

  it('is taken as it is between one line and the list floor, in whole pixels', () => {
    expect(clampMessageHeight(140.6, fit)).toBe(141);
  });

  it('stops at one line', () => {
    expect(clampMessageHeight(3, fit)).toBe(MIN);
    expect(clampMessageHeight(-50, fit)).toBe(MIN);
  });

  it("stops where the list would go under three rows (Home's way up)", () => {
    expect(clampMessageHeight(Number.MAX_SAFE_INTEGER, fit)).toBe(300 - LIST_FLOOR_PX);
  });

  it('in a view too short for both, settles on one line', () => {
    expect(clampMessageHeight(200, { ...fit, room: 40 })).toBe(MIN);
  });
});

describe('a remembered height', () => {
  it('is used when it is a positive number, rounded', () => {
    expect(savedMessageHeight(120.4)).toBe(120);
  });

  it('is ignored when it is anything else', () => {
    for (const raw of [undefined, null, 0, -4, Number.NaN, Number.POSITIVE_INFINITY, '120', {}]) {
      expect(savedMessageHeight(raw)).toBeUndefined();
    }
  });
});

describe('the options popup', () => {
  it('opens above the gear, clear of it, when there is room', () => {
    // A 600 px view, the gear's row 400..422.
    expect(popupPlacement({ top: 400, bottom: 422 }, 600)).toEqual({ bottom: 204, maxHeight: 388 });
  });

  it('opens below the gear when the room above is short and the room below larger', () => {
    // The gear near the top of a tall view: 60 px above it, 500 below.
    expect(popupPlacement({ top: 60, bottom: 82 }, 600)).toEqual({ top: 86, maxHeight: 506 });
  });

  it('stays above in a short view with less room below', () => {
    const p = popupPlacement({ top: 120, bottom: 142 }, 200);
    expect(p.bottom).toBe(84);
    expect(p.maxHeight).toBe(108);
  });

  it('never asks for a negative height', () => {
    expect(popupPlacement({ top: 2, bottom: 24 }, 20).maxHeight).toBeGreaterThanOrEqual(0);
  });
});
