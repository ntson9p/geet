/**
 * POST-P14ck: paths handed to git as pathspecs are read as names. The helper
 * itself, pure: which paths get `:(literal)`, how a filter shows one, git's
 * reading of a boolean variable, and the prefix coming off again where
 * `GIT_LITERAL_PATHSPECS` already makes every pathspec literal.
 */
import { describe, expect, it } from 'vitest';
import {
  gitBoolean,
  LITERAL_MAGIC,
  literalPathspec,
  literalPathspecs,
  pathOfPathspec,
  pathspecsForEnvironment,
} from '../../../../src/core/git/pathspec';

describe('literalPathspec', () => {
  it('leaves a path with nothing git would glob or read as magic as it is', () => {
    for (const p of [
      'src/a.ts',
      'a b.txt',
      'ünïcödé.md',
      'dir/',
      '.',
      'odd]name.txt',
      '{a,b}.txt',
      '!bang.txt',
      'semi;colon.txt',
      'C:colon-later.txt',
      'dir/:colon-later.txt',
    ]) {
      expect(literalPathspec(p)).toBe(p);
    }
  });

  it('prefixes every path git would read as a pattern', () => {
    expect(literalPathspec('[id].tsx')).toBe(':(literal)[id].tsx');
    expect(literalPathspec('app/[locale]/page.tsx')).toBe(':(literal)app/[locale]/page.tsx');
    expect(literalPathspec('pages/api/auth/[...nextauth].ts')).toBe(':(literal)pages/api/auth/[...nextauth].ts');
    expect(literalPathspec('a*b.txt')).toBe(':(literal)a*b.txt');
    expect(literalPathspec('what?.txt')).toBe(':(literal)what?.txt');
    expect(literalPathspec('back\\slash.txt')).toBe(':(literal)back\\slash.txt');
  });

  it('prefixes a path that starts with a colon, which git would open as magic', () => {
    expect(literalPathspec(':colon.txt')).toBe(':(literal):colon.txt');
    expect(literalPathspec(':!not-negated.txt')).toBe(':(literal):!not-negated.txt');
    expect(literalPathspec(':(glob)x')).toBe(':(literal):(glob)x');
  });

  it('takes a path, never a pathspec: one already prefixed is prefixed again', () => {
    // So a double-wrap fails loudly in git ("did not match") instead of
    // naming the wrong file.
    expect(literalPathspec(':(literal)[id].tsx')).toBe(':(literal):(literal)[id].tsx');
  });

  it('maps a list, keeping its order and its plain paths', () => {
    expect(literalPathspecs(['a.ts', '[id].tsx', 'b/c.ts'])).toEqual(['a.ts', ':(literal)[id].tsx', 'b/c.ts']);
    expect(literalPathspecs([])).toEqual([]);
  });
});

describe('pathOfPathspec', () => {
  it('shows the path a literal pathspec names', () => {
    expect(pathOfPathspec(':(literal)[id].tsx')).toBe('[id].tsx');
    expect(pathOfPathspec(':(literal)app/[locale]/page.tsx')).toBe('app/[locale]/page.tsx');
  });

  it('shows anything else as it is — a typed pattern stays what was typed', () => {
    expect(pathOfPathspec('src/**/*.ts')).toBe('src/**/*.ts');
    expect(pathOfPathspec('[id].tsx')).toBe('[id].tsx');
    expect(pathOfPathspec(':(glob)src/*')).toBe(':(glob)src/*');
  });

  it('takes one prefix off, the one literalPathspec puts on', () => {
    expect(pathOfPathspec(literalPathspec(':(literal)x'))).toBe(':(literal)x');
    expect(LITERAL_MAGIC).toBe(':(literal)');
  });
});

describe('gitBoolean (git_parse_maybe_bool)', () => {
  it('reads the words in any case, and empty as false', () => {
    expect(gitBoolean('true')).toBe(true);
    expect(gitBoolean('TRUE')).toBe(true);
    expect(gitBoolean('Yes')).toBe(true);
    expect(gitBoolean('on')).toBe(true);
    expect(gitBoolean('false')).toBe(false);
    expect(gitBoolean('NO')).toBe(false);
    expect(gitBoolean('off')).toBe(false);
    expect(gitBoolean('')).toBe(false);
  });

  it('reads a number as true when it is not zero, units and hex included', () => {
    expect(gitBoolean('1')).toBe(true);
    expect(gitBoolean('2')).toBe(true);
    expect(gitBoolean('-1')).toBe(true);
    expect(gitBoolean(' 1')).toBe(true);
    expect(gitBoolean('1k')).toBe(true);
    expect(gitBoolean('0x10')).toBe(true);
    expect(gitBoolean('0')).toBe(false);
    expect(gitBoolean('00')).toBe(false);
    expect(gitBoolean('0k')).toBe(false);
    expect(gitBoolean('0x0')).toBe(false);
  });

  it('has no answer for what git refuses', () => {
    expect(gitBoolean('maybe')).toBeUndefined();
    expect(gitBoolean('1 ')).toBeUndefined();
    expect(gitBoolean('1x')).toBeUndefined();
  });
});

describe('pathspecsForEnvironment', () => {
  const args = ['commit', '-m', ':(literal) a message', '--only', '--', ':(literal)[id].tsx', 'a.ts'];

  it('changes nothing while git reads pathspecs as patterns', () => {
    expect(pathspecsForEnvironment(args, {}, 'linux')).toBe(args);
    expect(pathspecsForEnvironment(args, { GIT_LITERAL_PATHSPECS: '0' }, 'linux')).toBe(args);
    expect(pathspecsForEnvironment(args, { GIT_LITERAL_PATHSPECS: 'false' }, 'linux')).toBe(args);
    expect(pathspecsForEnvironment(args, { GIT_LITERAL_PATHSPECS: '' }, 'linux')).toBe(args);
  });

  it('takes the prefix off after `--` when the environment reads them literally', () => {
    expect(pathspecsForEnvironment(args, { GIT_LITERAL_PATHSPECS: '1' }, 'linux')).toEqual([
      'commit',
      '-m',
      ':(literal) a message',
      '--only',
      '--',
      '[id].tsx',
      'a.ts',
    ]);
    expect(pathspecsForEnvironment(args, { GIT_LITERAL_PATHSPECS: 'yes' }, 'win32')).toEqual(
      pathspecsForEnvironment(args, { GIT_LITERAL_PATHSPECS: '1' }, 'linux'),
    );
  });

  it('never touches what comes before `--`, nor a command without one', () => {
    const noDashes = ['stash', 'push', '-m', ':(literal)wip'];
    expect(pathspecsForEnvironment(noDashes, { GIT_LITERAL_PATHSPECS: '1' }, 'linux')).toBe(noDashes);
    const out = pathspecsForEnvironment(args, { GIT_LITERAL_PATHSPECS: '1' }, 'linux');
    expect(out[2]).toBe(':(literal) a message');
  });

  it('leaves a value git refuses to git, which then says so itself', () => {
    expect(pathspecsForEnvironment(args, { GIT_LITERAL_PATHSPECS: 'maybe' }, 'linux')).toBe(args);
  });

  it('finds the variable in any case on Windows, and only there', () => {
    const lower = { git_literal_pathspecs: '1' };
    expect(pathspecsForEnvironment(args, lower, 'win32')).toContain('[id].tsx');
    expect(pathspecsForEnvironment(args, lower, 'linux')).toBe(args);
  });
});
