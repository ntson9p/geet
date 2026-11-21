/**
 * P7-T3 unit slice: the pure storage layer (list/get/verify/readPatch/rename/
 * delete + corruption detection) and the diff-output → meta file-table
 * builder. The capture engine itself needs real git — covered by the
 * phase07 integration suite.
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildCapabilities } from '../../../src/core/git/capabilities';
import type { GitExecutor } from '../../../src/core/git/executor';
import { OperationQueue } from '../../../src/core/ops/operationQueue';
import {
  buildShelfFiles,
  ShelfIntegrityError,
  ShelfStore,
  type ShelfMeta,
} from '../../../src/shelf/shelfStore';

const stubGit: GitExecutor = {
  version: '2.43.0',
  caps: buildCapabilities('2.43.0'),
  gitPath: 'git',
  exec: () => Promise.resolve({ stdout: '', stderr: '', exitCode: 0 }),
  stream: () => ({ cancel: () => undefined, done: Promise.resolve({ stdout: '', stderr: '', exitCode: 0 }) }),
};

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

function rig(): { store: ShelfStore; storeDir: string } {
  const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'geet-shelf-'));
  cleanups.push(() => {
    try {
      fs.rmSync(storeDir, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      /* tmp */
    }
  });
  const queue = new OperationQueue('/repo', stubGit, { lockRetryBaseMs: 5 });
  const store = new ShelfStore({ storeDir, repoRoot: '/repo', queue });
  return { store, storeDir };
}

/** Hand-craft a committed entry the way shelve() lays it out on disk. */
function plantEntry(
  storeDir: string,
  id: string,
  patch: Buffer,
  metaOverrides: Partial<ShelfMeta> = {},
): ShelfMeta {
  const dir = path.join(storeDir, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'changes.patch'), patch);
  const meta: ShelfMeta = {
    id,
    name: `entry ${id}`,
    comment: '',
    createdAt: Date.now(),
    baseSha: 'a'.repeat(40),
    branch: 'main',
    files: [{ relPath: 'a.txt', status: 'modified', isBinary: false }],
    untrackedSnapshots: 'embedded',
    patchSha256: crypto.createHash('sha256').update(patch).digest('hex'),
    ...metaOverrides,
  };
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta));
  return meta;
}

describe('P7-T3 ShelfStore storage layer', () => {
  it('lists committed entries newest-first and skips broken/uncommitted dirs', () => {
    const { store, storeDir } = rig();
    expect(store.list()).toEqual([]); // store dir may not even exist yet
    plantEntry(storeDir, 'old', Buffer.from('patch-old\n'), { createdAt: 1000 });
    plantEntry(storeDir, 'new', Buffer.from('patch-new\n'), { createdAt: 2000 });
    // Uncommitted dir (no meta.json) and garbage meta must both be ignored.
    fs.mkdirSync(path.join(storeDir, 'half-written'));
    fs.mkdirSync(path.join(storeDir, 'broken'));
    fs.writeFileSync(path.join(storeDir, 'broken', 'meta.json'), '{not json');
    const listed = store.list();
    expect(listed.map((m) => m.id)).toEqual(['new', 'old']);
    expect(store.get('old')?.name).toBe('entry old');
    expect(store.get('half-written')).toBeUndefined();
  });

  it('verify()/readPatch() pass for intact bytes and detect corruption', () => {
    const { store, storeDir } = rig();
    const patch = Buffer.from('diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n');
    plantEntry(storeDir, 'ok', patch);
    expect(store.verify('ok')).toBe(true);
    expect([...store.readPatch('ok')]).toEqual([...patch]);

    // Flip one byte: the entry still lists, but integrity gates its use.
    const patchFile = store.patchPath('ok');
    const corrupted = fs.readFileSync(patchFile);
    corrupted[10] = corrupted[10]! ^ 0xff;
    fs.writeFileSync(patchFile, corrupted);
    expect(store.list().map((m) => m.id)).toContain('ok');
    expect(store.verify('ok')).toBe(false);
    expect(() => store.readPatch('ok')).toThrow(ShelfIntegrityError);

    // Missing patch file is an integrity failure too, not a crash.
    fs.rmSync(patchFile);
    expect(store.verify('ok')).toBe(false);
    expect(() => store.readPatch('ok')).toThrow(ShelfIntegrityError);
  });

  it('rename() rewrites meta only; delete() removes the entry and its bytes', () => {
    const { store, storeDir } = rig();
    const patch = Buffer.from('some patch\n');
    plantEntry(storeDir, 'e1', patch);
    let changes = 0;
    store.onDidChange(() => changes++);

    store.rename('e1', 'renamed', 'now with a comment');
    expect(store.get('e1')?.name).toBe('renamed');
    expect(store.get('e1')?.comment).toBe('now with a comment');
    expect(store.verify('e1')).toBe(true); // hash untouched by a meta rewrite
    expect(() => store.rename('missing', 'x')).toThrow(/not found/);

    store.delete('e1');
    expect(store.list()).toEqual([]);
    expect(fs.existsSync(store.entryDir('e1'))).toBe(false);
    expect(changes).toBe(2);
  });
});

describe('P7-T3 buildShelfFiles', () => {
  it('maps name-status codes, unmasks add -N untracked, flags binaries', () => {
    const nameStatus = ['M\0src/mod.ts', 'A\0staged-new.txt', 'A\0was-untracked.txt', 'D\0gone.txt', 'M\0img.png']
      .join('\0')
      .concat('\0');
    const numstat = ['3\t1\tsrc/mod.ts', '5\t0\tstaged-new.txt', '2\t0\twas-untracked.txt', '0\t4\tgone.txt', '-\t-\timg.png']
      .join('\0')
      .concat('\0');
    const files = buildShelfFiles(nameStatus, numstat, new Set(['was-untracked.txt']));
    expect(files).toEqual([
      { relPath: 'src/mod.ts', status: 'modified', isBinary: false },
      { relPath: 'staged-new.txt', status: 'added', isBinary: false },
      { relPath: 'was-untracked.txt', status: 'untracked', isBinary: false },
      { relPath: 'gone.txt', status: 'deleted', isBinary: false },
      { relPath: 'img.png', status: 'modified', isBinary: true },
    ]);
  });

  it('handles empty diffs and paths with spaces', () => {
    expect(buildShelfFiles('', '', new Set())).toEqual([]);
    const files = buildShelfFiles('A\0dir with space/né w.txt\0', '-\t-\tdir with space/né w.txt\0', new Set(['dir with space/né w.txt']));
    expect(files).toEqual([{ relPath: 'dir with space/né w.txt', status: 'untracked', isBinary: true }]);
  });
});
