import { describe, expect, it } from 'vitest';
import {
  alreadyLanded,
  boundaryAction,
  expectedLanding,
  hasIdenticalSides,
  hoverWouldCoverToolbar,
  movedOn,
  needsAsking,
  nextStop,
  nothingHiddenAhead,
  positionedTitle,
  predict,
  predictedChanges,
} from '../../../src/diff/navigationStep';

const L = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join('\n') + '\n';
const LAST = 19;
/** Changes at rows 2, 9 and 16. */
const CHANGES = predictedChanges(
  L(20),
  L(20).replace('line 3\n', 'A\n').replace('line 10\n', 'B\n').replace('line 17\n', 'C\n'),
  true,
)!;

describe('cross-file change navigation (P14-T7)', () => {
  describe('a press, before anything moves', () => {
    it('asks VS Code while changes may lie ahead', () => {
      expect(needsAsking({ armed: false, confirmed: false, prediction: 'more' })).toBe(true);
      expect(needsAsking({ armed: false, confirmed: false, prediction: 'unknown' })).toBe(true);
    });

    it('announces the boundary without moving the view when nothing lies ahead', () => {
      // Asking would wrap to the top of the file, on screen, to learn nothing.
      expect(needsAsking({ armed: false, confirmed: false, prediction: 'none' })).toBe(false);
    });

    it('asks on the second press: a prediction alone must never skip a change', () => {
      expect(needsAsking({ armed: true, confirmed: false, prediction: 'none' })).toBe(true);
    });

    it('does not ask again once VS Code has confirmed it', () => {
      expect(needsAsking({ armed: true, confirmed: true, prediction: 'none' })).toBe(false);
      expect(needsAsking({ armed: true, confirmed: true, prediction: 'unknown' })).toBe(false);
    });
  });

  describe('what VS Code answered', () => {
    it('going on is a move in the direction asked', () => {
      expect(movedOn('next', 2, 9)).toBe(true);
      expect(movedOn('prev', 9, 2)).toBe(true);
    });

    it('a wrap is not: "next" back up the file, "previous" back down it', () => {
      expect(movedOn('next', 16, 2)).toBe(false);
      expect(movedOn('prev', 2, 16)).toBe(false);
    });

    it('nor is staying put: the only change, or a diff still being computed', () => {
      expect(movedOn('next', 2, 2)).toBe(false);
      expect(movedOn('prev', 2, 2)).toBe(false);
    });
  });

  describe('at the end of a file', () => {
    it('arms instead of jumping — the whole point', () => {
      expect(boundaryAction('next', false, 1)).toEqual({ kind: 'arm', toIndex: 1 });
      expect(boundaryAction('prev', false, 0)).toEqual({ kind: 'arm', toIndex: 0 });
    });

    it('crosses only on the second press, landing on the first change', () => {
      expect(boundaryAction('next', true, 1)).toEqual({ kind: 'cross', toIndex: 1, landOn: 'first' });
    });

    it('enters a file backwards on its LAST change', () => {
      expect(boundaryAction('prev', true, 0)).toEqual({ kind: 'cross', toIndex: 0, landOn: 'last' });
    });

    it('stops at the end of the list, armed or not, and never wraps', () => {
      expect(boundaryAction('next', false, undefined)).toEqual({ kind: 'end' });
      expect(boundaryAction('next', true, undefined)).toEqual({ kind: 'end' });
      expect(boundaryAction('prev', true, undefined)).toEqual({ kind: 'end' });
    });
  });

  describe('the next file to stop at', () => {
    const changed = (...indices: number[]) => (i: number) => indices.includes(i);

    it('is the neighbour when it has changes', async () => {
      expect(await nextStop(0, 3, 'next', changed(1, 2))).toBe(1);
      expect(await nextStop(2, 3, 'prev', changed(0, 1))).toBe(1);
    });

    it('skips a file with no change, in either direction', async () => {
      // VS Code greys out its button on such a file: stopping there strands the walk.
      expect(await nextStop(0, 4, 'next', changed(2, 3))).toBe(2);
      expect(await nextStop(3, 4, 'prev', changed(0))).toBe(0);
    });

    it('is nothing when no file ahead has a change', async () => {
      expect(await nextStop(0, 3, 'next', changed())).toBeUndefined();
      expect(await nextStop(0, 3, 'prev', changed(1, 2))).toBeUndefined();
      expect(await nextStop(2, 3, 'next', changed(0, 1))).toBeUndefined();
    });

    it('reads no further than it has to', async () => {
      const asked: number[] = [];
      await nextStop(0, 5, 'next', (i) => {
        asked.push(i);
        return i === 2;
      });
      expect(asked).toEqual([1, 2]);
    });

    it('knows a 100% rename or copy without reading it', () => {
      expect(hasIdenticalSides('R100')).toBe(true);
      expect(hasIdenticalSides('C100')).toBe(true);
      // Renamed and edited, or any other change, has to be looked at.
      for (const status of ['R097', 'C075', 'R', 'M', 'A', 'D']) {
        expect(hasIdenticalSides(status)).toBe(false);
      }
    });
  });

  describe('the prediction', () => {
    it('finds the changes as VS Code numbers them', () => {
      expect(CHANGES.map((c) => c.startLine)).toEqual([2, 9, 16]);
    });

    it('next: more until the cursor reaches the last change', () => {
      expect(predict(CHANGES, 0, 'next', LAST)).toBe('more');
      expect(predict(CHANGES, 2, 'next', LAST)).toBe('more');
      expect(predict(CHANGES, 15, 'next', LAST)).toBe('more');
      expect(predict(CHANGES, 16, 'next', LAST)).toBe('none');
      expect(predict(CHANGES, 18, 'next', LAST)).toBe('none');
    });

    it('previous: more until the cursor reaches the first change', () => {
      expect(predict(CHANGES, 19, 'prev', LAST)).toBe('more');
      expect(predict(CHANGES, 9, 'prev', LAST)).toBe('more');
      expect(predict(CHANGES, 3, 'prev', LAST)).toBe('more');
      expect(predict(CHANGES, 2, 'prev', LAST)).toBe('none');
      expect(predict(CHANGES, 0, 'prev', LAST)).toBe('none');
    });

    it('from inside a change, previous goes to its first line, as VS Code does', () => {
      const block = predictedChanges('a\nb\nc\nd\n', 'a\nX\nY\nd\n', true)!;
      expect(block.map((c) => [c.startLine, c.endLine])).toEqual([[1, 2]]);
      expect(predict(block, 2, 'prev', 3)).toBe('more');
    });

    it('a file with no change has nothing ahead either way', () => {
      expect(predict([], 5, 'next', LAST)).toBe('none');
      expect(predict([], 5, 'prev', LAST)).toBe('none');
    });

    it('from the last line nothing lies ahead: VS Code always wraps from there', () => {
      expect(predict(CHANGES, LAST, 'next', LAST)).toBe('none');
    });

    it('a deletion at the very end is no further than the last line', () => {
      const atEnd = predictedChanges('a\nb\nc\n', 'a\nb\n', true)!;
      expect(atEnd).toHaveLength(1);
      expect(predict(atEnd, 1, 'next', 1)).toBe('none');
    });

    it('leaves it to VS Code when it cannot tell', () => {
      expect(predict(undefined, 5, 'next', LAST)).toBe('unknown');
      expect(predict(undefined, 5, 'prev', LAST)).toBe('unknown');
    });

    it('does not count line endings as a change', () => {
      const lf = 'a\nb\nc\n';
      const crlf = 'a\r\nb\r\nc\r\n';
      expect(predictedChanges(lf, crlf, false)).toEqual([]);
      expect(predictedChanges(crlf, lf, true)).toEqual([]);
    });

    it('still finds a real change between different line endings', () => {
      const changes = predictedChanges('a\nb\nc\n', 'a\r\nX\r\nc\r\n', false)!;
      expect(changes.map((c) => c.startLine)).toEqual([1]);
    });

    it('ignores leading and trailing whitespace only while VS Code does', () => {
      const original = '  a\nb  \nc\n';
      const modified = 'a\nb\nc\n';
      expect(predictedChanges(original, modified, true)).toEqual([]);
      expect(predictedChanges(original, modified, false)!.length).toBeGreaterThan(0);
    });

    it('does not mistake whitespace inside a line for nothing', () => {
      expect(predictedChanges('a b\n', 'a  b\n', true)!.length).toBe(1);
    });

    it('gives up rather than answer with one block from first change to last', () => {
      const big = (n: number) => Array.from({ length: n }, (_, i) => `row ${i}`);
      const a = big(3000);
      const b = [...a];
      b[10] = 'first';
      b[2990] = 'last';
      expect(predictedChanges(a.join('\n'), b.join('\n'), true)).toBeUndefined();
    });
  });

  describe('whether "nothing ahead" needs VS Code to confirm it', () => {
    const block = predictedChanges(L(40), L(40).replace('line 20\n', 'X\nY\nZ\n'), true)!;

    it('does not when the rest of the last change is on screen', () => {
      expect(nothingHiddenAhead(CHANGES, 'next', { first: 0, last: 30 })).toBe(true);
      expect(nothingHiddenAhead(block, 'next', { first: 10, last: 30 })).toBe(true);
    });

    it('does when part of it is below the view: that part could be a change of its own', () => {
      expect(nothingHiddenAhead(block, 'next', { first: 0, last: 19 })).toBe(false);
    });

    it('going back, does not while the first change starts on screen', () => {
      expect(nothingHiddenAhead(block, 'prev', { first: 10, last: 30 })).toBe(true);
      expect(nothingHiddenAhead(block, 'prev', { first: 25, last: 50 })).toBe(false);
    });

    it('does when Geet could not tell, or cannot see the view', () => {
      expect(nothingHiddenAhead(undefined, 'next', { first: 0, last: 30 })).toBe(false);
      expect(nothingHiddenAhead(CHANGES, 'next', undefined)).toBe(false);
    });

    it('never does for a file with no change to be wrong about', () => {
      expect(nothingHiddenAhead([], 'next', { first: 0, last: 30 })).toBe(true);
    });
  });

  describe('where the hint can go', () => {
    it('cannot be a hover on the first lines in view: it would cover the button just clicked', () => {
      expect(hoverWouldCoverToolbar(0, 0)).toBe(true);
      expect(hoverWouldCoverToolbar(3, 0)).toBe(true);
      expect(hoverWouldCoverToolbar(53, 50)).toBe(true);
    });

    it('can further down', () => {
      expect(hoverWouldCoverToolbar(4, 0)).toBe(false);
      expect(hoverWouldCoverToolbar(250, 232)).toBe(false);
    });
  });

  describe('landing', () => {
    it('opens where the change is expected', () => {
      expect(expectedLanding(CHANGES, 'first')).toBe(2);
      expect(expectedLanding(CHANGES, 'last')).toBe(16);
    });

    it('opens at the top without an idea of where', () => {
      expect(expectedLanding(undefined, 'first')).toBe(0);
      expect(expectedLanding(undefined, 'last')).toBe(0);
      expect(expectedLanding([], 'first')).toBe(0);
    });

    it('is over at once on a file with no change', () => {
      expect(alreadyLanded([], 'first')).toBe(true);
      expect(alreadyLanded([], 'last')).toBe(true);
    });

    it('is over at once on an added or a deleted file, whose one change is on the first line', () => {
      // VS Code's navigation could never move the cursor on these, and the next
      // press would wait for it to.
      const added = predictedChanges('', 'a\nb\n', true)!;
      const deleted = predictedChanges('a\nb\n', '', true)!;
      for (const landOn of ['first', 'last'] as const) {
        expect(alreadyLanded(added, landOn)).toBe(true);
        expect(alreadyLanded(deleted, landOn)).toBe(true);
      }
    });

    it('is not over while the change sought is further down', () => {
      expect(alreadyLanded(CHANGES, 'first')).toBe(false);
      expect(alreadyLanded(CHANGES, 'last')).toBe(false);
    });

    it('asks VS Code when it cannot tell', () => {
      expect(alreadyLanded(undefined, 'first')).toBe(false);
      expect(alreadyLanded(undefined, 'last')).toBe(false);
    });
  });

  describe('the tab title', () => {
    it('says where you are in the list', () => {
      expect(positionedTitle('foo.ts (62c3e1a)', 2, 7)).toBe('foo.ts (62c3e1a) 3/7');
    });

    it('says nothing for a list of one', () => {
      expect(positionedTitle('foo.ts (62c3e1a)', 0, 1)).toBe('foo.ts (62c3e1a)');
    });
  });
});
