import { describe, expect, it } from 'vitest';
import { scanAddedTodos } from '../../../src/commit/checks/todoScanner';
import { buildCommitArgs } from '../../../src/commit/commitArgs';
import { computeLineChanges } from '../../../src/core/patch/lineDiff';
import { isValidAuthor } from '../../../src/shared/protocol';

describe('scanAddedTodos', () => {
  const pattern = /\b(TODO|FIXME)\b/;

  it('reports TODOs on added lines only, ignoring pre-existing ones', () => {
    const original = ['line 1', '// TODO old marker stays', 'line 3'].join('\n') + '\n';
    const modified =
      ['line 1', '// TODO old marker stays', 'line 3', '// TODO new one', 'ok', '// FIXME another'].join('\n') + '\n';
    const changes = computeLineChanges(original, modified);
    const hits = scanAddedTodos(changes, modified, pattern);
    expect(hits.map((h) => h.line)).toEqual([4, 6]);
    expect(hits[0]?.text).toBe('// TODO new one');
  });

  it('sees a TODO on a MODIFIED line (counts as added content)', () => {
    const original = 'function x() {}\n';
    const modified = 'function x() {} // TODO refactor\n';
    const hits = scanAddedTodos(computeLineChanges(original, modified), modified, pattern);
    expect(hits).toHaveLength(1);
  });

  it('ignores TODO-free additions and deletions', () => {
    const original = 'a\n// TODO gone\nb\n';
    const modified = 'a\nb\nnew line\n';
    const hits = scanAddedTodos(computeLineChanges(original, modified), modified, pattern);
    expect(hits).toHaveLength(0);
  });

  it('respects a custom pattern', () => {
    const original = '';
    const modified = '// HACK terrible\n';
    const hits = scanAddedTodos(computeLineChanges(original, modified), modified, /\bHACK\b/);
    expect(hits).toHaveLength(1);
  });
});

describe('buildCommitArgs', () => {
  it('staged commit with message', () => {
    expect(buildCommitArgs('staged', 'msg', { amend: false, sign: false })).toEqual([
      'commit',
      '-m',
      'msg',
    ]);
  });

  it('changelist --only commit lists paths after --', () => {
    expect(buildCommitArgs('only', 'msg', { amend: false, sign: false }, ['a.ts', 'dir/b.ts'])).toEqual([
      'commit',
      '-m',
      'msg',
      '--only',
      '--',
      'a.ts',
      'dir/b.ts',
    ]);
  });

  it('amend without message uses --no-edit', () => {
    expect(buildCommitArgs('staged', '', { amend: true, sign: false })).toEqual([
      'commit',
      '--amend',
      '--no-edit',
    ]);
  });

  it('sign + amend + all compose', () => {
    expect(buildCommitArgs('all', 'm', { amend: true, sign: true })).toEqual([
      'commit',
      '-S',
      '--amend',
      '-m',
      'm',
      '--all',
    ]);
  });

  // P11-T5: --author= and -s. One argv element each — git handles the quoting,
  // never the shell, so a comma or non-ASCII name must pass through verbatim.
  it('author override with a comma in the name', () => {
    expect(
      buildCommitArgs('staged', 'msg', { amend: false, sign: false, author: 'Doe, John <j@example.com>' }),
    ).toEqual(['commit', '--author=Doe, John <j@example.com>', '-m', 'msg']);
  });

  it('author override with a non-ASCII name', () => {
    expect(
      buildCommitArgs('staged', 'msg', {
        amend: false,
        sign: false,
        author: 'Nguyễn Trường Sơn <son@例え.jp>',
      }),
    ).toContain('--author=Nguyễn Trường Sơn <son@例え.jp>');
  });

  it('sign-off adds -s and composes with -S, --amend and --author', () => {
    expect(
      buildCommitArgs('staged', 'msg', {
        amend: true,
        sign: true,
        signoff: true,
        author: 'A B <a@b.c>',
      }),
    ).toEqual(['commit', '-S', '-s', '--author=A B <a@b.c>', '--amend', '-m', 'msg']);
  });

  it('an empty author never emits a bare --author=', () => {
    expect(buildCommitArgs('staged', 'msg', { amend: false, sign: false, author: '' })).toEqual([
      'commit',
      '-m',
      'msg',
    ]);
  });
});

describe('isValidAuthor (P11-T5)', () => {
  it('accepts git-shaped authors, commas and non-ASCII included', () => {
    for (const ok of [
      'Ada Lovelace <ada@example.com>',
      'Doe, John <j@x.co>',
      'Nguyễn Trường Sơn <son@例え.jp>',
      'a <a@localhost>',
    ]) {
      expect(isValidAuthor(ok), ok).toBe(true);
    }
  });

  it('rejects everything that is not Name <email>', () => {
    for (const bad of [
      '',
      'just a name',
      '<a@b.c>',
      ' <a@b.c>',
      'name <no-at-sign>',
      'name <a@b.c> trailing',
      'angle < in name <a@b.c>',
      'name <spa ce@b.c>',
    ]) {
      expect(isValidAuthor(bad), bad).toBe(false);
    }
  });
});
