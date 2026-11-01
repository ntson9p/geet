import { describe, expect, it } from 'vitest';
import { commitMenuContext, type MenuRow } from '../../../webview-ui/src/log/commitMenuContext';

const row = (sha: string, ...parents: string[]): MenuRow => ({ sha, parents });
const ROWS = new Map<string, MenuRow>([
  ['a', row('a', 'b')],
  ['b', row('b', 'c')],
  ['m', row('m', 'b', 'x')],
  ['c', row('c', 'd')],
]);
const rowOf = (sha: string): MenuRow | undefined => ROWS.get(sha);

describe("commitMenuContext (what VS Code's menu reads off a commit row)", () => {
  it('is one commit when the row is the only one selected', () => {
    expect(commitMenuContext(ROWS.get('a')!, ['a'], rowOf)).toEqual({
      webviewSection: 'commit',
      sha: 'a',
      shas: ['a'],
      'gittree.commitCount': 1,
      preventDefaultContextMenuItems: true,
    });
  });

  it('is the whole selection, in its order, when the row is inside it', () => {
    const ctx = commitMenuContext(ROWS.get('b')!, ['a', 'b', 'c'], rowOf);
    expect(ctx.shas).toEqual(['a', 'b', 'c']);
    expect(ctx.sha).toBe('b');
    expect(ctx['gittree.commitCount']).toBe(3);
    expect(ctx['gittree.multiCommit']).toBe(true);
  });

  it('is that commit alone when the row is outside the selection', () => {
    const ctx = commitMenuContext(ROWS.get('c')!, ['a', 'b'], rowOf);
    expect(ctx.shas).toEqual(['c']);
    expect(ctx['gittree.multiCommit']).toBeUndefined();
  });

  it('says when a merge is among them, for Revert/Drop/Squash Commits', () => {
    expect(commitMenuContext(ROWS.get('a')!, ['a', 'm'], rowOf)['gittree.mergeSelected']).toBe(true);
    expect(commitMenuContext(ROWS.get('m')!, ['m'], rowOf)['gittree.mergeSelected']).toBe(true);
    expect(commitMenuContext(ROWS.get('a')!, ['a', 'b'], rowOf)['gittree.mergeSelected']).toBeUndefined();
  });

  it('counts two for Compare Versions', () => {
    expect(commitMenuContext(ROWS.get('a')!, ['a', 'c'], rowOf)['gittree.commitCount']).toBe(2);
  });
});
