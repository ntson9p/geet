/**
 * POST-P14da: what of .git/logs/HEAD is Geet's own is told by where it is in
 * the file, not by when it came. A second after one of Geet's mutations, an
 * external `git reset --hard` used to count as Geet's own and go unnoticed.
 */
import { describe, expect, it } from 'vitest';
import { ReflogTail } from '../../../src/localHistory/reflogTail';

describe('ReflogTail', () => {
  it('hands over what was appended since the last read, once', () => {
    const tail = new ReflogTail(100);
    expect(tail.takeExternal(160, false)).toEqual({ from: 100, to: 160 });
    expect(tail.takeExternal(160, false)).toBeUndefined();
    expect(tail.takeExternal(200, false)).toEqual({ from: 160, to: 200 });
  });

  it('starts from the size it was given: what was there before is not news', () => {
    expect(new ReflogTail(300).takeExternal(300, false)).toBeUndefined();
  });

  it('leaves the lines alone while one of Geet’s mutations runs, and skips them when it finishes', () => {
    const tail = new ReflogTail(100);
    // Geet's reset writes its line; the watcher fires before the mutation ends.
    expect(tail.takeExternal(160, true)).toBeUndefined();
    tail.ownUpTo(160);
    // The watcher fires again, late: still nothing.
    expect(tail.takeExternal(160, false)).toBeUndefined();
  });

  it('skips what a finished mutation wrote even when the watcher only fires after it', () => {
    const tail = new ReflogTail(100);
    tail.ownUpTo(160);
    expect(tail.takeExternal(160, false)).toBeUndefined();
  });

  it('hands over an external reset made right after a mutation of Geet’s finished', () => {
    // The case the old one-second grace dropped: Geet's own line, then the
    // user's reset a few milliseconds later.
    const tail = new ReflogTail(100);
    tail.ownUpTo(160);
    expect(tail.takeExternal(220, false)).toEqual({ from: 160, to: 220 });
  });

  it('starts over from the new end when git rewrites the log shorter (reflog expire)', () => {
    const tail = new ReflogTail(500);
    expect(tail.takeExternal(120, false)).toBeUndefined();
    expect(tail.takeExternal(180, false)).toEqual({ from: 120, to: 180 });
  });
});
