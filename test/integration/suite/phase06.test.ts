import * as assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { RepoHandle } from '../../../src/core/core';
import type { ConflictSession } from '../../../src/merge/conflictSession';
import type { ConflictsViewProvider } from '../../../src/merge/conflictsView';
import { activateGitTree, waitFor, workspaceRepoC } from '../setup';

interface Phase06RegistryShape {
  getSession(repoRoot: string): ConflictSession | undefined;
  viewProvider: ConflictsViewProvider;
}

/** P6-T1 acceptance on workspace repoC (the P3 suite ran there long before). */
suite('P6 merge engine — conflict sessions & view', () => {
  let repoRoot: string;
  let repo: RepoHandle;
  let reg: Phase06RegistryShape;

  const git = (...args: string[]): string => {
    let lastErr: unknown;
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' });
      } catch (err) {
        lastErr = err;
        const text = String(err);
        if (!/Permission denied|Another git process|unable to write/i.test(text)) throw err;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 400 * (attempt + 1));
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  };
  const abs = (rel: string): string => path.join(repoRoot, rel);
  const write = (rel: string, content: string): void => fs.writeFileSync(abs(rel), content);
  const commitAll = (subject: string): string => {
    git('add', '-A');
    git('commit', '-m', subject);
    return git('rev-parse', 'HEAD').trim();
  };

  suiteSetup(async function () {
    this.timeout(60_000);
    const core = await activateGitTree();
    repo = core.repoForPath(workspaceRepoC())!;
    assert.ok(repo, 'repoC not discovered');
    repoRoot = repo.root;
    reg = core.debugRegistry.get('phase06') as Phase06RegistryShape;
    assert.ok(reg, 'phase06 registry missing');
    git('checkout', '-f', 'main');
  });

  teardown(async function () {
    this.timeout(30_000);
    try {
      git('merge', '--abort');
    } catch {
      // no merge in progress
    }
    try {
      git('checkout', '-f', 'main');
    } catch {
      // already there
    }
    const branches = git('branch', '--list', 'p6/*', '--format=%(refname:short)')
      .split('\n')
      .map((b) => b.trim())
      .filter((b) => b.length > 0);
    for (const b of branches) {
      try {
        git('branch', '-D', b);
      } catch {
        // best effort
      }
    }
    await repo.refresher.refreshNow();
    await new Promise((r) => setTimeout(r, 300));
  });

  /** base → side (their changes) → back on branch (our changes) → merge. */
  function buildConflict(name: string): void {
    git('checkout', '-f', 'main');
    git('checkout', '-b', `p6/${name}`);
    write('p6c.txt', 'base\n');
    write('p6d.txt', 'keep me\n');
    commitAll('p6 base');
    git('checkout', '-b', `p6/${name}-side`);
    write('p6c.txt', 'theirs\n');
    git('rm', '--', 'p6d.txt');
    write('p6new.txt', 'their new\n');
    commitAll('p6 theirs');
    git('checkout', `p6/${name}`);
    write('p6c.txt', 'ours\n');
    write('p6d.txt', 'modified by us\n');
    write('p6new.txt', 'our new\n');
    commitAll('p6 ours');
    try {
      git('merge', `p6/${name}-side`);
      assert.fail('merge should conflict');
    } catch {
      // expected — conflicts
    }
  }

  test('T1: conflict populates the session with correct classifications', async function () {
    this.timeout(90_000);
    buildConflict('classify');
    await repo.refresher.refreshNow();
    await waitFor(() => reg.getSession(repoRoot) !== undefined, 15_000);
    const session = reg.getSession(repoRoot)!;
    assert.strictEqual(session.source, 'merge');
    await waitFor(() => session.files().length === 3, 10_000);

    const byPath = new Map(session.files().map((f) => [f.path, f.kind]));
    assert.strictEqual(byPath.get('p6c.txt'), 'both-modified');
    assert.strictEqual(byPath.get('p6d.txt'), 'deleted-by-them');
    assert.strictEqual(byPath.get('p6new.txt'), 'added-by-both');

    // The view renders one row per conflicted file.
    const rows = reg.viewProvider.getChildren();
    assert.strictEqual(rows.length, 3);

    // Continue is blocked while conflicts remain.
    assert.strictEqual(session.canContinue, false);
    assert.strictEqual(await session.continueOp(), false);

    // Accept-side rows resolve and disappear.
    await session.acceptSide(['p6c.txt'], 'theirs');
    assert.strictEqual(fs.readFileSync(abs('p6c.txt'), 'utf8'), 'theirs\n');
    await waitFor(() => !session.files().some((f) => f.path === 'p6c.txt'), 10_000);
    assert.ok(session.resolved.has('p6c.txt'), 'resolved set must track the file');

    // Delete/mode conflicts resolve through the tailored QuickPick.
    process.env['GITTREE_TEST_SPECIAL_CHOICE'] = '0'; // keep OUR modified file
    try {
      const node = { session, path: 'p6d.txt', kind: 'deleted-by-them' as const };
      await vscode.commands.executeCommand('gittree.merge.open', node);
    } finally {
      delete process.env['GITTREE_TEST_SPECIAL_CHOICE'];
    }
    await waitFor(() => !session.files().some((f) => f.path === 'p6d.txt'), 10_000);
    assert.strictEqual(fs.readFileSync(abs('p6d.txt'), 'utf8'), 'modified by us\n');

    await session.acceptSide(['p6new.txt'], 'ours');
    await waitFor(() => session.remaining === 0, 10_000);
    assert.strictEqual(session.canContinue, true);

    // Continue completes the merge: MERGE_HEAD gone, two-parent commit.
    assert.strictEqual(await session.continueOp(), true);
    await waitFor(() => reg.getSession(repoRoot) === undefined, 15_000);
    const parents = git('log', '--format=%P', '-1').trim().split(/\s+/);
    assert.strictEqual(parents.length, 2, 'merge commit expected');
    assert.ok(!fs.existsSync(path.join(repo.dirs.gitDir, 'MERGE_HEAD')));
  });

  test('T2: binary conflicts route to the whole-file side QuickPick', async function () {
    this.timeout(90_000);
    const oursBytes = [0x6f, 0x00, 0x03, 0x6f];
    const theirsBytes = [0x74, 0x00, 0x02, 0x74];
    git('checkout', '-f', 'main');
    git('checkout', '-b', 'p6/bin');
    fs.writeFileSync(abs('p6bin.dat'), Buffer.from([0x62, 0x00, 0x01, 0x62]));
    commitAll('p6 bin base');
    git('checkout', '-b', 'p6/bin-side');
    fs.writeFileSync(abs('p6bin.dat'), Buffer.from(theirsBytes));
    commitAll('p6 bin theirs');
    git('checkout', 'p6/bin');
    fs.writeFileSync(abs('p6bin.dat'), Buffer.from(oursBytes));
    commitAll('p6 bin ours');
    try {
      git('merge', 'p6/bin-side');
      assert.fail('merge should conflict');
    } catch {
      // expected — binary conflict
    }
    await repo.refresher.refreshNow();
    await waitFor(() => reg.getSession(repoRoot) !== undefined, 15_000);
    const session = reg.getSession(repoRoot)!;

    // Classified as a text-kind conflict (both-modified), but compute()
    // detects binary content and opens the side QuickPick instead of T3.
    process.env['GITTREE_TEST_SPECIAL_CHOICE'] = '1'; // keep THEIR version
    try {
      const node = { session, path: 'p6bin.dat', kind: 'both-modified' as const };
      await vscode.commands.executeCommand('gittree.merge.open', node);
    } finally {
      delete process.env['GITTREE_TEST_SPECIAL_CHOICE'];
    }
    await waitFor(() => session.remaining === 0, 10_000);
    assert.deepStrictEqual([...fs.readFileSync(abs('p6bin.dat'))], theirsBytes);
    assert.strictEqual(await session.continueOp(), true);
    await waitFor(() => reg.getSession(repoRoot) === undefined, 15_000);
  });

  test('T1: abort restores the pre-merge state and closes the session', async function () {
    this.timeout(90_000);
    buildConflict('abort');
    const preHead = git('rev-parse', 'HEAD').trim();
    await repo.refresher.refreshNow();
    await waitFor(() => reg.getSession(repoRoot) !== undefined, 15_000);
    const session = reg.getSession(repoRoot)!;

    await session.abortOp();
    assert.strictEqual(git('rev-parse', 'HEAD').trim(), preHead, 'abort must restore HEAD');
    assert.ok(!fs.existsSync(path.join(repo.dirs.gitDir, 'MERGE_HEAD')));
    const status = git('status', '--porcelain');
    assert.strictEqual(status.trim(), '', `worktree must be clean after abort: ${status}`);
    await waitFor(() => reg.getSession(repoRoot) === undefined, 15_000);
  });
});
