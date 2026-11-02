import { describe, expect, it } from 'vitest';
import {
  buildNewBranchArgs,
  newBranchTrackFlag,
  remoteNamesOf,
} from '../../../src/branches/newBranchArgs';

const refs = [
  { type: 'head' as const },
  { type: 'remote' as const, remote: 'origin' },
  { type: 'remote' as const, remote: 'origin' },
  { type: 'remote' as const, remote: 'upstream' },
  { type: 'tag' as const },
];

describe('newBranchTrackFlag: what a new branch tracks', () => {
  it('tracks nothing from a remote branch of another name', () => {
    // The owner's report: a new branch from `origin/develop` tracked it, so its
    // first push landed on `develop` and created nothing.
    expect(newBranchTrackFlag('mine', 'origin/develop', ['origin'])).toBe('--no-track');
  });

  it('tracks the remote branch whose name it takes', () => {
    expect(newBranchTrackFlag('develop', 'origin/develop', ['origin'])).toBe('--track');
    expect(newBranchTrackFlag('feature/x', 'upstream/feature/x', ['origin', 'upstream'])).toBe('--track');
  });

  it('tracks nothing from a local branch, a tag, a commit or HEAD', () => {
    // Spelled out, because `branch.autoSetupMerge=inherit` or `always` would track.
    for (const start of ['develop', 'v1.0', 'abc1234', 'HEAD']) {
      expect(newBranchTrackFlag('mine', start, ['origin'])).toBe('--no-track');
    }
  });

  it('is not fooled by a local branch whose path ends in the same name', () => {
    expect(newBranchTrackFlag('x', 'feature/x', ['origin'])).toBe('--no-track');
  });

  it('tracks nothing without remotes', () => {
    expect(newBranchTrackFlag('develop', 'origin/develop', [])).toBe('--no-track');
  });
});

describe('remoteNamesOf', () => {
  it('names each remote once, from the remote branches', () => {
    expect(remoteNamesOf(refs)).toEqual(['origin', 'upstream']);
    expect(remoteNamesOf([{ type: 'head' }])).toEqual([]);
  });
});

describe('buildNewBranchArgs', () => {
  it('checks out from a remote branch without tracking it', () => {
    expect(
      buildNewBranchArgs({ name: 'mine', startPoint: 'origin/develop', checkout: true, refs }),
    ).toEqual(['checkout', '-b', 'mine', '--no-track', 'origin/develop']);
  });

  it('creates from a remote branch without tracking it', () => {
    expect(
      buildNewBranchArgs({ name: 'mine', startPoint: 'origin/develop', checkout: false, refs }),
    ).toEqual(['branch', '--no-track', '--', 'mine', 'origin/develop']);
  });

  it('tracks when the name is the remote branch’s own, either way', () => {
    expect(
      buildNewBranchArgs({ name: 'develop', startPoint: 'origin/develop', checkout: true, refs }),
    ).toEqual(['checkout', '-b', 'develop', '--track', 'origin/develop']);
    expect(
      buildNewBranchArgs({ name: 'develop', startPoint: 'origin/develop', checkout: false, refs }),
    ).toEqual(['branch', '--track', '--', 'develop', 'origin/develop']);
  });

  it('starts from HEAD without tracking', () => {
    expect(buildNewBranchArgs({ name: 'mine', startPoint: 'HEAD', checkout: true, refs })).toEqual([
      'checkout',
      '-b',
      'mine',
      '--no-track',
      'HEAD',
    ]);
    expect(buildNewBranchArgs({ name: 'mine', startPoint: 'HEAD', checkout: false, refs })).toEqual([
      'branch',
      '--no-track',
      '--',
      'mine',
      'HEAD',
    ]);
  });

  it('names the branch-to-be on an unborn HEAD, where there is no commit to start from', () => {
    expect(
      buildNewBranchArgs({ name: 'first', startPoint: 'HEAD', checkout: true, unborn: true, refs: [] }),
    ).toEqual(['checkout', '-b', 'first']);
  });
});
