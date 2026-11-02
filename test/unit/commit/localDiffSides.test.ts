import { describe, expect, it } from 'vitest';
import { localDiffSides } from '../../../src/commit/window/localDiffSides';
import type { StatusEntry } from '../../../src/core/model/statusEntry';

const entry = (x: string, y: string, extra: Partial<StatusEntry> = {}): StatusEntry =>
  ({ kind: 'ordinary', path: 'a.ts', x, y, ...extra }) as StatusEntry;
const HEAD = { relPath: 'a.ts', ref: 'HEAD' };

describe('what a Commit window row compares', () => {
  describe('with changelists: what the commit will produce', () => {
    const sides = (e: StatusEntry | undefined) => localDiffSides('a.ts', e, 'changelists');

    it('is HEAD against the working tree', () => {
      expect(sides(entry('.', 'M'))).toEqual({ left: HEAD, right: 'worktree', titleKind: 'working-tree' });
    });

    it('whatever is staged: the index would show a staged file as unchanged', () => {
      for (const e of [entry('M', '.'), entry('A', '.'), entry('M', 'M')]) {
        expect(sides(e).left).toEqual(HEAD);
        expect(sides(e).right).toBe('worktree');
      }
    });

    it('starts a rename from its old name', () => {
      expect(sides(entry('R', '.', { origPath: 'old.ts' })).left).toEqual({ relPath: 'old.ts', ref: 'HEAD' });
    });

    it('takes a file it knows nothing about the same way', () => {
      expect(sides(undefined)).toEqual({ left: HEAD, right: 'worktree', titleKind: 'working-tree' });
    });
  });

  describe('with staging: the change still to deal with', () => {
    const sides = (e: StatusEntry | undefined) => localDiffSides('a.ts', e, 'staging');
    const INDEX = { relPath: 'a.ts', ref: ':0' };

    it('is what is not staged yet, which is what the Stage hunk lenses need', () => {
      expect(sides(entry('.', 'M'))).toEqual({ left: INDEX, right: 'worktree', titleKind: 'working-tree' });
      expect(sides(entry('M', 'M')).left).toEqual(INDEX);
      expect(sides(entry('.', 'D')).left).toEqual(INDEX);
    });

    it('or else what is staged', () => {
      expect(sides(entry('M', '.'))).toEqual({ left: HEAD, right: 'index', titleKind: 'index' });
      expect(sides(entry('A', '.')).right).toBe('index');
      expect(sides(entry('D', '.')).right).toBe('index');
    });

    it('starts a staged rename from its old name', () => {
      expect(sides(entry('R', '.', { origPath: 'old.ts' }))).toEqual({
        left: { relPath: 'old.ts', ref: 'HEAD' },
        right: 'index',
        titleKind: 'index',
      });
    });

    it('has no index side for an untracked or a conflicted file', () => {
      for (const kind of ['untracked', 'unmerged'] as const) {
        const e = entry('.', 'M', { kind });
        expect(sides(e)).toEqual({ left: HEAD, right: 'worktree', titleKind: 'working-tree' });
      }
    });

    it('takes a file it knows nothing about against HEAD', () => {
      expect(sides(undefined).left).toEqual(HEAD);
    });
  });
});
