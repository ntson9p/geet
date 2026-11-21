import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import {
  canonicalKey,
  matchesFolderName,
  RepoDiscovery,
  SCAN_VISIT_LIMIT,
} from '../../../src/core/repoDiscovery';

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

/**
 * Fake tree + rev-parse. `tree` maps a directory to its subdirectory names;
 * `repoRoots` are the directories carrying `.git`. Unlisted directories are
 * unreadable, which is how a permission error looks to the walk.
 */
function fakeTree(tree: Record<string, string[]>, repoRoots: string[]): RepoDiscovery {
  const rootKeys = repoRoots.map((r) => ({ root: r, key: canonicalKey(r) }));
  const lookup = (dir: string): string[] | undefined => {
    const key = canonicalKey(dir);
    for (const [d, kids] of Object.entries(tree)) {
      if (canonicalKey(d) === key) return kids;
    }
    return undefined;
  };
  return new RepoDiscovery({
    getRepoRoot: (dir) => {
      const key = canonicalKey(dir);
      let best: string | undefined;
      let bestLen = -1;
      for (const { root, key: rootKey } of rootKeys) {
        if ((key === rootKey || key.startsWith(rootKey + '/')) && rootKey.length > bestLen) {
          best = root;
          bestLen = rootKey.length;
        }
      }
      return Promise.resolve(best);
    },
    listDirs: (dir) => Promise.resolve(lookup(dir)),
    hasGitEntry: (dir) =>
      Promise.resolve(rootKeys.some(({ key }) => key === canonicalKey(dir))),
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

describe('RepoDiscovery downward scan', () => {
  /** One plain folder holding three checkouts — the reported arrangement. */
  const parentOfThree = (): RepoDiscovery =>
    fakeTree(
      {
        '/w/parent': ['repoA', 'repoB', 'repoC', 'notes'],
        '/w/parent/repoA': ['src'],
        '/w/parent/repoB': [],
        '/w/parent/repoC': [],
        '/w/parent/notes': [],
      },
      ['/w/parent/repoA', '/w/parent/repoB', '/w/parent/repoC'],
    );

  it('finds every checkout under a folder that is not itself a repo', async () => {
    expect(await parentOfThree().scan(['/w/parent'], { maxDepth: 1 })).toEqual([
      R('/w/parent/repoA'),
      R('/w/parent/repoB'),
      R('/w/parent/repoC'),
    ]);
  });

  it('finds nothing there without the scan — the bug this fixes', async () => {
    expect(await parentOfThree().scan(['/w/parent'])).toEqual([]);
    expect(await parentOfThree().scan(['/w/parent'], { maxDepth: 0 })).toEqual([]);
  });

  it('matches opening each checkout as its own workspace folder', async () => {
    const scanned = await parentOfThree().scan(['/w/parent'], { maxDepth: 1 });
    const listed = await parentOfThree().scan([
      '/w/parent/repoA',
      '/w/parent/repoB',
      '/w/parent/repoC',
    ]);
    expect(scanned).toEqual(listed);
  });

  it('reports a repo found both by scan and as an open folder exactly once', async () => {
    const roots = await parentOfThree().scan(['/w/parent', '/w/parent/repoB'], { maxDepth: 1 });
    expect(roots).toEqual([R('/w/parent/repoA'), R('/w/parent/repoB'), R('/w/parent/repoC')]);
  });

  const deep = (): RepoDiscovery =>
    fakeTree(
      {
        '/w/p': ['group', 'node_modules'],
        '/w/p/group': ['repoX'],
        '/w/p/group/repoX': ['vendor'],
        '/w/p/group/repoX/vendor': ['inner'],
        '/w/p/group/repoX/vendor/inner': [],
        '/w/p/node_modules': ['pkg'],
        '/w/p/node_modules/pkg': [],
      },
      ['/w/p/group/repoX', '/w/p/group/repoX/vendor/inner', '/w/p/node_modules/pkg'],
    );

  // The ignore list is the caller's: the pure module ignores nothing by
  // default, and Core passes geet.repositoryScan.ignoredFolders.
  const skipModules = { ignoredFolders: ['node_modules'] };

  it('stops at the configured depth', async () => {
    expect(await deep().scan(['/w/p'], { ...skipModules, maxDepth: 1 })).toEqual([]);
    expect(await deep().scan(['/w/p'], { ...skipModules, maxDepth: 2 })).toEqual([
      R('/w/p/group/repoX'),
    ]);
  });

  it('searches without limit at -1, keeping a directly-found nested repo', async () => {
    expect(await deep().scan(['/w/p'], { ...skipModules, maxDepth: -1 })).toEqual([
      R('/w/p/group/repoX'),
      R('/w/p/group/repoX/vendor/inner'),
    ]);
  });

  it('never descends into an ignored folder', async () => {
    // node_modules/pkg is a repo and stays unfound at any depth.
    expect(
      await deep().scan(['/w/p'], { maxDepth: -1, ignoredFolders: ['node_modules'] }),
    ).not.toContain(R('/w/p/node_modules/pkg'));
    expect(await deep().scan(['/w/p'], { maxDepth: -1, ignoredFolders: [] })).toContain(
      R('/w/p/node_modules/pkg'),
    );
  });

  it('still drops a nested repo reached only by walking up from a subfolder', async () => {
    // repoX/vendor/inner is a repo, but the open folder is a directory inside
    // it — an indirect hit, so the outermost discovered root wins.
    const d = fakeTree(
      {
        '/w/outer': [],
        '/w/outer/vendor/inner/src': [],
      },
      ['/w/outer', '/w/outer/vendor/inner'],
    );
    expect(await d.scan(['/w/outer', '/w/outer/vendor/inner/src'], { maxDepth: 1 })).toEqual([
      R('/w/outer'),
    ]);
  });

  it('skips unreadable directories and keeps walking', async () => {
    const traces: string[] = [];
    const d = new RepoDiscovery({
      getRepoRoot: (dir) =>
        Promise.resolve(canonicalKey(dir).endsWith('/ok') ? '/w/r/ok' : undefined),
      listDirs: (dir) =>
        Promise.resolve(canonicalKey(dir).endsWith('/w/r') ? ['locked', 'ok'] : undefined),
      hasGitEntry: (dir) => Promise.resolve(canonicalKey(dir).endsWith('/ok')),
      trace: (l) => traces.push(l),
    });
    expect(await d.scan(['/w/r'], { maxDepth: 2 })).toEqual([R('/w/r/ok')]);
    expect(traces.some((l) => l.includes('unreadable'))).toBe(true);
  });

  it('caps a runaway walk and says so rather than reporting a clean result', async () => {
    const traces: string[] = [];
    // Every directory has two children, forever.
    const d = new RepoDiscovery({
      getRepoRoot: () => Promise.resolve(undefined),
      listDirs: () => Promise.resolve(['a', 'b']),
      hasGitEntry: () => Promise.resolve(false),
      trace: (l) => traces.push(l),
    });
    expect(await d.scan(['/w/inf'], { maxDepth: -1, visitLimit: 50 })).toEqual([]);
    const capped = traces.find((l) => l.includes('stopped after 50 directories'));
    expect(capped).toBeDefined();
    expect(capped).toContain('still queued');
  });

  it('has a visit limit by default', () => {
    expect(SCAN_VISIT_LIMIT).toBeGreaterThan(0);
  });
});

describe('matchesFolderName', () => {
  it('matches an exact name', () => {
    expect(matchesFolderName('node_modules', 'node_modules', 'linux')).toBe(true);
    expect(matchesFolderName('node_modules2', 'node_modules', 'linux')).toBe(false);
  });

  it('supports * and ?', () => {
    expect(matchesFolderName('build-x64', 'build-*', 'linux')).toBe(true);
    expect(matchesFolderName('out1', 'out?', 'linux')).toBe(true);
    expect(matchesFolderName('out12', 'out?', 'linux')).toBe(false);
  });

  it('anchors the whole name rather than matching a substring', () => {
    expect(matchesFolderName('my-node_modules', 'node_modules', 'linux')).toBe(false);
    expect(matchesFolderName('vendor', 'end', 'linux')).toBe(false);
  });

  it('treats regex metacharacters in the pattern literally', () => {
    expect(matchesFolderName('a.b', 'a.b', 'linux')).toBe(true);
    expect(matchesFolderName('axb', 'a.b', 'linux')).toBe(false);
    expect(matchesFolderName('v(1)', 'v(1)', 'linux')).toBe(true);
  });

  it('folds case on win32 only', () => {
    expect(matchesFolderName('Node_Modules', 'node_modules', 'win32')).toBe(true);
    expect(matchesFolderName('Node_Modules', 'node_modules', 'linux')).toBe(false);
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
