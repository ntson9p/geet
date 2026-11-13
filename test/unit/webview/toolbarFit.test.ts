/**
 * POST-P14ca: which toolbar actions stay on a row short of room, and which fold
 * into its `⋯` (OverflowToolbar). What the row looks like is the Playwright
 * suite's (commit.spec.ts, "a compact Commit tab").
 */
import { describe, expect, it } from 'vitest';
import { toolbarFit, type FitAction } from '../../../webview-ui/src/lib/toolbarFit';

const BUTTON = 26;
const GAP = 2;

/** The Commit tab's toolbar in its order, with the priorities App.tsx gives it. */
const COMMIT: FitAction[] = [
  { id: 'refresh', priority: 0 },
  { id: 'rollback', priority: 1 },
  { id: 'showDiff', priority: 3 },
  { id: 'shelve', priority: 5 },
  { id: 'preview', priority: 4 },
  { id: 'viewOptions', priority: 2 },
  { id: 'expandAll', priority: 6 },
  { id: 'collapseAll', priority: 7 },
];

/** The px n buttons take with the gaps between them. */
const width = (n: number): number => n * BUTTON + (n - 1) * GAP;

describe('toolbarFit', () => {
  it('keeps every action when they all fit, and folds none', () => {
    expect(toolbarFit(COMMIT, width(8), BUTTON, GAP)).toEqual({
      shown: COMMIT.map((a) => a.id),
      more: [],
    });
  });

  it('keeps everything while the row is unmeasured, so a first frame shows no lone ⋯', () => {
    expect(toolbarFit(COMMIT, 0, BUTTON, GAP).more).toEqual([]);
  });

  it('one pixel short folds the least wanted, leaving room for the ⋯', () => {
    const fit = toolbarFit(COMMIT, width(8) - 1, BUTTON, GAP);
    // Seven buttons' room: six stay, and the seventh slot is the ⋯.
    expect(fit.shown).toEqual(['refresh', 'rollback', 'showDiff', 'shelve', 'preview', 'viewOptions']);
    expect(fit.more).toEqual(['expandAll', 'collapseAll']);
  });

  it("at the side bar's usual width keeps Refresh, Rollback and View Options, in the row's own order", () => {
    // About 110 px is left beside the Commit, Shelf and Stash tabs.
    const fit = toolbarFit(COMMIT, 110, BUTTON, GAP);
    expect(fit.shown).toEqual(['refresh', 'rollback', 'viewOptions']);
    // The menu keeps the row's order too, not the priorities'.
    expect(fit.more).toEqual(['showDiff', 'shelve', 'preview', 'expandAll', 'collapseAll']);
  });

  it('the shown buttons and the ⋯ always fit in the room given', () => {
    for (let available = BUTTON; available <= width(8) + 40; available += 3) {
      const fit = toolbarFit(COMMIT, available, BUTTON, GAP);
      const buttons = fit.shown.length + (fit.more.length > 0 ? 1 : 0);
      expect(width(buttons)).toBeLessThanOrEqual(available);
      expect([...fit.shown, ...fit.more].sort()).toEqual(COMMIT.map((a) => a.id).sort());
    }
  });

  it('with room for only the ⋯, everything is in it', () => {
    expect(toolbarFit(COMMIT, BUTTON + 5, BUTTON, GAP)).toEqual({ shown: [], more: COMMIT.map((a) => a.id) });
  });

  it('equal priorities fold from the end of the row', () => {
    const same: FitAction[] = ['a', 'b', 'c', 'd'].map((id) => ({ id, priority: 1 }));
    expect(toolbarFit(same, width(3), BUTTON, GAP)).toEqual({ shown: ['a', 'b'], more: ['c', 'd'] });
  });
});
