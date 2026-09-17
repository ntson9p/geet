import { describe, expect, it } from 'vitest';
import { hubLevel, hubSections, segmentOf } from '../../../src/branches/branchHubModel';
import type { RefInfo } from '../../../src/core/model/refs';

/**
 * POST-P14u. These pin the two properties that make the Branches view the
 * branches popup rather than a second, subtly different branch list:
 *
 *   - the sections, their order and their membership are the popup's; and
 *   - `feature/` is a **real** node here, because a tree can nest and a
 *     `QuickPick` cannot (which is what deviation D5 is about).
 */
const ref = (name: string, over: Partial<RefInfo> = {}): RefInfo => ({
  name,
  fullName: `refs/heads/${name}`,
  type: 'head',
  sha: 'abcdef1234567',
  objectType: 'commit',
  isHead: false,
  ...over,
});

const remote = (name: string, remoteName = 'origin'): RefInfo =>
  ref(name, { type: 'remote', remote: remoteName, fullName: `refs/remotes/${name}` });

const tag = (name: string): RefInfo =>
  ref(name, { type: 'tag', fullName: `refs/tags/${name}` });

const input = (over: Partial<Parameters<typeof hubSections>[0]> = {}) =>
  hubSections({
    current: undefined,
    locals: [],
    remotes: [],
    tags: [],
    recent: [],
    favorites: new Set<string>(),
    ...over,
  });

describe('hubSections', () => {
  it('orders sections the way the popup does', () => {
    const head = ref('develop', { isHead: true });
    const sections = input({
      current: head,
      locals: [head, ref('feature/a'), ref('fix/b'), ref('starred')],
      remotes: [remote('origin/develop')],
      tags: [tag('v1.0')],
      recent: ['fix/b'],
      favorites: new Set(['starred']),
    });
    expect(sections.map((s) => s.id)).toEqual([
      '@current',
      '@favorites',
      '@recent',
      '@local',
      '@remote:origin',
      '@tags',
    ]);
  });

  it('omits a section rather than showing it empty', () => {
    const sections = input({ locals: [ref('main')] });
    expect(sections.map((s) => s.kind)).toEqual(['local']);
  });

  it('never lists the checked-out branch twice', () => {
    const head = ref('develop', { isHead: true });
    const sections = input({
      current: head,
      locals: [head, ref('other')],
      // Even when it is both a favourite and the most recent thing touched.
      recent: ['develop'],
      favorites: new Set(['develop']),
    });
    expect(sections.map((s) => s.id)).toEqual(['@current', '@local']);
    expect(sections.find((s) => s.id === '@local')?.refs.map((r) => r.name)).toEqual(['other']);
  });

  it('does not repeat a favourite in Recent', () => {
    const sections = input({
      locals: [ref('a'), ref('b')],
      recent: ['a', 'b'],
      favorites: new Set(['a']),
    });
    const names = (id: string) => sections.find((s) => s.id === id)?.refs.map((r) => r.name);
    expect(names('@favorites')).toEqual(['a']);
    expect(names('@recent')).toEqual(['b']);
  });

  it('keeps Recent in reflog order, which is the whole point of it', () => {
    const sections = input({ locals: [ref('a'), ref('b'), ref('c')], recent: ['c', 'a'] });
    expect(sections.find((s) => s.id === '@recent')?.refs.map((r) => r.name)).toEqual(['c', 'a']);
  });

  it('gives each remote its own section, sorted', () => {
    const sections = input({
      remotes: [remote('upstream/main', 'upstream'), remote('origin/main')],
    });
    expect(sections.map((s) => s.id)).toEqual(['@remote:origin', '@remote:upstream']);
  });

  it('marks the curated lists flat — a folder row would hide what was pinned', () => {
    const head = ref('develop', { isHead: true });
    const sections = input({
      current: head,
      locals: [head, ref('feature/a'), ref('feature/r')],
      recent: ['feature/r'],
      favorites: new Set(['feature/a']),
      tags: [tag('v1')],
    });
    const flat = Object.fromEntries(sections.map((s) => [s.id, s.flat]));
    expect(flat['@current']).toBe(true);
    expect(flat['@favorites']).toBe(true);
    expect(flat['@recent']).toBe(true);
    expect(flat['@local']).toBe(false);
    expect(flat['@tags']).toBe(false);
  });
});

describe('segmentOf', () => {
  it('reads one level at a time', () => {
    expect(segmentOf('feature/a/b', '')).toBe('feature');
    expect(segmentOf('feature/a/b', 'feature/')).toBe('a');
    expect(segmentOf('feature/a/b', 'feature/a/')).toBeUndefined();
    expect(segmentOf('main', '')).toBeUndefined();
    expect(segmentOf('other/x', 'feature/')).toBeUndefined();
  });
});

describe('hubLevel', () => {
  const refs = [ref('main'), ref('feature/a'), ref('feature/b'), ref('feature/deep/c')];

  it('folds a prefix into one node and counts what is under it', () => {
    const level = hubLevel(refs, '', false);
    expect(level.folders).toEqual([{ prefix: 'feature/', name: 'feature', count: 3 }]);
    expect(level.refs.map((r) => r.name)).toEqual(['main']);
  });

  it('nests — the thing the popup cannot do, which is deviation D5', () => {
    const level = hubLevel(refs, 'feature/', false);
    expect(level.folders).toEqual([{ prefix: 'feature/deep/', name: 'deep', count: 1 }]);
    expect(level.refs.map((r) => r.name)).toEqual(['feature/a', 'feature/b']);
    const deeper = hubLevel(refs, 'feature/deep/', false);
    expect(deeper.folders).toEqual([]);
    expect(deeper.refs.map((r) => r.name)).toEqual(['feature/deep/c']);
  });

  it('starts a remote section below its remote name', () => {
    // `origin/feature/x` under prefix `origin/` folds to `feature`, not to a
    // pointless `origin` node inside a section already called `Remote: origin`.
    const remotes = [remote('origin/main'), remote('origin/feature/x')];
    const level = hubLevel(remotes, 'origin/', false);
    expect(level.folders.map((f) => f.name)).toEqual(['feature']);
    expect(level.refs.map((r) => r.name)).toEqual(['origin/main']);
  });

  it('lists a flat section whole, folders and all', () => {
    const level = hubLevel(refs, '', true);
    expect(level.folders).toEqual([]);
    expect(level.refs.map((r) => r.name)).toEqual([
      'main',
      'feature/a',
      'feature/b',
      'feature/deep/c',
    ]);
  });

  it('sorts folders by name', () => {
    const level = hubLevel([ref('z/1'), ref('a/1'), ref('m/1')], '', false);
    expect(level.folders.map((f) => f.name)).toEqual(['a', 'm', 'z']);
  });
});
