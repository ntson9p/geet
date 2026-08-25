import { describe, expect, it } from 'vitest';
import {
  buildAheadBehindArgs,
  buildFastForwardArgs,
  parseAheadBehind,
} from '../../../src/branches/updateBranchArgs';

/**
 * `Update` on a branch row. The safety that makes updating a branch you are
 * not standing on acceptable lives in the argv itself, so it is asserted here
 * rather than left to a runtime check that could drift from the command.
 */

describe('buildFastForwardArgs', () => {
  it('fetches from the repository itself, not the remote', () => {
    // The real fetch already ran; this step only moves the local ref, so it
    // must not depend on the network a second time.
    expect(buildFastForwardArgs('origin/main', 'main')).toEqual([
      'fetch',
      '.',
      'origin/main:main',
    ]);
  });

  it('never forces the refspec', () => {
    // A leading `+` would make git overwrite a diverged branch silently. Its
    // absence is the entire safety property of this command.
    const args = buildFastForwardArgs('origin/feature/x', 'feature/x');
    expect(args.some((a) => a.startsWith('+'))).toBe(false);
    expect(args).toContain('origin/feature/x:feature/x');
  });

  it('keeps slashes in both halves of the refspec', () => {
    expect(buildFastForwardArgs('upstream/release/2.0', 'release/2.0')).toEqual([
      'fetch',
      '.',
      'upstream/release/2.0:release/2.0',
    ]);
  });
});

describe('buildAheadBehindArgs', () => {
  it('asks for the symmetric difference, not a one-sided count', () => {
    expect(buildAheadBehindArgs('main', 'origin/main')).toEqual([
      'rev-list',
      '--left-right',
      '--count',
      'main...origin/main',
    ]);
  });
});

describe('parseAheadBehind', () => {
  it('reads git\'s left/right columns as ahead/behind', () => {
    expect(parseAheadBehind('3\t7\n')).toEqual({ ahead: 3, behind: 7 });
  });

  it('accepts spaces as well as the tab git actually emits', () => {
    expect(parseAheadBehind('  0   4  ')).toEqual({ ahead: 0, behind: 4 });
  });

  it('reads a level branch as neither ahead nor behind', () => {
    expect(parseAheadBehind('0\t0')).toEqual({ ahead: 0, behind: 0 });
  });

  it('degrades to zero rather than NaN on unparseable output', () => {
    // A zeroed count means "nothing to do", which is the safe answer: the
    // caller reports "already up to date" instead of fast-forwarding on NaN.
    expect(parseAheadBehind('')).toEqual({ ahead: 0, behind: 0 });
    expect(parseAheadBehind('fatal: bad revision')).toEqual({ ahead: 0, behind: 0 });
  });
});
