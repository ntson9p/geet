import { describe, expect, it } from 'vitest';
import {
  chunked,
  listIdFor,
  listKeyOf,
  moveChoices,
  UNVERSIONED_KEY,
  type ListLike,
} from '../../../src/commit/changelists/moveChoices';

const changes = (name = 'Changes'): ListLike => ({ id: 'default', name, isDefault: true });
const list = (id: string, name: string): ListLike => ({ id, name, isDefault: false });

describe('Move to Another Changelist… choices (POST-P14bf)', () => {
  it('keys a list as the tree merges it: the default by being the default, the others by name', () => {
    expect(listKeyOf(changes())).toBe('@default');
    expect(listKeyOf(changes('Renamed'))).toBe('@default');
    expect(listKeyOf(list('cl-1', 'Login fix'))).toBe('name:Login fix');
  });

  it('offers every list once, the default first, the others as they first appear', () => {
    const choices = moveChoices([
      { lists: [list('a1', 'Feature'), changes(), list('a2', 'Docs')], fromKeys: new Set([UNVERSIONED_KEY]) },
      { lists: [changes('Default'), list('b1', 'Docs'), list('b2', 'Spike')], fromKeys: new Set([UNVERSIONED_KEY]) },
    ]);
    expect(choices).toEqual([
      // The first repository's name for the default list, as the tree's row reads.
      { key: '@default', label: 'Changes' },
      { key: 'name:Feature', label: 'Feature' },
      { key: 'name:Docs', label: 'Docs' },
      { key: 'name:Spike', label: 'Spike' },
    ]);
  });

  it('leaves out the one list every file already sits in, as IntelliJ does', () => {
    const lists = [changes(), list('a1', 'Feature')];
    expect(moveChoices([{ lists, fromKeys: new Set(['@default']) }]).map((c) => c.key)).toEqual(['name:Feature']);
    expect(moveChoices([{ lists, fromKeys: new Set(['name:Feature']) }]).map((c) => c.key)).toEqual(['@default']);
  });

  it('leaves every list in when the files come from more than one place', () => {
    const lists = [changes(), list('a1', 'Feature')];
    expect(moveChoices([{ lists, fromKeys: new Set(['@default', UNVERSIONED_KEY]) }])).toHaveLength(2);
    expect(
      moveChoices([
        { lists, fromKeys: new Set(['@default']) },
        { lists, fromKeys: new Set(['name:Feature']) },
      ]),
    ).toHaveLength(2);
  });

  it('keeps every list on offer for new files, which sit in none', () => {
    expect(moveChoices([{ lists: [changes()], fromKeys: new Set([UNVERSIONED_KEY]) }])).toEqual([
      { key: '@default', label: 'Changes' },
    ]);
  });

  it('keeps the default on offer when it is the only list and the files are in it', () => {
    expect(moveChoices([{ lists: [changes()], fromKeys: new Set(['@default']) }])).toEqual([
      { key: '@default', label: 'Changes' },
    ]);
  });

  it("finds a repository's copy of a choice, or none to make", () => {
    const lists = [changes('Renamed'), list('cl-7', 'Docs')];
    expect(listIdFor(lists, '@default')).toBe('default');
    expect(listIdFor(lists, 'name:Docs')).toBe('cl-7');
    expect(listIdFor(lists, 'name:Spike')).toBeUndefined();
  });

  it('slices a long path list for the command line', () => {
    const paths = Array.from({ length: 450 }, (_, i) => `f${i}`);
    const slices = chunked(paths);
    expect(slices.map((s) => s.length)).toEqual([200, 200, 50]);
    expect(slices.flat()).toEqual(paths);
    expect(chunked([])).toEqual([]);
    expect(chunked(['a', 'b', 'c'], 2)).toEqual([['a', 'b'], ['c']]);
  });
});
