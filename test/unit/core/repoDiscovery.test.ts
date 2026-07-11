import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { canonicalKey, RepoDiscovery } from '../../../src/core/repoDiscovery';

/** Fake rev-parse: maps directory prefixes to repo roots. */
function fakeDiscovery(repoRoots: string[]): RepoDiscovery {
  const roots = repoRoots.map((r) => ({ root: r, key: canonicalKey(r) }));
  return new RepoDiscovery({
    getRepoRoot: (dir) => {
      const key = canonicalKey(dir);
      // innermost enclosing repo, like real rev-parse
      let best: string | undefined;
      let bestLen = -1;
      for (const { root, key: rootKey } of roots) {
        if ((key === rootKey || key.startsWith(rootKey + '/')) && rootKey.length > bestLen) {
          best = root;
          bestLen = rootKey.length;
        }
      }
      return Promise.resolve(best);
    },
  });
}

const R = (p: string): string => path.normalize(p);

describe('RepoDiscovery', () => {
  it('discovers one repo per folder', async () => {
    const d = fakeDiscovery(['/w/repoA', '/w/repoB']);
    expect(await d.scan(['/w/repoA', '/w/repoB'])).toEqual([R('/w/repoA'), R('/w/repoB')]);
  });

  it('deduplicates folders inside the same repo', async () => {
    const d = fakeDiscovery(['/w/repoA']);
    expect(await d.scan(['/w/repoA', '/w/repoA/src', '/w/repoA/docs'])).toEqual([R('/w/repoA')]);
  });

  it('walks parents: a subfolder finds its enclosing repo', async () => {
    const d = fakeDiscovery(['/w/repoA']);
    expect(await d.scan(['/w/repoA/deep/inner/dir'])).toEqual([R('/w/repoA')]);
  });

  it('keeps nested repos when both roots are open folders', async () => {
    const d = fakeDiscovery(['/w/outer', '/w/outer/vendor/inner']);
    const roots = await d.scan(['/w/outer', '/w/outer/vendor/inner']);
    expect(roots).toEqual([R('/w/outer'), R('/w/outer/vendor/inner')]);
  });

  it('drops a nested repo whose root is not an open folder (outermost wins)', async () => {
    const d = fakeDiscovery(['/w/outer', '/w/outer/vendor/inner']);
    // Folder deep inside inner discovers inner; another folder discovers outer.
    const roots = await d.scan(['/w/outer', '/w/outer/vendor/inner/src']);
    expect(roots).toEqual([R('/w/outer')]);
  });

  it('returns nothing for non-repo folders', async () => {
    const d = fakeDiscovery([]);
    expect(await d.scan(['/tmp/plain'])).toEqual([]);
  });

  it('survives probe errors', async () => {
    const d = new RepoDiscovery({
      getRepoRoot: () => Promise.reject(new Error('boom')),
    });
    expect(await d.scan(['/w/x'])).toEqual([]);
  });
});

describe('canonicalKey', () => {
  it('normalizes separators and trailing slashes', () => {
    expect(canonicalKey('/w/repo/', 'linux')).toBe(path.resolve('/w/repo').replace(/\\/g, '/'));
  });

  it('folds case on win32 only', () => {
    const win = canonicalKey('D:\\Repo\\Sub', 'win32');
    expect(win).toBe(win.toLowerCase());
    const linux = canonicalKey('/W/Repo', 'linux');
    expect(linux).toContain('W');
  });
});
