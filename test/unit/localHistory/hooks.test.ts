import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildCapabilities } from '../../../src/core/git/capabilities';
import type { GitExecutor } from '../../../src/core/git/executor';
import { RepositoryModel } from '../../../src/core/model/repositoryModel';
import type { StatusEntry } from '../../../src/core/model/statusEntry';
import { OperationQueue } from '../../../src/core/ops/operationQueue';
import { LocalHistoryHooks, SNAPSHOT_LABELS } from '../../../src/localHistory/hooks';
import { SnapshotStore } from '../../../src/localHistory/snapshotStore';

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

interface Rig {
  repoRoot: string;
  model: RepositoryModel;
  queue: OperationQueue;
  store: SnapshotStore;
  hooks: LocalHistoryHooks;
  enabled: { value: boolean };
  failures: unknown[];
}

function rig(): Rig {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'geet-hooks-repo-'));
  const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'geet-hooks-store-'));
  cleanups.push(() => {
    try {
      fs.rmSync(repoRoot, { recursive: true, force: true, maxRetries: 3 });
      fs.rmSync(storeDir, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      /* tmp */
    }
  });
  const model = new RepositoryModel(repoRoot);
  const queue = new OperationQueue(repoRoot, stubGit, { lockRetryBaseMs: 5 });
  const store = new SnapshotStore({ storeDir: path.join(storeDir, 'h'), repoRoot });
  const enabled = { value: true };
  const failures: unknown[] = [];
  const hooks = new LocalHistoryHooks({
    repoRoot,
    model,
    queue,
    store,
    isEnabled: () => enabled.value,
    onStoreFailure: (e) => failures.push(e),
  });
  cleanups.push(() => {
    hooks.dispose();
    queue.dispose();
    model.dispose();
  });
  return { repoRoot, model, queue, store, hooks, enabled, failures };
}

