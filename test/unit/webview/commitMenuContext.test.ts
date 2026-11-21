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
      'geet.commitCount': 1,
      preventDefaultContextMenuItems: true,
    });
  });

  it('is the whole selection, in its order, when the row is inside it', () => {
    const ctx = commitMenuContext(ROWS.get('b')!, ['a', 'b', 'c'], rowOf);
    expect(ctx.shas).toEqual(['a', 'b', 'c']);
    expect(ctx.sha).toBe('b');
    expect(ctx['geet.commitCount']).toBe(3);
    expect(ctx['geet.multiCommit']).toBe(true);
  });

  it('is that commit alone when the row is outside the selection', () => {
    const ctx = commitMenuContext(ROWS.get('c')!, ['a', 'b'], rowOf);
    expect(ctx.shas).toEqual(['c']);
    expect(ctx['geet.multiCommit']).toBeUndefined();
  });

  it('says when a merge is among them, for Revert/Drop/Squash Commits', () => {
    expect(commitMenuContext(ROWS.get('a')!, ['a', 'm'], rowOf)['geet.mergeSelected']).toBe(true);
    expect(commitMenuContext(ROWS.get('m')!, ['m'], rowOf)['geet.mergeSelected']).toBe(true);
    expect(commitMenuContext(ROWS.get('a')!, ['a', 'b'], rowOf)['geet.mergeSelected']).toBeUndefined();
  });

  it('counts two for Compare Versions', () => {
    expect(commitMenuContext(ROWS.get('a')!, ['a', 'c'], rowOf)['geet.commitCount']).toBe(2);
  });

  it('says when the one commit is not HEAD, for Undo Commit greyed out (POST-QA)', () => {
    const at = (refs: MenuRow['refs']): MenuRow => ({ sha: 'h', parents: ['p'], refs });
    const notHead = (r: MenuRow, sel: string[] = [r.sha]): unknown =>
      commitMenuContext(r, sel, rowOf)['geet.notHead'];
    // HEAD on a branch, and a detached HEAD.
    expect(notHead(at([{ type: 'branch', isHeadTarget: true }]))).toBeUndefined();
    expect(notHead(at([{ type: 'head' }, { type: 'tag' }]))).toBeUndefined();
    // Any other commit, refs or none.
    expect(notHead(at([{ type: 'branch' }, { type: 'remote-branch' }]))).toBe(true);
    expect(notHead(at([]))).toBe(true);
    // Several commits: Undo Commit is not in that menu at all.
    expect(notHead(at([]), ['h', 'a'])).toBeUndefined();
    // A row that does not say: left enabled, the command checks HEAD itself.
    expect(notHead(ROWS.get('a')!)).toBeUndefined();
  });
});
