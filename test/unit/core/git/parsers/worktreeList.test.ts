import { describe, expect, it } from 'vitest';
import {
  parseWorktreeList,
  shortBranchName,
} from '../../../../../src/core/git/parsers/worktreeList';

/**
 * P13-T6 accept: "`worktree list --porcelain` parser against fixtures (locked,
 * prunable, detached, bare)". The fixtures below are verbatim git output shapes.
 */

const SIMPLE = [
  'worktree D:/repos/demo',
  'HEAD 1111111111111111111111111111111111111111',
  'branch refs/heads/main',
  '',
  'worktree D:/repos/demo-feature',
  'HEAD 2222222222222222222222222222222222222222',
  'branch refs/heads/feature/x',
  '',
].join('\n');

const EXOTIC = [
  'worktree D:/repos/demo.git',
  'bare',
  '',
  'worktree D:/repos/demo-detached',
  'HEAD 3333333333333333333333333333333333333333',
  'detached',
  '',
  'worktree D:/repos/demo-locked',
  'HEAD 4444444444444444444444444444444444444444',
  'branch refs/heads/wip',
  'locked on a removable drive',
  '',
  'worktree D:/repos/demo-gone',
  'HEAD 5555555555555555555555555555555555555555',
  'branch refs/heads/gone',
  'prunable gitdir file points to non-existent location',
  '',
].join('\n');

describe('shortBranchName', () => {
  it('strips refs/heads/, keeping slashes inside the name', () => {
    expect(shortBranchName('refs/heads/main')).toBe('main');
    expect(shortBranchName('refs/heads/feature/x')).toBe('feature/x');
  });

  it('leaves anything else alone', () => {
    expect(shortBranchName('refs/tags/v1')).toBe('refs/tags/v1');
  });
});

describe('parseWorktreeList', () => {
  it('parses the ordinary two-worktree case', () => {
    const list = parseWorktreeList(SIMPLE);
    expect(list).toHaveLength(2);
    expect(list[0]).toMatchObject({
      path: 'D:/repos/demo',
      head: '1111111111111111111111111111111111111111',
      branch: 'main',
      detached: false,
      bare: false,
      locked: false,
      prunable: false,
      isMain: true,
    });
    expect(list[1]).toMatchObject({
      path: 'D:/repos/demo-feature',
      branch: 'feature/x',
      isMain: false,
    });
  });

  it('marks only the first record as the main worktree', () => {
    expect(parseWorktreeList(SIMPLE).map((w) => w.isMain)).toEqual([true, false]);
  });

  it('parses bare, detached, locked and prunable', () => {
    const list = parseWorktreeList(EXOTIC);
    expect(list).toHaveLength(4);

    expect(list[0]).toMatchObject({ path: 'D:/repos/demo.git', bare: true, isMain: true });
    expect(list[0]?.head).toBeUndefined();
    expect(list[0]?.branch).toBeUndefined();

    expect(list[1]).toMatchObject({ detached: true, bare: false });
    expect(list[1]?.branch).toBeUndefined();

    expect(list[2]).toMatchObject({
      branch: 'wip',
      locked: true,
      lockReason: 'on a removable drive',
    });

    expect(list[3]).toMatchObject({
      prunable: true,
      prunableReason: 'gitdir file points to non-existent location',
    });
  });

  it('handles locked and prunable with no reason attached', () => {
    const list = parseWorktreeList(
      ['worktree D:/a', 'HEAD 1111111', 'branch refs/heads/m', 'locked', 'prunable', ''].join('\n'),
    );
    expect(list[0]).toMatchObject({ locked: true, prunable: true });
    expect(list[0]?.lockReason).toBeUndefined();
    expect(list[0]?.prunableReason).toBeUndefined();
  });

  it('tolerates CRLF and a missing trailing blank line', () => {
    const crlf = SIMPLE.replace(/\n/gu, '\r\n').replace(/\r\n$/u, '');
    expect(parseWorktreeList(crlf)).toHaveLength(2);
    expect(parseWorktreeList(crlf)[1]?.branch).toBe('feature/x');
  });

  it('ignores unknown keys instead of failing on them', () => {
    const list = parseWorktreeList(
      ['worktree D:/a', 'HEAD 1111111', 'branch refs/heads/m', 'somethingNew value', ''].join('\n'),
    );
    expect(list).toHaveLength(1);
    expect(list[0]?.branch).toBe('m');
  });

  it('is empty for empty output', () => {
    expect(parseWorktreeList('')).toEqual([]);
    expect(parseWorktreeList('\n\n')).toEqual([]);
  });

  it('keeps a path containing spaces intact', () => {
    const list = parseWorktreeList(
      ['worktree D:/my repos/demo wt', 'HEAD 111', 'branch refs/heads/m', ''].join('\n'),
    );
    expect(list[0]?.path).toBe('D:/my repos/demo wt');
  });
});
