import { describe, expect, it } from 'vitest';
import {
  buildWorktreeAddArgs,
  buildWorktreeListArgs,
  buildWorktreeLockArgs,
  buildWorktreePruneArgs,
  buildWorktreeRemoveArgs,
  buildWorktreeUnlockArgs,
  defaultWorktreePath,
  EMPTY_NEW_WORKTREE_OPTIONS,
  validateNewWorktree,
  type NewWorktreeOptions,
} from '../../../src/branches/worktreeArgs';

/** P13-T6: the write half of §3.10, which had no commands at all before. */

const add = (over: Partial<NewWorktreeOptions> = {}): string[] =>
  buildWorktreeAddArgs({
    ...EMPTY_NEW_WORKTREE_OPTIONS,
    path: 'D:/repos/demo-feature',
    ref: 'feature/x',
    ...over,
  });

describe('buildWorktreeAddArgs', () => {
  it('checks out an existing branch at a path', () => {
    expect(add()).toEqual(['worktree', 'add', 'D:/repos/demo-feature', 'feature/x']);
  });

  it('creates a new branch with -b from a start point, tracking nothing', () => {
    expect(add({ mode: 'new', newBranch: 'feature/y', ref: 'main' })).toEqual([
      'worktree',
      'add',
      '--no-track',
      '-b',
      'feature/y',
      'D:/repos/demo-feature',
      'main',
    ]);
  });

  it('omits the start point when a new branch starts from HEAD', () => {
    expect(add({ mode: 'new', newBranch: 'feature/y', ref: '' })).toEqual([
      'worktree',
      'add',
      '--no-track',
      '-b',
      'feature/y',
      'D:/repos/demo-feature',
    ]);
  });

  it('does not track a remote branch of another name', () => {
    const options = {
      ...EMPTY_NEW_WORKTREE_OPTIONS,
      path: 'D:/wt',
      mode: 'new' as const,
      newBranch: 'mine',
      ref: 'origin/develop',
    };
    expect(buildWorktreeAddArgs(options, ['origin'])).toEqual([
      'worktree',
      'add',
      '--no-track',
      '-b',
      'mine',
      'D:/wt',
      'origin/develop',
    ]);
  });

  it('tracks a remote branch whose name it takes', () => {
    const options = {
      ...EMPTY_NEW_WORKTREE_OPTIONS,
      path: 'D:/wt',
      mode: 'new' as const,
      newBranch: 'develop',
      ref: 'origin/develop',
    };
    expect(buildWorktreeAddArgs(options, ['origin'])).toEqual([
      'worktree',
      'add',
      '--track',
      '-b',
      'develop',
      'D:/wt',
      'origin/develop',
    ]);
  });

  it('detaches at a revision', () => {
    expect(add({ mode: 'detach', ref: 'abc1234' })).toEqual([
      'worktree',
      'add',
      '--detach',
      'D:/repos/demo-feature',
      'abc1234',
    ]);
  });

  it('emits --force and --no-checkout before the path', () => {
    expect(add({ force: true, noCheckout: true })).toEqual([
      'worktree',
      'add',
      '--force',
      '--no-checkout',
      'D:/repos/demo-feature',
      'feature/x',
    ]);
  });

  it('trims the path and the ref', () => {
    expect(add({ path: '  D:/x  ', ref: '  main ' })).toEqual(['worktree', 'add', 'D:/x', 'main']);
  });
});

describe('validateNewWorktree', () => {
  const opts = (over: Partial<NewWorktreeOptions>): NewWorktreeOptions => ({
    ...EMPTY_NEW_WORKTREE_OPTIONS,
    path: 'D:/x',
    ref: 'main',
    ...over,
  });

  it('accepts the ordinary cases', () => {
    expect(validateNewWorktree(opts({}))).toEqual([]);
    expect(validateNewWorktree(opts({ mode: 'new', newBranch: 'feature/y' }))).toEqual([]);
    expect(validateNewWorktree(opts({ mode: 'detach', ref: 'abc' }))).toEqual([]);
  });

  it('requires a path', () => {
    expect(validateNewWorktree(opts({ path: '  ' }))).toHaveLength(1);
  });

  it('requires a branch name in "new" mode, and rejects an illegal one', () => {
    expect(validateNewWorktree(opts({ mode: 'new', newBranch: '' }))).toHaveLength(1);
    expect(
      validateNewWorktree(opts({ mode: 'new', newBranch: 'bad name' })).join(' '),
    ).toMatch(/cannot contain/);
    expect(validateNewWorktree(opts({ mode: 'new', newBranch: 'bad~name' }))).toHaveLength(1);
  });

  it('requires a ref for existing and detach, but not for new', () => {
    expect(validateNewWorktree(opts({ ref: '' }))).toHaveLength(1);
    expect(validateNewWorktree(opts({ mode: 'detach', ref: '' }))).toHaveLength(1);
    expect(validateNewWorktree(opts({ mode: 'new', newBranch: 'ok', ref: '' }))).toEqual([]);
  });
});

describe('the remaining worktree argv', () => {
  it('lists porcelain', () => {
    expect(buildWorktreeListArgs()).toEqual(['worktree', 'list', '--porcelain']);
  });

  it('removes, with and without --force', () => {
    expect(buildWorktreeRemoveArgs('D:/x', false)).toEqual(['worktree', 'remove', 'D:/x']);
    expect(buildWorktreeRemoveArgs('D:/x', true)).toEqual([
      'worktree',
      'remove',
      '--force',
      'D:/x',
    ]);
  });

  it('locks with an optional reason, and unlocks', () => {
    expect(buildWorktreeLockArgs('D:/x', '')).toEqual(['worktree', 'lock', 'D:/x']);
    expect(buildWorktreeLockArgs('D:/x', ' on a usb stick ')).toEqual([
      'worktree',
      'lock',
      '--reason',
      'on a usb stick',
      'D:/x',
    ]);
    expect(buildWorktreeUnlockArgs('D:/x')).toEqual(['worktree', 'unlock', 'D:/x']);
  });

  it('prunes', () => {
    expect(buildWorktreePruneArgs()).toEqual(['worktree', 'prune']);
  });
});

describe('defaultWorktreePath', () => {
  it('is a sibling named <repo>-<branch>', () => {
    expect(defaultWorktreePath('D:/repos/demo', 'feature')).toBe('D:/repos/demo-feature');
  });

  it('flattens slashes so the result is one directory, not a tree', () => {
    expect(defaultWorktreePath('D:/repos/demo', 'feature/x')).toBe('D:/repos/demo-feature-x');
  });

  it('keeps the separator style of the repo path', () => {
    expect(defaultWorktreePath('D:\\repos\\demo', 'wip')).toBe('D:\\repos\\demo-wip');
  });

  it('tolerates a trailing separator', () => {
    expect(defaultWorktreePath('D:/repos/demo/', 'wip')).toBe('D:/repos/demo-wip');
  });

  it('falls back to -worktree when no branch is given', () => {
    expect(defaultWorktreePath('D:/repos/demo', '  ')).toBe('D:/repos/demo-worktree');
  });
});
