import * as assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { RepoHandle } from '../../../src/core/core';
import { makeSnapUri } from '../../../src/core/vdocs/snapFs';
import type { DestructionEvent, RecoveryWatch } from '../../../src/localHistory/recoveryWatch';
import type { HistoryNode, LocalHistoryViewProvider, RestoreUx } from '../../../src/localHistory/restoreUx';
import type { SnapshotManifest, SnapshotStore } from '../../../src/localHistory/snapshotStore';
import { activateGitTree, waitFor, workspaceRepoB } from '../setup';

interface Phase09RegistryShape {
  getStore(repoRoot: string): SnapshotStore | undefined;
  viewProvider: LocalHistoryViewProvider;
  restoreUx: RestoreUx;
  recovery: RecoveryWatch;
}

/**
 * P9-T3/T4 acceptance on workspace repoB (shared with the P2 suite, which
 * runs earlier and leaves it on `main`). Local History is git-independent, so
 * the T3 tests never touch git; T4 drives real external git destruction.
 */
suite('P9 local history — restore UX & destruction detection', () => {
  let repoRoot: string;
  let repo: RepoHandle;
  let reg: Phase09RegistryShape;
  let store: SnapshotStore;

  const git = (...args: string[]): string =>
    execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' });
  const abs = (rel: string): string => path.join(repoRoot, rel);
  const write = (rel: string, content: string | Buffer): void => {
    fs.mkdirSync(path.dirname(abs(rel)), { recursive: true });
    fs.writeFileSync(abs(rel), content);
  };

  // Seed contents exercise CRLF + unicode so byte-identical restore is real.
  // keep.txt is uniformly CRLF (TextDocument preserves a consistent EOL);
  // gone.txt mixes EOLs — only raw fs bytes can prove its restore.
  const KEEP_V1 = Buffer.from('one\r\ntwo\r\nthree\r\n', 'utf8');
  const KEEP_V2 = Buffer.from('one\r\nTWO changed\r\nthree\r\n', 'utf8');
  const GONE_V1 = Buffer.from('alpha\nbeta\r\nΓ unicode †\n', 'utf8');
  const SUB_V1 = Buffer.from('sub original\n', 'utf8');
  let seedId: string;
  let seedManifest: SnapshotManifest;

  function snapshotNode(manifest: SnapshotManifest): HistoryNode {
    return { kind: 'snapshot', repo, manifest };
  }

  suiteSetup(async function () {
    this.timeout(60_000);
    const core = await activateGitTree();
    repo = core.repoForPath(workspaceRepoB())!;
    assert.ok(repo, 'repoB not discovered');
    // Windows: the env var may be an 8.3 short path; the store computes
    // repo-relative paths against the canonical root, so build from repo.root.
    repoRoot = repo.root;
    reg = core.debugRegistry.get('phase09') as Phase09RegistryShape;
    assert.ok(reg?.restoreUx && reg.recovery, 'phase09 registry missing T3/T4 entries');
    const s = reg.getStore(repoRoot);
    assert.ok(s, 'snapshot store missing for repoB');
    store = s;
  });

  test('T3: seed → snapshot → edits diverge → snap provider serves both directions', async function () {
    this.timeout(30_000);
    write('lh/keep.txt', KEEP_V1);
    write('lh/gone.txt', GONE_V1);
    write('lhsub/inner.txt', SUB_V1);

    const id = await store.snapshot('LH seed', 'manual', [
      abs('lh/keep.txt'),
      abs('lh/gone.txt'),
      abs('lhsub/inner.txt'),
    ]);
    assert.ok(id, 'seed snapshot failed');
    seedId = id;
    const manifest = store.get(seedId);
    assert.ok(manifest, 'seed manifest unreadable');
    seedManifest = manifest;
    assert.strictEqual(manifest.files.length, 3);

    // Further edits: one file modified, one deleted.
    write('lh/keep.txt', KEEP_V2);
    fs.rmSync(abs('lh/gone.txt'));

    // Direction 1 — modified since snapshot: snap content is the old bytes.
    const keepSnap = await vscode.workspace.openTextDocument(
      makeSnapUri(repoRoot, seedId, 'lh/keep.txt'),
    );
    assert.strictEqual(keepSnap.getText(), KEEP_V1.toString('utf8'));
    assert.notStrictEqual(fs.readFileSync(abs('lh/keep.txt'), 'utf8'), keepSnap.getText());

    // Direction 2 — deleted since snapshot: snap has content, worktree does
    // not. TextDocument normalizes mixed-EOL content to one EOL, so compare
    // EOL-insensitively here; byte fidelity is proven on restore below.
    const goneSnap = await vscode.workspace.openTextDocument(
      makeSnapUri(repoRoot, seedId, 'lh/gone.txt'),
    );
    assert.strictEqual(
      goneSnap.getText().replace(/\r\n/g, '\n'),
      GONE_V1.toString('utf8').replace(/\r\n/g, '\n'),
    );
    assert.ok(!fs.existsSync(abs('lh/gone.txt')), 'gone.txt should be deleted');

    // Compare with Current opens the multi-diff without throwing, including
    // the missing-now file (diffs against empty).
    await reg.restoreUx.compareSnapshot(snapshotNode(seedManifest));
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });

  test('T3: subset restore is byte-identical for a deleted file and undoable via paranoia snapshot', async function () {
    this.timeout(30_000);
    // Also diverge the file NOT in the subset — restore must not touch it.
    write('lhsub/inner.txt', 'sub changed\n');

    process.env['GITTREE_TEST_AUTOCONFIRM'] = '1';
    process.env['GITTREE_TEST_RESTORE_PATHS'] = 'lh/keep.txt;lh/gone.txt';
    try {
      await reg.restoreUx.restore(snapshotNode(seedManifest), true);
    } finally {
      delete process.env['GITTREE_TEST_RESTORE_PATHS'];
      delete process.env['GITTREE_TEST_AUTOCONFIRM'];
    }

    // Deleted file recreated byte-identically; modified file rolled back;
    // out-of-subset file untouched.
    assert.ok(Buffer.from(fs.readFileSync(abs('lh/gone.txt'))).equals(GONE_V1), 'gone.txt bytes differ');
    assert.ok(Buffer.from(fs.readFileSync(abs('lh/keep.txt'))).equals(KEEP_V1), 'keep.txt bytes differ');
    assert.strictEqual(fs.readFileSync(abs('lhsub/inner.txt'), 'utf8'), 'sub changed\n');

    // Paranoia snapshot recorded the pre-restore (modified) contents.
    const paranoia = store.list().find((m) => m.label === 'Before restore of "LH seed"');
    assert.ok(paranoia, 'paranoia snapshot missing');
    const paranoiaKeep = store.read(paranoia.id, 'lh/keep.txt');
    assert.ok(paranoiaKeep && Buffer.from(paranoiaKeep).equals(KEEP_V2), 'paranoia content wrong');

    // "Undo restore" (the toast action) re-restores the paranoia manifest.
    process.env['GITTREE_TEST_AUTOCONFIRM'] = '1';
    try {
      await reg.restoreUx.restore(snapshotNode(paranoia), false);
    } finally {
      delete process.env['GITTREE_TEST_AUTOCONFIRM'];
    }
    assert.ok(Buffer.from(fs.readFileSync(abs('lh/keep.txt'))).equals(KEEP_V2), 'undo did not revert');
  });

  test('T3: folder-scoped entry filters the view to manifests touching that path', async function () {
    this.timeout(30_000);
    // A snapshot that does NOT touch lhsub/ must be filtered out. The
    // paranoia manifest from the previous test (lh/ only) serves as one more.
    const outsideId = await store.snapshot('LH outside', 'manual', [abs('lh/keep.txt')]);
    assert.ok(outsideId);

    await vscode.commands.executeCommand(
      'gittree.history.showForPath',
      vscode.Uri.file(abs('lhsub')),
    );
    const filter = reg.viewProvider.currentFilter;
    assert.ok(filter, 'path filter not set');
    assert.strictEqual(filter.prefix.replace(/\\/g, '/'), 'lhsub');

    // Walk the tree: repo node for repoB → day groups → snapshot rows.
    const roots = reg.viewProvider.getChildren();
    const repoNode = roots.find((n) => n.kind === 'repo' && n.repo.root === repo.root);
    assert.ok(repoNode, `repo node missing (roots: ${roots.map((n) => n.kind).join(',')})`);
    const dayNodes = reg.viewProvider.getChildren(repoNode).filter((n) => n.kind === 'day');
    const labels: string[] = [];
    for (const day of dayNodes) {
      for (const snap of reg.viewProvider.getChildren(day)) {
        if (snap.kind === 'snapshot') {
          labels.push(snap.manifest.label);
          assert.ok(
            snap.manifest.files.some((f) => f.relPath.replace(/\\/g, '/').startsWith('lhsub')),
            `manifest "${snap.manifest.label}" does not touch lhsub/`,
          );
        }
      }
    }
    assert.ok(labels.includes('LH seed'), `seed missing from filtered view: ${labels.join(' | ')}`);
    assert.ok(!labels.includes('LH outside'), 'outside manifest not filtered');
    assert.ok(!labels.includes('Before restore of "LH seed"'), 'paranoia (lh/ only) not filtered');

    await vscode.commands.executeCommand('gittree.history.clearFilter');
    assert.strictEqual(reg.viewProvider.currentFilter, undefined);
  });

  test('T3: delete snapshot and clear-all purge controls honor the typed-confirm seam', async function () {
    this.timeout(30_000);
    const tempId = await store.snapshot('LH temp', 'manual', [abs('lh/keep.txt')]);
    assert.ok(tempId);
    const tempManifest = store.get(tempId);
    assert.ok(tempManifest);
    process.env['GITTREE_TEST_AUTOCONFIRM'] = '1';
    try {
      await reg.restoreUx.deleteSnapshot(snapshotNode(tempManifest));
      assert.strictEqual(store.get(tempId), undefined, 'snapshot not deleted');

      await reg.restoreUx.gcNow(repo);

      await reg.restoreUx.clearAll(repo);
      assert.strictEqual(store.list().length, 0, 'clearAll left manifests behind');
    } finally {
      delete process.env['GITTREE_TEST_AUTOCONFIRM'];
    }
  });

  test('T4: external reset --hard with dirty worktree fires detection; recover-branch resurrects the sha', async function () {
    this.timeout(60_000);
    // Two of our own commits so HEAD~1 exists and only test data is at risk.
    write('lh4/x.txt', 'v1\n');
    git('add', 'lh4/x.txt');
    git('commit', '-m', 'p9t4 c1');
    write('lh4/x.txt', 'v2\n');
    git('add', 'lh4/x.txt');
    git('commit', '-m', 'p9t4 c2');
    const lostSha = git('rev-parse', 'HEAD').trim();

    // Dirty worktree at reset time (the danger signal), visible to the model.
    write('lh4/dirty.txt', 'uncommitted work\n');
    await repo.refresher.refreshNow();
    await waitFor(
      () => repo.model.snapshot.statusEntries.some((e) => e.path.includes('dirty.txt')),
      10_000,
    );

    const detected = new Promise<DestructionEvent>((resolve) => {
      const sub = reg.recovery.onDidDetectDestruction((e) => {
        if (e.repo.root === repo.root && e.kind === 'reset') {
          sub.dispose();
          resolve(e);
        }
      });
    });

    // External destruction — bypasses the OperationQueue entirely.
    git('reset', '--hard', 'HEAD~1');

    const event = await Promise.race([
      detected,
      new Promise<never>((_, rej) =>
        setTimeout(() => rej(new Error('destruction not detected within 20s')), 20_000),
      ),
    ]);
    assert.strictEqual(event.kind, 'reset');
    assert.strictEqual(event.oldSha, lostSha, 'event oldSha should be the lost commit');
    assert.strictEqual(event.hadDirtyFiles, true, 'dirty worktree not recorded');

    // Recover commit — the toast's second action, driven directly.
    const branch = await reg.recovery.recoverCommit(repo, lostSha);
    assert.ok(branch, 'recoverCommit returned no branch');
    assert.strictEqual(branch, `recovered/${lostSha.slice(0, 7)}`);
    assert.strictEqual(git('rev-parse', branch).trim(), lostSha, 'recovered branch wrong sha');

    // Tidy: drop the recovery branch and the untracked dirty file; the reset
    // already left lh4/x.txt tracked and clean at c1.
    git('branch', '-D', branch);
    fs.rmSync(abs('lh4/dirty.txt'), { force: true });
    await repo.refresher.refreshNow();
  });

  test('T4: own destructive ops hint at most once per session per op type', async function () {
    this.timeout(30_000);
    const base = reg.recovery.hintCount;
    const destructive = (label: string, snapshotLabel: string) =>
      repo.queue.enqueue({
        label,
        kind: 'mutate' as const,
        isDestructive: true,
        snapshotLabel,
        run: () => Promise.resolve(undefined),
      });

    await destructive('p9t4 hint 1', 'Before: p9t4-op-a');
    assert.strictEqual(reg.recovery.hintCount, base + 1, 'first op of a type must hint');
    await destructive('p9t4 hint 2', 'Before: p9t4-op-a');
    assert.strictEqual(reg.recovery.hintCount, base + 1, 'same op type must not hint again');
    await destructive('p9t4 hint 3', 'Before: p9t4-op-b');
    assert.strictEqual(reg.recovery.hintCount, base + 2, 'new op type hints once');
  });
});
