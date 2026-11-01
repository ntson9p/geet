import { describe, expect, it } from 'vitest';
import { parseNameStatusZ } from '../../../src/branches/parsing';
import { parseCommitsNameStatus, zipChanges, type CommitFiles } from '../../../src/log/zipChanges';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);

const commit = (sha: string, ...files: Array<[string, string, string?]>): CommitFiles => ({
  sha,
  files: files.map(([status, path, origPath]) => ({ status, path, ...(origPath ? { origPath } : {}) })),
});

describe("zipChanges (IntelliJ's merge of several commits' changes)", () => {
  it("lists the files of the selected commits only, each once", () => {
    const zipped = zipChanges([
      commit(A, ['M', 'package.json']),
      commit(B, ['M', 'package.json'], ['A', 'test/store.test.ts']),
      commit(C, ['M', 'assets/data.bin']),
    ]);
    expect(zipped.map((f) => f.path)).toEqual(['package.json', 'test/store.test.ts', 'assets/data.bin']);
  });

  it('runs a file from before its earliest change to after its latest', () => {
    const [pkg] = zipChanges([commit(A, ['M', 'package.json']), commit(B, ['M', 'package.json'])]);
    expect(pkg).toEqual({ status: 'M', path: 'package.json', before: `${A}^`, after: B });
  });

  it('keeps a file added in the selection as added, ending at its latest change', () => {
    const [f] = zipChanges([commit(A, ['A', 'new.ts']), commit(B, ['M', 'new.ts'])]);
    expect(f).toEqual({ status: 'A', path: 'new.ts', after: B });
  });

  it('drops a file added and then deleted inside the selection', () => {
    expect(zipChanges([commit(A, ['A', 'tmp.ts']), commit(B, ['D', 'tmp.ts'])])).toEqual([]);
  });

  it('follows a rename chain to one row, from the first name to the last', () => {
    const [f] = zipChanges([
      commit(A, ['R100', 'b.ts', 'a.ts']),
      commit(B, ['R090', 'c.ts', 'b.ts']),
    ]);
    expect(f).toEqual({ status: 'R', path: 'c.ts', origPath: 'a.ts', before: `${A}^`, after: B });
  });

  it('a renamed file edited afterwards is still the rename', () => {
    const [f] = zipChanges([commit(A, ['R100', 'b.ts', 'a.ts']), commit(B, ['M', 'b.ts'])]);
    expect(f).toEqual({ status: 'R', path: 'b.ts', origPath: 'a.ts', before: `${A}^`, after: B });
  });

  it('a modified file deleted later is a deletion from before the first change', () => {
    const [f] = zipChanges([commit(A, ['M', 'old.ts']), commit(B, ['D', 'old.ts'])]);
    expect(f).toEqual({ status: 'D', path: 'old.ts', before: `${A}^` });
  });

  it('puts deletions at their own path, after the rest', () => {
    const zipped = zipChanges([commit(A, ['D', 'gone.ts'], ['M', 'kept.ts'])]);
    expect(zipped.map((f) => `${f.status} ${f.path}`)).toEqual(['M kept.ts', 'D gone.ts']);
  });

  it('reads a copy as a new file: the original is still there', () => {
    const [f] = zipChanges([commit(A, ['C075', 'copy.ts', 'orig.ts'])]);
    expect(f).toEqual({ status: 'A', path: 'copy.ts', after: A });
  });

  it('is empty for no commits, or commits that changed nothing', () => {
    expect(zipChanges([])).toEqual([]);
    expect(zipChanges([commit(A)])).toEqual([]);
  });
});

describe('parseCommitsNameStatus', () => {
  it("splits `git log --format=%x1e%H --name-status -z` into each commit's files", () => {
    // As git writes it: \x1e, the sha, NUL newline, then NUL-separated entries.
    const raw = `\x1e${A}\0\nA\0z\0\x1e${B}\0\nR100\0b\0c\0M\0d\0\x1e${C}\0\n`;
    expect(parseCommitsNameStatus(raw, parseNameStatusZ)).toEqual([
      { sha: A, files: [{ status: 'A', path: 'z' }] },
      { sha: B, files: [{ status: 'R', path: 'c', origPath: 'b' }, { status: 'M', path: 'd' }] },
      { sha: C, files: [] },
    ]);
  });

  it('skips anything that is not a commit record', () => {
    expect(parseCommitsNameStatus('\n\x1enot-a-sha\0\nM\0x\0', parseNameStatusZ)).toEqual([]);
  });
});
