import { describe, expect, it } from 'vitest';
import { scanAddedTodos } from '../../../src/commit/checks/todoScanner';
import { buildCommitArgs } from '../../../src/commit/commitArgs';
import { computeLineChanges } from '../../../src/core/patch/lineDiff';

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
});
