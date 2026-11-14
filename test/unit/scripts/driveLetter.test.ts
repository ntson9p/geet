/**
 * `scripts/vitest.mjs` starts Vitest from the upper-case drive letter: on
 * Windows, Vitest 4 loads two copies of itself from a lower-case one
 * (vitest-dev/vitest#11872), and every suite fails.
 */
import { describe, expect, it } from 'vitest';
import { upperDriveLetter } from '../../../scripts/driveLetter.mjs';

describe('upperDriveLetter (the unit-test launcher)', () => {
  it("upper-cases a Windows path's drive letter, and nothing else", () => {
    expect(upperDriveLetter('d:\\Code\\gittree-vsix')).toBe('D:\\Code\\gittree-vsix');
    expect(upperDriveLetter('c:/Users/x/project')).toBe('C:/Users/x/project');
    expect(upperDriveLetter('d:')).toBe('D:');
    expect(upperDriveLetter('d:\\Code\\mixed\\a:b')).toBe('D:\\Code\\mixed\\a:b');
  });

  it('leaves a path that is already upper case, or has no drive letter, as it is', () => {
    expect(upperDriveLetter('D:\\Code\\gittree-vsix')).toBe('D:\\Code\\gittree-vsix');
    expect(upperDriveLetter('/home/dev/gittree-vsix')).toBe('/home/dev/gittree-vsix');
    expect(upperDriveLetter('\\\\server\\share\\gittree-vsix')).toBe('\\\\server\\share\\gittree-vsix');
    expect(upperDriveLetter('relative\\path')).toBe('relative\\path');
    expect(upperDriveLetter('')).toBe('');
  });
});
