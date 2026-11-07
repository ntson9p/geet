/**
 * POST-QA: a Stash tab row's menu names its stash by sha — the context the
 * stash commands now read, as the Shelf rows' commands read theirs.
 */
import { describe, expect, it } from 'vitest';
import { stashRowOf } from '../../../src/stash/stashRow';

describe('stashRowOf', () => {
  it('reads a stash row’s context, entry or file', () => {
    const ctx = { webviewSection: 'stashEntry', repoRoot: 'C:/work/app', stashSha: 'a'.repeat(40), preventDefaultContextMenuItems: true };
    expect(stashRowOf(ctx)).toEqual({ repoRoot: 'C:/work/app', sha: 'a'.repeat(40) });
    expect(stashRowOf({ ...ctx, webviewSection: 'stashFile', relPath: 'x.ts' })).toEqual({ repoRoot: 'C:/work/app', sha: 'a'.repeat(40) });
  });

  it('is nothing for any other argument — a tree node, a palette call, another row', () => {
    expect(stashRowOf(undefined)).toBeUndefined();
    expect(stashRowOf('stash@{0}')).toBeUndefined();
    expect(stashRowOf({ kind: 'stash' })).toBeUndefined();
    expect(stashRowOf({ webviewSection: 'shelfEntry', repoRoot: 'r', shelfId: 'x' })).toBeUndefined();
    expect(stashRowOf({ webviewSection: 'stashEntry', repoRoot: 'r' })).toBeUndefined();
  });
});
