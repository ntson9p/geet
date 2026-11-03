import { describe, expect, it } from 'vitest';
import { nextMark } from '../../../src/diff/onScreen';

interface File {
  readonly sha: string;
  readonly path: string;
}
const same = (a: File, b: File): boolean => a.sha === b.sha && a.path === b.path;
const app: File = { sha: 'c1', path: 'src/app.ts' };
const util: File = { sha: 'c1', path: 'src/util.ts' };

describe('the file a list marks as on screen', () => {
  it('is the file whose diff came on screen', () => {
    expect(nextMark(undefined, app, true, same)).toEqual({ mark: app });
    // A walk on: the next file takes the mark, whatever was marked.
    expect(nextMark(app, util, true, same)).toEqual({ mark: util });
  });

  it('goes when that diff leaves the screen', () => {
    expect(nextMark(app, { ...app }, false, same)).toEqual({ mark: undefined });
  });

  it('stays when a diff of another file leaves', () => {
    expect(nextMark(util, app, false, same)).toBe('unchanged');
    // The same path from another commit is another diff.
    expect(nextMark(app, { sha: 'c2', path: app.path }, false, same)).toBe('unchanged');
  });

  it('has nothing to say when nothing was marked and a diff leaves', () => {
    expect(nextMark(undefined, app, false, same)).toBe('unchanged');
  });

  it('ends where it was when a list read again hands over its entry', () => {
    // The entry leaving is told first, then the new one for the same file.
    const left = nextMark(app, app, false, same);
    expect(left).toEqual({ mark: undefined });
    const came = nextMark(left === 'unchanged' ? app : left.mark, { ...app }, true, same);
    expect(came).toEqual({ mark: app });
  });
});
