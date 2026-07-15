/**
 * patchParser against real git: sections split losslessly and applyHunks
 * reconstructs the exact worktree bytes that `git diff` described — the
 * property P7-T4's shelf diff preview and P7-T5's partial unshelve rely on.
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { applyHunks, splitPatchFiles } from '../../../../src/core/patch/patchParser';

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

function repo(): { root: string; git: (...a: string[]) => string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gittree-parser-'));
  cleanups.push(() => {
    try {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      /* tmp */
    }
  });
  const git = (...a: string[]): string =>
    execFileSync('git', a, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  git('init');
  git('config', 'user.name', 'T');
  git('config', 'user.email', 't@t');
  git('config', 'commit.gpgsign', 'false');
  git('config', 'core.autocrlf', 'false');
  return { root, git };
}

/** Full P7 capture flavor: diff worktree vs HEAD with untracked via add -N. */
function capture(r: ReturnType<typeof repo>): string {
  const untracked = r
    .git('status', '--porcelain', '-z', '--untracked-files=all')
    .split('\0')
    .filter((e) => e.startsWith('??'))
    .map((e) => e.slice(3));
  if (untracked.length > 0) r.git('add', '-N', '--', ...untracked);
  try {
    return r.git('diff', '--binary', '--full-index', '--no-renames', 'HEAD');
  } finally {
    if (untracked.length > 0) r.git('reset', '-q', '--', ...untracked);
  }
}

describe('patchParser vs real git', () => {
  it('splits sections losslessly and reconstructs every text flavor', () => {
    const r = repo();
    const w = (rel: string, c: string | Buffer): void => fs.writeFileSync(path.join(r.root, rel), c);
    w('mod.txt', 'one\ntwo\nthree\nfour\nfive\n');
    w('gone.txt', 'doomed\n');
    w('crlf.txt', 'a\r\nb\r\nc\r\n');
    w('noeol.txt', 'x\ny'); // no final newline in base
    w('img.bin', Buffer.from([0, 1, 2, 3]));
    r.git('add', '-A');
    r.git('commit', '-m', 'base');

    w('mod.txt', 'one\nTWO\nthree\nfour\nFIVE\nsix\n'); // two hunks
    fs.rmSync(path.join(r.root, 'gone.txt'));
    w('crlf.txt', 'a\r\nB!\r\nc\r\n');
    w('noeol.txt', 'x\nY\nz'); // still no final newline
    w('img.bin', Buffer.from([9, 9, 9]));
    w('fresh.txt', 'brand\nnew\n'); // untracked

    const patch = capture(r);
    const sections = splitPatchFiles(patch);
    expect(sections.map((s) => s.text).join('')).toBe(patch); // lossless split
    const byPath = new Map(sections.map((s) => [s.relPath, s]));
    expect(byPath.get('gone.txt')?.status).toBe('deleted');
    expect(byPath.get('fresh.txt')?.status).toBe('added');
    expect(byPath.get('img.bin')?.isBinary).toBe(true);
    expect(byPath.get('mod.txt')?.status).toBe('modified');
    expect((byPath.get('mod.txt')?.hunks.length ?? 0) >= 1).toBe(true);

    // applyHunks(base) must equal the worktree bytes for every text file.
    for (const rel of ['mod.txt', 'gone.txt', 'crlf.txt', 'noeol.txt', 'fresh.txt']) {
      const section = byPath.get(rel)!;
      const base = section.status === 'added' ? '' : r.git('show', `HEAD:${rel}`);
      const expected =
        section.status === 'deleted' ? '' : fs.readFileSync(path.join(r.root, rel), 'utf8');
      expect(applyHunks(base, section.hunks), rel).toBe(expected);
    }
  });

  it('handles no-final-newline transitions in both directions', () => {
    const r = repo();
    const w = (rel: string, c: string): void => fs.writeFileSync(path.join(r.root, rel), c);
    w('gain.txt', 'a\nb'); // base lacks final newline
    w('lose.txt', 'a\nb\n'); // base has one
    r.git('add', '-A');
    r.git('commit', '-m', 'base');
    w('gain.txt', 'a\nb\nc\n'); // gains it
    w('lose.txt', 'a\nB'); // loses it

    const sections = splitPatchFiles(capture(r));
    for (const s of sections) {
      const base = r.git('show', `HEAD:${s.relPath}`);
      expect(applyHunks(base, s.hunks), s.relPath).toBe(
        fs.readFileSync(path.join(r.root, s.relPath), 'utf8'),
      );
    }
  });

  it('tolerates editor-stripped context blanks and quoted import paths', () => {
    // A hand-edited hunk where the empty context line lost its leading space.
    const patch = [
      'diff --git a/f.txt b/f.txt',
      'index 000..111 100644',
      '--- a/f.txt',
      '+++ b/f.txt',
      '@@ -1,3 +1,3 @@',
      ' one',
      '', // was ' ' — editors trim trailing whitespace
      '-three',
      '+THREE',
      '',
    ].join('\n');
    const [section] = splitPatchFiles(patch);
    expect(section?.relPath).toBe('f.txt');
    expect(applyHunks('one\n\nthree\n', section!.hunks)).toBe('one\n\nTHREE\n');

    const quoted = 'diff --git "a/sp ace.txt" "b/sp ace.txt"\nBinary files a/sp ace.txt and b/sp ace.txt differ\n';
    const [q] = splitPatchFiles(quoted);
    expect(q?.relPath).toBe('sp ace.txt');
    expect(q?.isBinary).toBe(true);
  });
});