function dirtyFile(r: Rig, rel: string, content: string): void {
  const p = path.join(r.repoRoot, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  const entry: StatusEntry = { kind: 'ordinary', path: rel, x: '.', y: 'M', submodule: 'N...' };
  const existing = r.model.snapshot.statusEntries.filter((e) => e.path !== rel);
  r.model.update({ statusEntries: [...existing, entry] });
}

describe('LocalHistoryHooks — destructive op coverage matrix', () => {
  it('every op in the master §10 matrix produces a manifest with its label and file set', async () => {
    const r = rig();
    dirtyFile(r, 'src/work.ts', 'uncommitted work\n');
    dirtyFile(r, 'notes.md', 'scratch notes\n');

    for (const [key, label] of Object.entries(SNAPSHOT_LABELS)) {
      await r.queue.enqueue({
        label: `op-${key}`,
        kind: 'mutate',
        isDestructive: true,
        snapshotLabel: label,
        run: () => Promise.resolve(),
      });
    }

    const manifests = r.store.list();
    const labels = manifests.map((m) => m.label);
    for (const label of Object.values(SNAPSHOT_LABELS)) {
      expect(labels).toContain(label);
    }
    for (const m of manifests) {
      expect(m.trigger).toBe('operation');
      expect(m.files.map((f) => f.relPath).sort()).toEqual(['notes.md', 'src/work.ts']);
    }
  }, 30_000);

  it('snapshots BEFORE the mutation runs (waitUntil ordering)', async () => {
    const r = rig();
    dirtyFile(r, 'a.txt', 'pre-op content\n');
    let manifestsAtRunTime = -1;
    await r.queue.enqueue({
      label: 'reset',
      kind: 'mutate',
      isDestructive: true,
      snapshotLabel: SNAPSHOT_LABELS.reset,
      run: () => {
        manifestsAtRunTime = r.store.list().length;
        // Simulate destruction: the op wipes the file.
        fs.writeFileSync(path.join(r.repoRoot, 'a.txt'), 'DESTROYED\n');
        return Promise.resolve();
      },
    });
    expect(manifestsAtRunTime).toBe(1);
    const m = r.store.list()[0]!;
    expect(r.store.read(m.id, 'a.txt')?.toString()).toBe('pre-op content\n'); // pre-op bytes
  });

  it('includes operation-declared extra paths', async () => {
    const r = rig();
    dirtyFile(r, 'dirty.txt', 'dirty\n');
    const extra = path.join(r.repoRoot, 'clean-but-target.txt');
    fs.writeFileSync(extra, 'rollback target\n');
    await r.queue.enqueue({
      label: 'rollback',
      kind: 'mutate',
      isDestructive: true,
      snapshotLabel: SNAPSHOT_LABELS.rollback,
      snapshotPaths: [extra],
      run: () => Promise.resolve(),
    });
    const m = r.store.list()[0]!;
    expect(m.files.map((f) => f.relPath).sort()).toEqual(['clean-but-target.txt', 'dirty.txt']);
  });

  it('records a deleted file of the dirty set as deleted, and a rename\'s old path too (POST-QA)', async () => {
    const r = rig();
    dirtyFile(r, 'kept.txt', 'edited\n');
    const deleted: StatusEntry = { kind: 'ordinary', path: 'docs/old.md', x: '.', y: 'D', submodule: 'N...' };
    const renamed = {
      kind: 'renamed',
      path: 'src/new.ts',
      origPath: 'src/old.ts',
      x: 'R',
      y: '.',
      submodule: 'N...',
    } as StatusEntry;
    fs.mkdirSync(path.join(r.repoRoot, 'src'), { recursive: true });
    fs.writeFileSync(path.join(r.repoRoot, 'src/new.ts'), 'moved\n');
    r.model.update({ statusEntries: [...r.model.snapshot.statusEntries, deleted, renamed] });
    await r.queue.enqueue({
      label: 'reset',
      kind: 'mutate',
      isDestructive: true,
      snapshotLabel: SNAPSHOT_LABELS.reset,
      run: () => Promise.resolve(),
    });
    const m = r.store.list()[0]!;
    const byPath = new Map(m.files.map((f) => [f.relPath, f]));
    expect([...byPath.keys()].sort()).toEqual(['docs/old.md', 'kept.txt', 'src/new.ts', 'src/old.ts']);
    expect(byPath.get('docs/old.md')?.deleted).toBe(true);
    expect(byPath.get('src/old.ts')?.deleted).toBe(true);
    expect(byPath.get('src/new.ts')?.deleted).toBeUndefined();
    expect(r.store.read(m.id, 'kept.txt')?.toString()).toBe('edited\n');
  });

  it('takes a paired After snapshot only for snapshotAfter ops that succeed', async () => {
    const r = rig();
    dirtyFile(r, 'w.txt', 'v1\n');
    await r.queue.enqueue({
      label: 'checkout',
      kind: 'mutate',
      isDestructive: true,
      snapshotLabel: SNAPSHOT_LABELS.checkoutDirty,
      snapshotAfter: true,
      run: () => {
        fs.writeFileSync(path.join(r.repoRoot, 'w.txt'), 'v2-after-checkout\n');
        return Promise.resolve();
      },
    });
    await new Promise((res) => setTimeout(res, 150)); // post-op snapshot is async
    const labels = r.store.list().map((m) => m.label);
    expect(labels).toContain(SNAPSHOT_LABELS.checkoutDirty);
    expect(labels).toContain('After: checkout (dirty worktree)');

    // Failure case: no After snapshot.
    await r.queue
      .enqueue({
        label: 'failing-merge',
        kind: 'mutate',
        isDestructive: true,
        snapshotLabel: SNAPSHOT_LABELS.merge,
        snapshotAfter: true,
        run: () => Promise.reject(new Error('conflict')),
      })
      .catch(() => undefined);
    await new Promise((res) => setTimeout(res, 150));
    expect(r.store.list().map((m) => m.label)).not.toContain('After: merge');
  });

  it('skips snapshots when nothing is dirty', async () => {
    const r = rig();
    await r.queue.enqueue({
      label: 'reset-clean',
      kind: 'mutate',
      isDestructive: true,
      snapshotLabel: SNAPSHOT_LABELS.reset,
      run: () => Promise.resolve(),
    });
    expect(r.store.list()).toHaveLength(0);
  });

  it('kill switch produces zero writes', async () => {
    const r = rig();
    r.enabled.value = false;
    dirtyFile(r, 'x.txt', 'x\n');
    await r.queue.enqueue({
      label: 'reset',
      kind: 'mutate',
      isDestructive: true,
      snapshotLabel: SNAPSHOT_LABELS.reset,
      run: () => Promise.resolve(),
    });
    expect(r.store.list()).toHaveLength(0);
  });

  it('store failure warns once and never blocks the operation', async () => {
    const r = rig();
    dirtyFile(r, 'x.txt', 'x\n');
    r.store.snapshot = () => Promise.reject(new Error('disk full'));
    const first = await r.queue.enqueue({
      label: 'reset',
      kind: 'mutate',
      isDestructive: true,
      snapshotLabel: SNAPSHOT_LABELS.reset,
      run: () => Promise.resolve('op-ran'),
    });
    const second = await r.queue.enqueue({
      label: 'reset2',
      kind: 'mutate',
      isDestructive: true,
      snapshotLabel: SNAPSHOT_LABELS.reset,
      run: () => Promise.resolve('op-ran-2'),
    });
    expect(first).toBe('op-ran');
    expect(second).toBe('op-ran-2');
    expect(r.failures).toHaveLength(1); // warned once, not twice
  });
});

describe('LocalHistoryHooks — task and save triggers', () => {
  it('records test/build task-end labels with the dirty set', async () => {
    const r = rig();
    dirtyFile(r, 'src/x.ts', 'wip\n');
    await r.hooks.onTaskEnded('npm: test', true);
    const m = r.store.list()[0];
    expect(m?.label).toBe('After task: npm: test');
    expect(m?.trigger).toBe('task');
    await r.hooks.onTaskEnded('some-random-task', false);
    expect(r.store.list()).toHaveLength(1); // non-test/build ignored
  });

  it('records save snapshots with the save trigger', async () => {
    const r = rig();
    const p = path.join(r.repoRoot, 'saved.ts');
    fs.writeFileSync(p, 'saved content\n');
    await r.hooks.onFileSaved(p);
    const m = r.store.list()[0];
    expect(m?.trigger).toBe('save');
    expect(m?.files[0]?.relPath).toBe('saved.ts');
  });

  it('honors the kill switch for task/save triggers too', async () => {
    const r = rig();
    r.enabled.value = false;
    const p = path.join(r.repoRoot, 'saved.ts');
    fs.writeFileSync(p, 'x\n');
    await r.hooks.onTaskEnded('npm: test', true);
    await r.hooks.onFileSaved(p);
    expect(r.store.list()).toHaveLength(0);
  });
});
