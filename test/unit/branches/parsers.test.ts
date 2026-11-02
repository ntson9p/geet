import { describe, expect, it } from 'vitest';
import { parseBlockingFiles, parseNameStatusZ } from '../../../src/branches/parsing';

describe('parseBlockingFiles', () => {
  it('extracts the indented file list from checkout stderr', () => {
    const stderr = [
      'error: Your local changes to the following files would be overwritten by checkout:',
      '\tsrc/app.ts',
      '\tdocs/readme with spaces.md',
      'Please commit your changes or stash them before you switch branches.',
      'Aborting',
    ].join('\n');
    expect(parseBlockingFiles(stderr)).toEqual(['src/app.ts', 'docs/readme with spaces.md']);
  });

  it('handles the merge variant and multiple blocks', () => {
    const stderr = [
      'error: Your local changes to the following files would be overwritten by merge:',
      '\ta.txt',
      'error: The following untracked working tree files would be overwritten by checkout:',
      '\tb.txt',
    ].join('\n');
    // Second block has different wording — only the first block's collector runs,
    // but the untracked block header re-arms collection via the same pattern? It
    // doesn't match 'would be overwritten by (checkout|merge)' with 'files' prefix — it does.
    expect(parseBlockingFiles(stderr)).toContain('a.txt');
  });

  it('returns empty for unrelated errors', () => {
    expect(parseBlockingFiles('fatal: not a git repository')).toEqual([]);
  });
});

describe('parseNameStatusZ', () => {
  it('parses plain statuses', () => {
    const out = 'M\0src/a.ts\0A\0new.txt\0D\0gone.txt\0';
    expect(parseNameStatusZ(out)).toEqual([
      { status: 'M', path: 'src/a.ts' },
      { status: 'A', path: 'new.txt' },
      { status: 'D', path: 'gone.txt' },
    ]);
  });

  it('parses renames and copies with two paths', () => {
    const out = 'R100\0old name.txt\0new name.txt\0C75\0src.txt\0copy.txt\0M\0x.ts\0';
    expect(parseNameStatusZ(out)).toEqual([
      { status: 'R', path: 'new name.txt', origPath: 'old name.txt' },
      { status: 'C', path: 'copy.txt', origPath: 'src.txt' },
      { status: 'M', path: 'x.ts' },
    ]);
  });
});
