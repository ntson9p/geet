import * as assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { RepoHandle } from '../../../src/core/core';
import type { SnapshotManifest } from '../../../src/localHistory/snapshotStore';
import type { RebaseEngine } from '../../../src/rewrite/rebase/rebaseEngine';
import type { RebasePausedEvent, RebaseStateMonitor } from '../../../src/rewrite/rebase/stateMonitor';
import type { RebasePlan, RebasePlanEntry } from '../../../src/rewrite/rebase/planSerializer';
import { activateGitTree, waitFor, workspaceRepoA } from '../setup';

interface Phase05RegistryShape {
  getEngine(repoRoot: string): RebaseEngine | undefined;
  getMonitor(repoRoot: string): RebaseStateMonitor | undefined;
}
interface Phase09RegistryShape {
  getStore(repoRoot: string): { list(): SnapshotManifest[] } | undefined;
}

/**
 * P5-T1 acceptance matrix on workspace repoA. Every case runs on its own
 * branch off `main`; teardown aborts any wedged rebase and deletes the
 * branch. The reorder case doubles as the sequence-editor shim proof: git's
 * own todo would preserve the original order, so a reversed result can only
 * come from the shim installing our plan (Windows quoting included).
 */
suite('P5 history rewriting — rebase engine', () => {
  let repoRoot: string;
  let repo: RepoHandle;
  let engine: RebaseEngine;
  let monitor: RebaseStateMonitor;
  let p9: Phase09RegistryShape;

  /**
   * Raw CLI with Windows lock-retries: ref writes can transiently collide
   * with the extension's own background readers (EPERM on symref rename),
   * exactly the AV/file-lock class git itself retries.
   */
  const git = (...args: string[]): string => {
    let lastErr: unknown;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' });
      } catch (err) {
        lastErr = err;
        const text = String(err);
        if (!/Permission denied|Another git process|unable to write/i.test(text)) throw err;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150 * (attempt + 1));
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  };
  const abs = (rel: string): string => path.join(repoRoot, rel);
  const write = (rel: string, content: string | Buffer): void =>
    fs.writeFileSync(abs(rel), content);

  const commit = (rel: string, content: string, subject: string): string => {
    write(rel, content);
    git('add', '--', rel);
    git('commit', '-m', subject);
    return git('rev-parse', 'HEAD').trim();
  };
  const subjects = (base: string): string[] =>
    git('log', '--format=%s', '--reverse', `${base}..HEAD`).trim().split('\n');
  const trees = (base: string): string[] =>
    git('log', '--format=%T', '--reverse', `${base}..HEAD`).trim().split('\n');
  const pick = (sha: string): RebasePlanEntry => ({ sha, action: 'pick' });

  suiteSetup(async function () {
    this.timeout(60_000);
    const core = await activateGitTree();
    repo = core.repoForPath(workspaceRepoA())!;
    assert.ok(repo, 'repoA not discovered');
    repoRoot = repo.root;
    const reg = core.debugRegistry.get('phase05') as Phase05RegistryShape;
    assert.ok(reg, 'phase05 registry missing');
    const e = reg.getEngine(repoRoot);
    const m = reg.getMonitor(repoRoot);
    assert.ok(e && m, 'engine/monitor missing for repoA');
    engine = e;
    monitor = m;
    p9 = core.debugRegistry.get('phase09') as Phase09RegistryShape;
    assert.ok(p9, 'phase09 registry missing (snapshot asserts need it)');
    git('checkout', '-f', 'main');
  });

  teardown(async function () {
    this.timeout(30_000);
    try {
      git('rebase', '--abort');
    } catch {
      // no rebase in progress — fine
    }
    try {
      git('checkout', '-f', 'main');
    } catch {
      // already there
    }
    const branches = git('branch', '--list', 'p5/*', '--format=%(refname:short)')
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
    fs.rmSync(abs('p5-dirty.txt'), { force: true });
    await repo.refresher.refreshNow();
  });

  /** Branch + base sha for one matrix case. */
  function onBranch(name: string): string {
    git('checkout', '-f', 'main');
    git('checkout', '-b', `p5/${name}`);
    return git('rev-parse', 'HEAD').trim();
  }

  test('reorder(3): reversed plan executes via the shim; final tree identical', async function () {
    this.timeout(60_000);
    const base = onBranch('reorder');
    const a = commit('p5a.txt', 'a\n', 'A');
    const b = commit('p5b.txt', 'b\n', 'B');
    const c = commit('p5c.txt', 'c\n', 'C');
    const preTree = git('rev-parse', 'HEAD^{tree}').trim();

    const plan: RebasePlan = { baseSha: base, entries: [pick(c), pick(b), pick(a)] };
    const outcome = await engine.start(plan);
    assert.strictEqual(outcome.status, 'completed', outcome.stderr);
    assert.deepStrictEqual(subjects(base), ['C', 'B', 'A']);
    assert.strictEqual(git('rev-parse', 'HEAD^{tree}').trim(), preTree, 'independent-file reorder must keep the final tree');
  });

  test('reword(head & mid): messages change, per-commit trees unchanged', async function () {
    this.timeout(60_000);
    const base = onBranch('reword');
    const a = commit('p5a.txt', 'a\n', 'A');
    const b = commit('p5b.txt', 'b\n', 'B');
    const c = commit('p5c.txt', 'c\n', 'C');
    const preTrees = trees(base);

    const plan: RebasePlan = {
      baseSha: base,
      entries: [
        pick(a),
        { sha: b, action: 'reword', message: 'B reworded\n\nwith a body line' },
        { sha: c, action: 'reword', message: 'C reworded (head)' },
      ],
    };
    const outcome = await engine.start(plan);
    assert.strictEqual(outcome.status, 'completed', outcome.stderr);
    assert.deepStrictEqual(subjects(base), ['A', 'B reworded', 'C reworded (head)']);
    assert.ok(
      git('log', '--format=%B', '-1', 'HEAD^').includes('with a body line'),
      'multi-line reword body missing',
    );
    assert.deepStrictEqual(trees(base), preTrees, 'reword must not touch trees');
  });

  test('squash(2) with custom message combines commits, preserves content', async function () {
    this.timeout(60_000);
    const base = onBranch('squash');
    const a = commit('p5a.txt', 'a\n', 'A');
    const b = commit('p5b.txt', 'b\n', 'B');
    const c = commit('p5c.txt', 'c\n', 'C');
    const [, treeB, treeC] = trees(base);

    const plan: RebasePlan = {
      baseSha: base,
      entries: [
        pick(a),
        { sha: b, action: 'squash', message: 'A and B combined\n\nsquashed body' },
        pick(c),
      ],
    };
    const outcome = await engine.start(plan);
    assert.strictEqual(outcome.status, 'completed', outcome.stderr);
    assert.deepStrictEqual(subjects(base), ['A and B combined', 'C']);
    assert.ok(git('log', '--format=%B', '-1', 'HEAD^').includes('squashed body'));
    assert.deepStrictEqual(trees(base), [treeB, treeC], 'squashed trees must match originals');
  });

  test('fixup keeps the target message and drops the fixed-up one', async function () {
    this.timeout(60_000);
    const base = onBranch('fixup');
    const a = commit('p5a.txt', 'a\n', 'A original');
    const b = commit('p5b.txt', 'b\n', 'B goes away');
    const plan: RebasePlan = { baseSha: base, entries: [pick(a), { sha: b, action: 'fixup' }] };
    const outcome = await engine.start(plan);
    assert.strictEqual(outcome.status, 'completed', outcome.stderr);
    assert.deepStrictEqual(subjects(base), ['A original']);
    assert.ok(fs.existsSync(abs('p5b.txt')), 'fixup must keep content');
  });

  test('drop(mid) removes the commit and its content, descendants intact', async function () {
    this.timeout(60_000);
    const base = onBranch('drop');
    const a = commit('p5a.txt', 'a\n', 'A');
    const b = commit('p5b.txt', 'b\n', 'B dropped');
    const c = commit('p5c.txt', 'c\n', 'C');
    const plan: RebasePlan = {
      baseSha: base,
      entries: [pick(a), { sha: b, action: 'drop' }, pick(c)],
    };
    const outcome = await engine.start(plan);
    assert.strictEqual(outcome.status, 'completed', outcome.stderr);
    assert.deepStrictEqual(subjects(base), ['A', 'C']);
    assert.ok(!fs.existsSync(abs('p5b.txt')), 'dropped file must be gone');
    assert.ok(fs.existsSync(abs('p5a.txt')) && fs.existsSync(abs('p5c.txt')));
  });

  test('conflict → abort restores pre-state byte-identical (snapshot + ORIG_HEAD)', async function () {
    this.timeout(90_000);
    const base = onBranch('abort');
    commit('p5w.txt', 'w0\n', 'W base');
    commit('p5x.txt', 'base\n', 'X base');
    const c1 = commit('p5x.txt', 'one\n', 'C1');
    const c2 = commit('p5x.txt', 'two\n', 'C2');
    const preHead = c2;

    // Dirty tracked file (CRLF + unicode) — --autostash must round-trip it.
    const dirtyBytes = Buffer.from('w dirty æ †\r\nsecond\n', 'utf8');
    write('p5w.txt', dirtyBytes);
    write('p5-dirty.txt', 'untracked survives\n');
    // The P9 hook enumerates dirty files from the model — wait until the
    // refresh pipeline has genuinely caught up (refreshNow may coalesce).
    await repo.refresher.refreshNow();
    await waitFor(
      () => repo.model.snapshot.statusEntries.some((e) => e.path === 'p5w.txt'),
      10_000,
    );

    const paused: RebasePausedEvent[] = [];
    const sub = monitor.onDidPause((e) => paused.push(e));
    try {
      // Reordering same-file edits guarantees a conflict at step 1.
      const plan: RebasePlan = { baseSha: base, entries: [pick(c2), pick(c1)] };
      const outcome = await engine.start(plan);
      assert.strictEqual(outcome.status, 'paused', outcome.stderr);
      assert.ok(engine.isRebaseInProgress(), 'rebase state dir must exist while paused');
      // The merge backend only writes ORIG_HEAD when a rebase *finishes*;
      // while paused, the pre-rebase anchor (what --abort restores) lives in
      // rebase-merge/orig-head.
      const origHead = fs
        .readFileSync(path.join(repo.dirs.gitDir, 'rebase-merge', 'orig-head'), 'utf8')
        .trim();
      assert.strictEqual(origHead, preHead, 'orig-head anchors the pre-rebase state');
      await waitFor(() => paused.length > 0, 15_000);
      const evt = paused[0];
      assert.ok(evt, 'pause event missing');
      assert.deepStrictEqual(evt.conflictedPaths, ['p5x.txt']);

      await engine.abort();
      assert.strictEqual(git('rev-parse', 'HEAD').trim(), preHead, 'abort must restore HEAD');
      assert.ok(!engine.isRebaseInProgress());
      assert.ok(
        Buffer.from(fs.readFileSync(abs('p5w.txt'))).equals(dirtyBytes),
        'autostashed dirty file must come back byte-identical',
      );
      assert.strictEqual(fs.readFileSync(abs('p5x.txt'), 'utf8'), 'two\n');
      assert.ok(fs.existsSync(abs('p5-dirty.txt')), 'untracked file must survive');

      const manifests = p9.getStore(repoRoot)?.list() ?? [];
      const snap = manifests.find(
        (m) => m.label === 'Before: rebase' && m.files.some((f) => f.relPath === 'p5w.txt'),
      );
      assert.ok(snap, 'P9 snapshot "Before: rebase" with the dirty file missing');
    } finally {
      sub.dispose();
    }
  });

  test('conflict → resolve → continue completes the rebase', async function () {
    this.timeout(90_000);
    onBranch('continue');
    commit('p5x.txt', 'base\n', 'X base');
    const xBase = git('rev-parse', 'HEAD').trim();
    const c1 = commit('p5x.txt', 'one\n', 'C1');
    const c2 = commit('p5x.txt', 'two\n', 'C2');

    const paused: RebasePausedEvent[] = [];
    const sub = monitor.onDidPause((e) => paused.push(e));
    try {
      // Dropping C1 makes C2's patch (one→two) conflict against 'base'.
      const plan: RebasePlan = {
        baseSha: xBase,
        entries: [{ sha: c1, action: 'drop' }, pick(c2)],
      };
      const outcome = await engine.start(plan);
      assert.strictEqual(outcome.status, 'paused', outcome.stderr);
      await waitFor(() => paused.length > 0, 15_000);
      // stopped-sha holds a unique abbreviation of the conflicting commit.
      const stopped = paused[0]?.stoppedSha;
      assert.ok(
        stopped !== undefined && stopped.length >= 7 && c2.startsWith(stopped),
        `stopped-sha ${stopped ?? '<none>'} should abbreviate ${c2}`,
      );

      // A premature continue must refuse while conflicts are unresolved.
      const early = await engine.continueRebase();
      assert.strictEqual(early.status, 'paused');

      write('p5x.txt', 'two\n');
      git('add', '--', 'p5x.txt');
      const done = await engine.continueRebase();
      assert.strictEqual(done.status, 'completed', done.stderr);
      assert.deepStrictEqual(subjects(xBase), ['C2']);
      assert.strictEqual(fs.readFileSync(abs('p5x.txt'), 'utf8'), 'two\n');
      assert.ok(!engine.isRebaseInProgress());
    } finally {
      sub.dispose();
    }
  });

  test('pre-flight refuses ranges containing merge commits', async function () {
    this.timeout(60_000);
    const base = onBranch('merges');
    commit('p5a.txt', 'a\n', 'A');
    git('checkout', '-b', 'p5/merges-side', base);
    commit('p5s.txt', 's\n', 'S');
    git('checkout', 'p5/merges');
    git('merge', '--no-ff', '-m', 'M merge', 'p5/merges-side');
    const head = git('rev-parse', 'HEAD').trim();

    assert.strictEqual(await engine.hasMergesInRange(base), true);
    const outcome = await engine.start({ baseSha: base, entries: [pick(head)] });
    assert.strictEqual(outcome.status, 'refused-merges');
    assert.strictEqual(git('rev-parse', 'HEAD').trim(), head, 'refusal must not move HEAD');
  });
});
