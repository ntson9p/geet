import { describe, expect, it } from 'vitest';
import { repoHeadOf } from '../../../src/commit/window/repoHead';
import { commitGroupByOf } from '../../../src/shared/protocol';

describe('gittree.commit.groupBy, as both sides read it', () => {
  it('is repository only when it says so', () => {
    expect(commitGroupByOf('repository')).toBe('repository');
    expect(commitGroupByOf('changelist')).toBe('changelist');
  });

  it('falls back to the default for anything a settings file or a message could hold', () => {
    for (const odd of [undefined, null, '', 'Repository', 'repositories', 1, {}, ['repository']]) {
      expect(commitGroupByOf(odd)).toBe('changelist');
    }
  });
});

describe("what a repository's row says it has checked out", () => {
  const base = { detached: false, initial: false } as const;

  it('names the branch and what it tracks', () => {
    expect(repoHeadOf({ ...base, headRef: 'main', headSha: 'a1b2c3d', upstream: 'origin/main' })).toEqual({
      branch: 'main',
      sha: 'a1b2c3d',
      upstream: 'origin/main',
    });
    expect(repoHeadOf({ ...base, headRef: 'feature/x', headSha: 'a1b2c3d' })).toEqual({
      branch: 'feature/x',
      sha: 'a1b2c3d',
    });
  });

  it('names a detached HEAD by its commit, tracking nothing', () => {
    expect(
      repoHeadOf({ ...base, detached: true, headRef: 'main', headSha: 'a1b2c3d', upstream: 'origin/main' }),
    ).toEqual({ sha: 'a1b2c3d' });
  });

  it('says a branch has no commits yet', () => {
    expect(repoHeadOf({ ...base, initial: true, headRef: 'main' })).toEqual({ branch: 'main', unborn: true });
  });

  it('says nothing before the repository has been read', () => {
    expect(repoHeadOf(base)).toBeUndefined();
  });
});
