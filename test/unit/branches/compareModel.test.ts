import { describe, expect, it } from 'vitest';
import {
  comparisonFrom,
  diffArgs,
  DOUBLE_CLICK_MS,
  goesIntoDiff,
  revParseArgs,
  sidesOf,
  STATUS_BADGE,
  statusKind,
  type Comparison,
} from '../../../src/branches/compareModel';

const TWO_BRANCHES: Comparison = {
  left: { name: 'main', sha: 'a'.repeat(40) },
  right: { name: 'feature/x', sha: 'b'.repeat(40) },
};
const WITH_WORKING_TREE: Comparison = { left: { name: 'main', sha: 'a'.repeat(40) }, right: 'worktree' };

describe('what a comparison reads', () => {
  it('resolves both names to commits', () => {
    expect(revParseArgs('main', 'feature/x')).toEqual(['rev-parse', 'main^{commit}', 'feature/x^{commit}']);
  });

  it('has only one name to resolve against the working tree', () => {
    expect(revParseArgs('v1.0', undefined)).toEqual(['rev-parse', 'v1.0^{commit}']);
  });

  it('holds on to the shas, so a branch moving later cannot change the list under a walk', () => {
    const shas = `${'a'.repeat(40)}\n${'b'.repeat(40)}\n`;
    expect(comparisonFrom('main', 'feature/x', shas)).toEqual(TWO_BRANCHES);
    expect(diffArgs(TWO_BRANCHES)).toEqual(['diff', '--name-status', '-z', '-M', 'a'.repeat(40), 'b'.repeat(40)]);
  });

  it('compares with the files on disk by naming one revision', () => {
    expect(comparisonFrom('main', undefined, `${'a'.repeat(40)}\n`)).toEqual(WITH_WORKING_TREE);
    expect(diffArgs(WITH_WORKING_TREE)).toEqual(['diff', '--name-status', '-z', '-M', 'a'.repeat(40)]);
  });

  it('copes with line endings git may print on Windows', () => {
    expect(comparisonFrom('main', 'feature/x', `${'a'.repeat(40)}\r\n${'b'.repeat(40)}\r\n`)).toEqual(TWO_BRANCHES);
  });

  it('is nothing when a side did not resolve', () => {
    expect(comparisonFrom('main', 'feature/x', '')).toBeUndefined();
    expect(comparisonFrom('main', 'feature/x', `${'a'.repeat(40)}\n`)).toBeUndefined();
    expect(comparisonFrom('main', undefined, '\n')).toBeUndefined();
  });

  it('can compare with a branch that happens to be called worktree', () => {
    expect(revParseArgs('main', 'worktree')).toEqual(['rev-parse', 'main^{commit}', 'worktree^{commit}']);
    expect(comparisonFrom('main', 'worktree', `${'a'.repeat(40)}\n${'b'.repeat(40)}\n`)?.right).toEqual({
      name: 'worktree',
      sha: 'b'.repeat(40),
    });
  });
});

describe("a file's two sides", () => {
  it('reads each side from its own revision', () => {
    expect(sidesOf(TWO_BRANCHES, { status: 'M', path: 'src/a.ts' })).toEqual({
      left: { path: 'src/a.ts', ref: 'a'.repeat(40) },
      right: { path: 'src/a.ts', ref: 'b'.repeat(40) },
    });
  });

  it('follows a rename: the left side is the old path', () => {
    expect(sidesOf(TWO_BRANCHES, { status: 'R094', path: 'src/new.ts', origPath: 'src/old.ts' })).toEqual({
      left: { path: 'src/old.ts', ref: 'a'.repeat(40) },
      right: { path: 'src/new.ts', ref: 'b'.repeat(40) },
    });
  });

  it('has the working tree on the right, where VS Code can edit it', () => {
    expect(sidesOf(WITH_WORKING_TREE, { status: 'R100', path: 'b.ts', origPath: 'a.ts' })).toEqual({
      left: { path: 'a.ts', ref: 'a'.repeat(40) },
      right: 'worktree',
    });
  });
});

describe('a row status', () => {
  it('goes by the first letter, since a rename or copy carries a score', () => {
    expect(statusKind('A')).toBe('added');
    expect(statusKind('M')).toBe('modified');
    expect(statusKind('D')).toBe('deleted');
    expect(statusKind('R094')).toBe('renamed');
    expect(statusKind('C100')).toBe('renamed');
    expect(statusKind('U')).toBe('conflicted');
  });

  it('reads anything else as a modification, such as a change of type', () => {
    expect(statusKind('T')).toBe('modified');
    expect(statusKind('')).toBe('modified');
  });

  it('has a letter for every kind', () => {
    expect(STATUS_BADGE).toEqual({ added: 'A', modified: 'M', deleted: 'D', renamed: 'R', conflicted: '!' });
  });
});

describe('whether a click hands the keyboard to the diff', () => {
  const at = 10_000;

  it('leaves it in the list on the first click', () => {
    expect(goesIntoDiff(undefined, 'a.ts', at, false)).toBe(false);
  });

  it('goes into the diff on a second click on the same row', () => {
    expect(goesIntoDiff({ path: 'a.ts', at: at - 200 }, 'a.ts', at, false)).toBe(true);
  });

  it('does not take clicks too far apart for a double click', () => {
    expect(goesIntoDiff({ path: 'a.ts', at: at - DOUBLE_CLICK_MS }, 'a.ts', at, false)).toBe(false);
  });

  it('does not take clicks on two rows for a double click', () => {
    expect(goesIntoDiff({ path: 'b.ts', at: at - 100 }, 'a.ts', at, false)).toBe(false);
  });

  it('goes into the diff at once when only a double click opens anything', () => {
    expect(goesIntoDiff(undefined, 'a.ts', at, true)).toBe(true);
  });
});
