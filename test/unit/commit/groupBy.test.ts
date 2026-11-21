import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { GROUP_BY_DIRECTORY_DEFAULT } from '../../../src/commit/window/groupByDefaults';
import { repoHeadOf } from '../../../src/commit/window/repoHead';
import { commitGroupByOf } from '../../../src/shared/protocol';

describe('geet.commit.groupBy, as both sides read it', () => {
  it('is changelist or repository only when it says so', () => {
    expect(commitGroupByOf('repository')).toBe('repository');
    expect(commitGroupByOf('changelist')).toBe('changelist');
    expect(commitGroupByOf('none')).toBe('none');
  });

  it('falls back to the default, no changelist rows (POST-P14cb), for anything a settings file or a message could hold', () => {
    for (const odd of [undefined, null, '', 'Repository', 'repositories', 'Changelist', 1, {}, ['repository']]) {
      expect(commitGroupByOf(odd)).toBe('none');
    }
  });

  it('defaults in package.json as it does in the code, with the folder rows off', () => {
    const manifest = JSON.parse(readFileSync(path.resolve(__dirname, '../../../package.json'), 'utf8')) as {
      contributes: { configuration: Array<{ properties?: Record<string, { default?: unknown; enum?: unknown[] }> }> };
    };
    const props = Object.assign({}, ...manifest.contributes.configuration.map((s) => s.properties ?? {})) as Record<
      string,
      { default?: unknown; enum?: unknown[] }
    >;
    expect(props['geet.commit.groupBy']?.default).toBe(commitGroupByOf(undefined));
    expect(props['geet.commit.groupBy']?.enum).toEqual(['none', 'changelist', 'repository']);
    expect(props['geet.commit.groupByDirectory']?.default).toBe(GROUP_BY_DIRECTORY_DEFAULT);
    expect(GROUP_BY_DIRECTORY_DEFAULT).toBe(false);
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
