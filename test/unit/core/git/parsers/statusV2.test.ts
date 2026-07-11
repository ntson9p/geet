import { describe, expect, it } from 'vitest';
import { parseStatusV2, type StatusEntry } from '../../../../../src/core/git/parsers/statusV2';
import { fixture } from './fixtures';

function byPath(entries: StatusEntry[], p: string): StatusEntry {
  const e = entries.find((x) => x.path === p);
  if (!e) throw new Error(`no entry for ${p}; got ${entries.map((x) => x.path).join(', ')}`);
  return e;
}

describe('parseStatusV2 (captured fixtures)', () => {
  it('parses the basic mixed worktree', () => {
    const { header, entries } = parseStatusV2(fixture('status-basic.bin'));
    expect(header.head).toBe('main');
    expect(header.detached).toBe(false);
    expect(header.initial).toBe(false);
    expect(header.oid).toMatch(/^[0-9a-f]{40}$/);
    expect(header.upstream).toBeUndefined();
    expect(header.upstreamGone).toBe(false);

    const del = byPath(entries, 'deleted.txt');
    expect(del).toMatchObject({ kind: 'ordinary', x: '.', y: 'D' });
    expect(del.shaHead).toMatch(/^[0-9a-f]{40}$/);

    expect(byPath(entries, 'modified-staged.txt')).toMatchObject({ x: 'M', y: '.' });
    expect(byPath(entries, 'modified-unstaged.txt')).toMatchObject({ x: '.', y: 'M' });
    // Paths with spaces survive field splitting.
    expect(byPath(entries, 'name with spaces.txt')).toMatchObject({ x: '.', y: 'M' });
    // Intent-to-add: zero-sha normalizes to undefined.
    const ita = byPath(entries, 'untracked-new.txt');
    expect(ita.shaHead).toBeUndefined();
    expect(ita.shaIndex).toBeUndefined();
    // Untracked incl. unicode path.
    expect(byPath(entries, 'plain-untracked.txt').kind).toBe('untracked');
    expect(byPath(entries, 'ünïcode/新しい.txt').kind).toBe('untracked');
  });

  it('parses a staged rename with -z second path', () => {
    const { entries } = parseStatusV2(fixture('status-rename.bin'));
    expect(entries).toHaveLength(1);
    const r = entries[0] as StatusEntry;
    expect(r.kind).toBe('renamed');
    expect(r.path).toBe('new name with spaces.txt');
    expect(r.origPath).toBe('old-name.txt');
    expect(r.renameScore).toBe(100);
    expect(r.x).toBe('R');
    expect(r.y).toBe('.');
  });

  it('parses unmerged entries with stage masks', () => {
    const { entries } = parseStatusV2(fixture('status-unmerged.bin'));
    const aa = byPath(entries, 'both-added.txt');
    expect(aa.kind).toBe('unmerged');
    expect(aa.x).toBe('A');
    expect(aa.y).toBe('A');
    expect(aa.stages?.mode1).toBe('000000'); // no base for add/add
    expect(aa.stages?.sha2).toMatch(/^[0-9a-f]{40}$/);

    const uu = byPath(entries, 'conflict.txt');
    expect(uu.x).toBe('U');
    expect(uu.y).toBe('U');
    expect(uu.stages?.mode1).toBe('100644');
    expect(uu.stages?.sha1).not.toBe(uu.stages?.sha2);
    expect(uu.stages?.sha2).not.toBe(uu.stages?.sha3);
  });

  it('parses detached HEAD', () => {
    const { header, entries } = parseStatusV2(fixture('status-detached.bin'));
    expect(header.detached).toBe(true);
    expect(header.head).toBeUndefined();
    expect(header.oid).toMatch(/^[0-9a-f]{40}$/);
    expect(entries).toHaveLength(0);
  });

  it('parses ahead/behind counts', () => {
    const { header } = parseStatusV2(fixture('status-ab.bin'));
    expect(header.upstream).toBe('origin/main');
    expect(header.ahead).toBe(1);
    expect(header.behind).toBe(1);
    expect(header.upstreamGone).toBe(false);
  });

  it('detects gone upstream (upstream header without ab)', () => {
    const { header } = parseStatusV2(fixture('status-upstream-gone.bin'));
    expect(header.upstream).toBe('origin/doomed');
    expect(header.ahead).toBeUndefined();
    expect(header.upstreamGone).toBe(true);
  });

  it('parses an unborn branch (synthetic — git emits (initial))', () => {
    const { header } = parseStatusV2('# branch.oid (initial)\0# branch.head main\0');
    expect(header.initial).toBe(true);
    expect(header.oid).toBeUndefined();
    expect(header.head).toBe('main');
  });

  it('parses copies and ignored entries (synthetic)', () => {
    const out =
      '1 MM S.M. 160000 160000 160000 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb sub/module\0' +
      '2 C. N... 100644 100644 100644 cccccccccccccccccccccccccccccccccccccccc cccccccccccccccccccccccccccccccccccccccc C075 copy dest.txt\0copy src.txt\0' +
      '! build/output.js\0';
    const { entries } = parseStatusV2(out);
    expect(byPath(entries, 'sub/module').submodule).toBe('S.M.');
    const copy = byPath(entries, 'copy dest.txt');
    expect(copy.kind).toBe('copied');
    expect(copy.origPath).toBe('copy src.txt');
    expect(copy.renameScore).toBe(75);
    expect(byPath(entries, 'build/output.js').kind).toBe('ignored');
  });

  it('tolerates empty output', () => {
    const { header, entries } = parseStatusV2('');
    expect(entries).toHaveLength(0);
    expect(header.detached).toBe(false);
  });
});
