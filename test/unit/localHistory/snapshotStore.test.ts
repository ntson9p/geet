import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { repoStoreKey, SnapshotStore } from '../../../src/localHistory/snapshotStore';

const cleanups: string[] = [];
afterEach(() => {
  while (cleanups.length) {
    try {
      fs.rmSync(cleanups.pop() as string, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      /* tmp */
    }
  }
});

function scratch(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanups.push(dir);
  return dir;
}

interface StoreOverrides {
  maxFileSizeKb?: number;
  maxSizeMb?: number;
  retentionDays?: number;
  now?: () => number;
}

function makeStore(overrides: StoreOverrides = {}): { store: SnapshotStore; repoRoot: string; storeDir: string } {
  const repoRoot = scratch('gittree-lh-repo-');
  const storeDir = path.join(scratch('gittree-lh-store-'), 'history', 'repo-x');
  const store = new SnapshotStore({ storeDir, repoRoot, ...overrides });
  return { store, repoRoot, storeDir };
}

function write(repoRoot: string, rel: string, content: string | Buffer): string {
  const p = path.join(repoRoot, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  return p;
}

function blobCount(storeDir: string): number {
  const blobs = path.join(storeDir, 'blobs');
  if (!fs.existsSync(blobs)) return 0;
  let n = 0;
  for (const shard of fs.readdirSync(blobs)) {
    n += fs.readdirSync(path.join(blobs, shard)).length;
  }
  return n;
}

describe('SnapshotStore basics', () => {
  it('records files and reads back byte-identical content (incl. binary)', async () => {
    const { store, repoRoot } = makeStore();
    const text = write(repoRoot, 'src/app.ts', 'const a = 1;\n');
    const binary = write(repoRoot, 'img/logo.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 255]));
    const id = await store.snapshot('Before: reset', 'operation', [text, binary]);
    expect(id).toBeDefined();
    expect(store.read(id!, 'src/app.ts')?.toString('utf8')).toBe('const a = 1;\n');
    expect([...store.read(id!, 'img/logo.png')!]).toEqual([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 255]);
    const manifest = store.get(id!);
    expect(manifest?.label).toBe('Before: reset');
    expect(manifest?.trigger).toBe('operation');
    expect(manifest?.files).toHaveLength(2);
  });

  it('dedupes identical content across snapshots (one blob)', async () => {
    const { store, repoRoot, storeDir } = makeStore();
    const f = write(repoRoot, 'same.txt', 'identical content\n');
    await store.snapshot('one', 'manual', [f]);
    await store.snapshot('two', 'manual', [f]);
    expect(store.list()).toHaveLength(2);
    expect(blobCount(storeDir)).toBe(1);
  });

  it('skips missing files and paths outside the repo', async () => {
    const { store, repoRoot } = makeStore();
    const real = write(repoRoot, 'real.txt', 'x\n');
    const outside = path.join(os.tmpdir(), 'gittree-outside.txt');
    fs.writeFileSync(outside, 'outside\n');
    cleanups.push(outside);
    const id = await store.snapshot('mixed', 'manual', [
      real,
      path.join(repoRoot, 'never-existed.txt'),
      outside,
    ]);
    const manifest = store.get(id!);
    expect(manifest?.files.map((f) => f.relPath)).toEqual(['real.txt']);
  });

  it('returns undefined when nothing is recordable', async () => {
    const { store, repoRoot } = makeStore();
    const id = await store.snapshot('empty', 'manual', [path.join(repoRoot, 'nope.txt')]);
    expect(id).toBeUndefined();
    expect(store.list()).toHaveLength(0);
  });

  it('records a missing path as a deletion when asked — the dirty set, where missing means deleted', async () => {
    const { store, repoRoot, storeDir } = makeStore();
    const kept = write(repoRoot, 'kept.txt', 'kept\n');
    const id = await store.snapshot('Before: reset', 'operation', [kept, path.join(repoRoot, 'src/gone.ts')], {
      recordMissing: true,
    });
    const gone = store.get(id!)?.files.find((f) => f.relPath === 'src/gone.ts');
    expect(gone).toEqual({ relPath: 'src/gone.ts', blobSha: '', mode: 0, size: 0, deleted: true });
    expect(store.read(id!, 'src/gone.ts')).toBeUndefined();
    expect(store.read(id!, 'kept.txt')?.toString()).toBe('kept\n');
    // A deletion owns no blob: deleting the snapshot sweeps only kept.txt's.
    expect(blobCount(storeDir)).toBe(1);
    await store.delete(id!);
    expect(blobCount(storeDir)).toBe(0);
  });

  it('keeps a snapshot whose only change is a deletion', async () => {
    const { store, repoRoot } = makeStore();
    const id = await store.snapshot('Before: reset', 'operation', [path.join(repoRoot, 'only-deleted.md')], {
      recordMissing: true,
    });
    expect(id).toBeDefined();
    expect(store.get(id!)?.files.map((f) => [f.relPath, f.deleted])).toEqual([['only-deleted.md', true]]);
    expect(store.list({ pathPrefix: 'only-deleted.md' })).toHaveLength(1);
  });

  it('records oversized files as metadata-only stubs', async () => {
    const { store, repoRoot } = makeStore({ maxFileSizeKb: 1 });
    const big = write(repoRoot, 'big.bin', Buffer.alloc(4096, 7));
    const small = write(repoRoot, 'small.txt', 'ok\n');
    const id = await store.snapshot('with stub', 'operation', [big, small]);
    const manifest = store.get(id!);
    const stub = manifest?.files.find((f) => f.relPath === 'big.bin');
    expect(stub?.tooLarge).toBe(true);
    expect(stub?.blobSha).toBe('');
    expect(stub?.size).toBe(4096);
    expect(store.read(id!, 'big.bin')).toBeUndefined();
    expect(store.read(id!, 'small.txt')?.toString()).toBe('ok\n');
  });

  it('handles unicode and deep paths (Windows long-path safe)', async () => {
    const { store, repoRoot } = makeStore();
    const deepSegments = Array.from({ length: 30 }, (_, i) => `deep-directory-segment-${i}`);
    const deepRel = [...deepSegments, 'ファイル-é-🎉.txt'].join('/');
    const abs = write(repoRoot, deepRel, 'deep unicode content\n');
    expect(abs.length).toBeGreaterThan(260); // actually exercises long paths
    const id = await store.snapshot('deep', 'manual', [abs]);
    expect(id).toBeDefined();
    expect(store.read(id!, deepRel)?.toString()).toBe('deep unicode content\n');
  });

  it('filters list() by path prefix and trigger', async () => {
    const { store, repoRoot } = makeStore();
    const a = write(repoRoot, 'src/a.ts', 'a\n');
    const b = write(repoRoot, 'docs/b.md', 'b\n');
    await store.snapshot('ops', 'operation', [a]);
    await store.snapshot('task', 'task', [b]);
    expect(store.list({ pathPrefix: 'src' })).toHaveLength(1);
    expect(store.list({ pathPrefix: 'src/a.ts' })).toHaveLength(1);
    expect(store.list({ trigger: 'task' })).toHaveLength(1);
    expect(store.list({ pathPrefix: 'nope' })).toHaveLength(0);
    expect(store.list()).toHaveLength(2);
  });

  it('tolerates corrupt manifests (skipped, others survive)', async () => {
    const { store, repoRoot, storeDir } = makeStore();
    const f = write(repoRoot, 'x.txt', 'x\n');
    await store.snapshot('good', 'manual', [f]);
    fs.writeFileSync(path.join(storeDir, 'manifests', 'ZZZZZZZZZZ0000000000000000.json'), '{not json');
    const list = store.list();
    expect(list).toHaveLength(1);
    expect(list[0]?.label).toBe('good');
  });

  it('delete removes the manifest and sweeps orphaned blobs', async () => {
    const { store, repoRoot, storeDir } = makeStore();
    const f = write(repoRoot, 'only.txt', 'unique content zzz\n');
    const id = await store.snapshot('to delete', 'manual', [f]);
    expect(blobCount(storeDir)).toBe(1);
    await store.delete(id!);
    expect(store.list()).toHaveLength(0);
    expect(blobCount(storeDir)).toBe(0);
  });
});

describe('SnapshotStore GC', () => {
  it('drops manifests beyond retentionDays but never the most recent', async () => {
    let clock = 1_000_000_000_000;
    const { store, repoRoot, storeDir } = makeStore({ retentionDays: 1, now: () => clock });
    const f = write(repoRoot, 'f.txt', 'v1\n');
    await store.snapshot('ancient-1', 'manual', [f]);
    write(repoRoot, 'f.txt', 'v2\n');
    await store.snapshot('ancient-2', 'manual', [f]);
    clock += 3 * 24 * 60 * 60 * 1000; // 3 days later
    const result = await store.gc();
    expect(result.droppedManifests).toBe(1);
    const survivors = store.list();
    expect(survivors).toHaveLength(1);
    expect(survivors[0]?.label).toBe('ancient-2'); // most recent kept though old
    expect(blobCount(storeDir)).toBe(1); // v1 blob swept
  });

  it('enforces the size budget oldest-first', async () => {
    const { store, repoRoot } = makeStore({ maxSizeMb: 1 });
    // ~600KB of incompressible data per snapshot → two snapshots exceed 1MB.
    for (let i = 0; i < 3; i++) {
      const buf = Buffer.alloc(600 * 1024);
      for (let j = 0; j < buf.length; j += 4) buf.writeUInt32LE(Math.floor(Math.random() * 0xffffffff), j);
      const f = write(repoRoot, 'blob.bin', buf);
      await store.snapshot(`snap-${i}`, 'manual', [f]);
    }
    await store.gc();
    const survivors = store.list();
    expect(survivors.length).toBeLessThan(3);
    expect(survivors.some((m) => m.label === 'snap-2')).toBe(true); // newest survives
    expect(store.storageBytes()).toBeLessThanOrEqual(1024 * 1024 + 64 * 1024);
  });

  it('gc is a no-op when under budget', async () => {
    const { store, repoRoot } = makeStore();
    const f = write(repoRoot, 'small.txt', 'tiny\n');
    await store.snapshot('only', 'manual', [f]);
    const result = await store.gc();
    expect(result.droppedManifests).toBe(0);
    expect(result.sweptBlobs).toBe(0);
    expect(store.list()).toHaveLength(1);
  });
});

describe('repoStoreKey', () => {
  it('produces filesystem-safe stable keys', () => {
    const k1 = repoStoreKey('d:/users/son/code/my repo!');
    expect(k1).toMatch(/^my_repo_-[0-9a-f]{12}$/);
    expect(repoStoreKey('d:/users/son/code/my repo!')).toBe(k1); // stable
    expect(repoStoreKey('d:/other/my repo!')).not.toBe(k1); // path-sensitive
  });
});
