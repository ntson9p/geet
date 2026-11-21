import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  applyLineChanges,
  buildPatch,
  complementChanges,
  type LineChange,
} from '../../../../src/core/patch/patchBuilder';
import { FixtureRepo } from '../../../fixtures/fixtureRepo';

const change = (
  originalStartLineNumber: number,
  originalEndLineNumber: number,
  modifiedStartLineNumber: number,
  modifiedEndLineNumber: number,
): LineChange => ({
  originalStartLineNumber,
  originalEndLineNumber,
  modifiedStartLineNumber,
  modifiedEndLineNumber,
});

describe('applyLineChanges', () => {
  const original = 'one\ntwo\nthree\nfour\nfive\n';

  it('applies nothing → original; everything → modified', () => {
    const modified = 'one\nTWO!\nthree\nfour\nfive\nsix\n';
    const changes = [change(2, 2, 2, 2), change(5, 0, 6, 6)];
    expect(applyLineChanges(original, modified, [])).toBe(original);
    expect(applyLineChanges(original, modified, changes)).toBe(modified);
  });

  it('applies a single middle modification', () => {
    const modified = 'one\nTWO!\nthree\nfour\nfive\n';
    expect(applyLineChanges(original, modified, [change(2, 2, 2, 2)])).toBe(modified);
  });

  it('applies insert-only changes (top, middle, bottom)', () => {
    const top = 'zero\none\ntwo\nthree\nfour\nfive\n';
    expect(applyLineChanges(original, top, [change(0, 0, 1, 1)])).toBe(top);
    const middle = 'one\ntwo\nmid\nthree\nfour\nfive\n';
    expect(applyLineChanges(original, middle, [change(2, 0, 3, 3)])).toBe(middle);
    const bottom = 'one\ntwo\nthree\nfour\nfive\nsix\n';
    expect(applyLineChanges(original, bottom, [change(5, 0, 6, 6)])).toBe(bottom);
  });

  it('applies delete-only changes', () => {
    const modified = 'one\nthree\nfour\nfive\n';
    expect(applyLineChanges(original, modified, [change(2, 2, 1, 0)])).toBe(modified);
  });

  it('handles adjacent hunks independently', () => {
    const modified = 'ONE\nTWO\nthree\nfour\nfive\n';
    const changes = [change(1, 1, 1, 1), change(2, 2, 2, 2)];
    expect(applyLineChanges(original, modified, [changes[0]!])).toBe('ONE\ntwo\nthree\nfour\nfive\n');
    expect(applyLineChanges(original, modified, [changes[1]!])).toBe('one\nTWO\nthree\nfour\nfive\n');
    expect(applyLineChanges(original, modified, changes)).toBe(modified);
  });

  it('preserves CRLF content byte-exact', () => {
    const orig = 'a\r\nb\r\nc\r\n';
    const mod = 'a\r\nB!\r\nc\r\n';
    expect(applyLineChanges(orig, mod, [change(2, 2, 2, 2)])).toBe(mod);
    expect(applyLineChanges(orig, mod, [])).toBe(orig);
  });

  it('handles missing EOL at EOF on either side', () => {
    const noEofOrig = 'one\ntwo\nthree';
    const withEofMod = 'one\ntwo\nTHREE\n';
    expect(applyLineChanges(noEofOrig, withEofMod, [change(3, 3, 3, 3)])).toBe(withEofMod);

    const withEofOrig = 'one\ntwo\nthree\n';
    const noEofMod = 'one\ntwo\nTHREE';
    expect(applyLineChanges(withEofOrig, noEofMod, [change(3, 3, 3, 3)])).toBe(noEofMod);
  });

  it('complementChanges drops the given indices', () => {
    const changes = [change(1, 1, 1, 1), change(3, 3, 3, 3), change(5, 5, 5, 5)];
    expect(complementChanges(changes, [1])).toEqual([changes[0], changes[2]]);
  });
});

describe('buildPatch → real git apply --cached round-trip', () => {
  const repos: FixtureRepo[] = [];
  afterAll(() => {
    for (const r of repos) r.dispose();
  });

  /** Commits original, writes modified, stages via our patch, returns staged text. */
  function stageViaPatch(original: string, modified: string, changes: LineChange[]): string {
    const repo = FixtureRepo.create({ prefix: 'geet-patch-' });
    repos.push(repo);
    repo.commit('base', { 'file.txt': original });
    fs.writeFileSync(path.join(repo.root, 'file.txt'), modified);
    const patch = buildPatch({ relPath: 'file.txt', originalText: original, modifiedText: modified, changes });
    execFileSync('git', ['apply', '--cached', '--unidiff-zero', '-'], {
      cwd: repo.root,
      input: patch,
    });
    return execFileSync('git', ['show', ':0:file.txt'], { cwd: repo.root }).toString('utf8');
  }

  it('stages a middle modification hunk only', () => {
    const original = 'one\ntwo\nthree\nfour\nfive\n';
    const modified = 'one\nTWO!\nthree\nfour\nFIVE!\n';
    const staged = stageViaPatch(original, modified, [change(2, 2, 2, 2)]);
    expect(staged).toBe('one\nTWO!\nthree\nfour\nfive\n');
  });

  it('stages an insertion hunk', () => {
    const original = 'one\ntwo\nthree\n';
    const modified = 'one\ntwo\nnew A\nnew B\nthree\n';
    const staged = stageViaPatch(original, modified, [change(2, 0, 3, 4)]);
    expect(staged).toBe(modified);
  });

  it('stages a deletion hunk', () => {
    const original = 'one\ntwo\nthree\nfour\n';
    const modified = 'one\nfour\n';
    const staged = stageViaPatch(original, modified, [change(2, 3, 1, 0)]);
    expect(staged).toBe(modified);
  });

  it('stages one of two adjacent hunks', () => {
    const original = 'a\nb\nc\nd\ne\nf\n';
    const modified = 'a\nB\nc\nd\nE\nf\n';
    const staged = stageViaPatch(original, modified, [change(2, 2, 2, 2)]);
    expect(staged).toBe('a\nB\nc\nd\ne\nf\n');
  });

  it('stages CRLF hunks byte-exact', () => {
    const original = 'a\r\nb\r\nc\r\n';
    const modified = 'a\r\nB!\r\nc\r\n';
    const staged = stageViaPatch(original, modified, [change(2, 2, 2, 2)]);
    expect(staged).toBe(modified);
  });

  it('stages a change to the last line when the file has no trailing newline', () => {
    const original = 'one\ntwo\nthree';
    const modified = 'one\ntwo\nTHREE';
    const staged = stageViaPatch(original, modified, [change(3, 3, 3, 3)]);
    expect(staged).toBe(modified);
  });

  it('stages an append that adds a trailing-newline-less last line', () => {
    const original = 'one\ntwo\n';
    const modified = 'one\ntwo\nthree';
    const staged = stageViaPatch(original, modified, [change(2, 0, 3, 3)]);
    expect(staged).toBe(modified);
  });

  it('multi-hunk patch stages all selected hunks at once', () => {
    const original = 'l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\n';
    const modified = 'l1\nL2\nl3\nl4\nINSERTED\nl5\nl6\nl8\n';
    const changes = [change(2, 2, 2, 2), change(4, 0, 5, 5), change(7, 7, 7, 0)];
    const staged = stageViaPatch(original, modified, changes);
    expect(staged).toBe(modified);
  });
});
