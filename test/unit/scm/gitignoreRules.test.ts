import { describe, expect, it } from 'vitest';
import {
  appendPatterns,
  ignoreFileDirFor,
  ignorePattern,
  planIgnoreEdits,
} from '../../../src/scm/gitignoreRules';

describe('ignorePattern (POST-P14w)', () => {
  it('anchors to the ignore file directory', () => {
    // Unanchored, `build.log` would also hide `vendor/build.log` — a rule the
    // user did not ask for and would not see until something went missing.
    expect(ignorePattern('build.log')).toBe('/build.log');
    expect(ignorePattern('out/app/build.log')).toBe('/out/app/build.log');
  });

  it('escapes glob metacharacters so a literal name matches itself', () => {
    expect(ignorePattern('notes[1].md')).toBe('/notes\\[1\\].md');
    expect(ignorePattern('a*b?.txt')).toBe('/a\\*b\\?.txt');
    expect(ignorePattern('weird\\name.txt')).toBe('/weird/name.txt');
  });

  it('escapes a trailing space, which git would otherwise strip', () => {
    expect(ignorePattern('trailing .txt')).toBe('/trailing .txt');
    expect(ignorePattern('trailing ')).toBe('/trailing\\ ');
  });

  it('leaves `#` and `!` alone — the anchor already displaces them', () => {
    expect(ignorePattern('#notes.md')).toBe('/#notes.md');
    expect(ignorePattern('!important.md')).toBe('/!important.md');
  });
});

describe('appendPatterns (POST-P14w)', () => {
  it('adds a trailing newline to a file that lacks one', () => {
    // Without this the new rule joins the previous line and both are lost.
    expect(appendPatterns('node_modules', ['/a.txt'])).toBe('node_modules\n/a.txt\n');
  });

  it('keeps the file CRLF when it already is', () => {
    expect(appendPatterns('node_modules\r\n', ['/a.txt'])).toBe('node_modules\r\n/a.txt\r\n');
  });

  it('writes into an empty or missing file without a leading blank line', () => {
    expect(appendPatterns('', ['/a.txt', '/b.txt'])).toBe('/a.txt\n/b.txt\n');
  });

  it('says nothing to do when every pattern is already spelled out', () => {
    expect(appendPatterns('/a.txt\n/b.txt\n', ['/a.txt'])).toBeUndefined();
    // Whitespace around an existing rule still counts as that rule.
    expect(appendPatterns('  /a.txt  \n', ['/a.txt'])).toBeUndefined();
  });

  it('adds only the patterns that are missing', () => {
    expect(appendPatterns('/a.txt\n', ['/a.txt', '/b.txt'])).toBe('/a.txt\n/b.txt\n');
  });
});

describe('ignoreFileDirFor (POST-P14w)', () => {
  it('picks the nearest existing ignore file above the path', () => {
    const dirs = new Set(['', 'packages/api']);
    expect(ignoreFileDirFor('packages/api/src/gen.ts', dirs)).toBe('packages/api');
    expect(ignoreFileDirFor('packages/web/src/gen.ts', dirs)).toBe('');
  });

  it('falls back to the repository root when nothing above has one', () => {
    expect(ignoreFileDirFor('a/b/c.txt', new Set())).toBe('');
  });

  it('never picks the file itself, even if a directory shares its name', () => {
    expect(ignoreFileDirFor('build', new Set(['build']))).toBe('');
  });
});

describe('planIgnoreEdits (POST-P14w)', () => {
  it('splits a selection across the ignore files that own each path', () => {
    const edits = planIgnoreEdits(
      ['packages/api/gen.ts', 'packages/web/gen.ts', 'root.log'],
      new Set(['', 'packages/api']),
    );
    expect(edits).toEqual([
      // Relative to its OWN directory — a package `.gitignore` saying
      // `/packages/api/gen.ts` would match nothing.
      { dir: 'packages/api', patterns: ['/gen.ts'] },
      { dir: '', patterns: ['/packages/web/gen.ts', '/root.log'] },
    ]);
  });

  it('collapses two rows that would write the same pattern', () => {
    expect(planIgnoreEdits(['a.txt', 'a.txt'], new Set())).toEqual([
      { dir: '', patterns: ['/a.txt'] },
    ]);
  });
});
