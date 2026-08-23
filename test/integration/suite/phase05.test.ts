import * as assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { RepoHandle } from '../../../src/core/core';
import type { SnapshotManifest } from '../../../src/localHistory/snapshotStore';
import { canonicalKey } from '../../../src/core/repoDiscovery';
import type { RebaseEngine } from '../../../src/rewrite/rebase/rebaseEngine';
import type { RebaseViewController } from '../../../src/rewrite/rebase/rebaseView';
import type { RebasePausedEvent, RebaseStateMonitor } from '../../../src/rewrite/rebase/stateMonitor';
import type { RebasePlan, RebasePlanEntry } from '../../../src/rewrite/rebase/planSerializer';
import type { PushSafetyService } from '../../../src/rewrite/pushSafety';
import type { RevertCherryPickService } from '../../../src/rewrite/revertCherryPick';
import type { RewordService } from '../../../src/rewrite/reword';
import type { UndoDropService } from '../../../src/rewrite/undoDrop';
import { activateGitTree, gitWithRetry, waitFor, workspaceRepoA } from '../setup';

interface Phase05RegistryShape {
  getEngine(repoRoot: string): RebaseEngine | undefined;
  getMonitor(repoRoot: string): RebaseStateMonitor | undefined;
  rebaseView: RebaseViewController;
  undoDrop: UndoDropService;
  revertPick: RevertCherryPickService;
  reword: RewordService;
  pushSafety: PushSafetyService;
}
interface Phase01Shape {
  sourceControls: Map<string, { sc: { inputBox: { value: string } } }>;
}
interface Phase03Shape {
  paradigm: { paradigm: string; switch(): Promise<void> };
  changelistsFor(repo: RepoHandle): {
    getLists(): Array<{ id: string; name: string; files: string[] }>;
  };
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
   * Raw CLI with Windows lock-retries: ref writes can collide with the
   * extension's background readers or AV scans holding `.git/HEAD` for
   * seconds after heavy churn (EPERM on the symref rename) — the file-lock
   * class the master plan calls out for Windows. Budget covers AV holds.
   */
  const git = (...args: string[]): string => gitWithRetry(repoRoot, args);
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
    // Let watcher-poked follow-up refreshes drain before the next test's
    // checkout churn — less pressure on .git/HEAD.
    await new Promise((r) => setTimeout(r, 300));
  });

  /** Bare repos hold read-only object files — clear the flag before rm. */
  function rmrfGitDir(dir: string): void {
    try {
      for (const entry of fs.readdirSync(dir, { recursive: true, encoding: 'utf8' })) {
        try {
          fs.chmodSync(path.join(dir, entry), 0o666);
        } catch {
          // directories / already gone
        }
      }
    } catch {
      // dir missing
    }
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  }

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

  test('T2: dialog-built plan (reorder + squash + reword) produces the expected log', async function () {
    this.timeout(90_000);
    const base = onBranch('dialog');
    const a = commit('p5a.txt', 'a\n', 'A');
    const b = commit('p5b.txt', 'b\n', 'B');
    const c = commit('p5c.txt', 'c\n', 'C');
    const preHeadTree = git('rev-parse', 'HEAD^{tree}').trim();
    const [treeA] = trees(base);

    const view = (await activateGitTree()).debugRegistry.get('phase05') as Phase05RegistryShape;
    const controller = view.rebaseView;
    const opened = await controller.open(repo, a);
    assert.strictEqual(opened, true, 'dialog should open');
    const state = controller.currentState;
    assert.ok(state, 'controller state missing');
    assert.strictEqual(state.phase, 'edit');
    assert.strictEqual(state.baseSha, base);
    assert.deepStrictEqual(
      state.rows.map((r) => [r.sha, r.subject]),
      [
        [a, 'A'],
        [b, 'B'],
        [c, 'C'],
      ],
      'rows must cover the range oldest-first',
    );
    assert.strictEqual(state.published, false, 'unpushed branch must not be flagged published');

    // Exactly what the webview Start button posts after the user reworded A,
    // dragged C above B, and squashed B into C with a custom message.
    const result = await controller.startRebase({
      entries: [
        { sha: a, action: 'reword', message: 'A reworded\n\nby the dialog' },
        { sha: c, action: 'pick' },
        { sha: b, action: 'squash', message: 'C and B combined\n\nvia dialog' },
      ],
      forceAcknowledged: false,
    });
    assert.strictEqual(result.ok, true, result.error);
    assert.strictEqual(controller.currentState?.phase, 'done');
    assert.strictEqual(controller.currentState.outcome, 'completed');

    assert.deepStrictEqual(subjects(base), ['A reworded', 'C and B combined']);
    assert.ok(git('log', '--format=%B', '-1', 'HEAD').includes('via dialog'));
    assert.ok(git('log', '--format=%B', '-1', 'HEAD^').includes('by the dialog'));
    // Trees: reworded A keeps its tree; the squashed head holds all files.
    assert.deepStrictEqual(trees(base), [treeA, preHeadTree]);

    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });

  test('T3: undo commit files paths into a named changelist and prefills the input', async function () {
    this.timeout(60_000);
    const core = await activateGitTree();
    const reg = core.debugRegistry.get('phase05') as Phase05RegistryShape;
    const p3 = core.debugRegistry.get('phase03') as Phase03Shape;
    const p1 = core.debugRegistry.get('phase01') as Phase01Shape;
    // The P3 suite leaves the window on the staging paradigm; undo's
    // changelist filing is a changelists-paradigm behavior.
    const originalParadigm = p3.paradigm.paradigm;
    if (p3.paradigm.paradigm !== 'changelists') {
      await p3.paradigm.switch();
      await waitFor(() => p3.paradigm.paradigm === 'changelists', 10_000);
    }

    onBranch('undo');
    write('p5undo-a.txt', 'alpha\n');
    write('p5undo-b.txt', 'beta\n');
    git('add', '--', 'p5undo-a.txt', 'p5undo-b.txt');
    git('commit', '-m', 'Fix parser bug', '-m', 'details body');
    const committed = git('rev-parse', 'HEAD').trim();
    const parent = git('rev-parse', 'HEAD^').trim();
    await repo.refresher.refreshNow();

    try {
      const result = await reg.undoDrop.undoCommit(repo);
      assert.strictEqual(result.status, 'done');
      assert.strictEqual(git('rev-parse', 'HEAD').trim(), parent, 'HEAD must move to the parent');

      // Files are back as unstaged worktree changes (changelists paradigm).
      const status = git('status', '--porcelain');
      assert.ok(/\?\?\s+p5undo-a\.txt/.test(status), `expected untracked a: ${status}`);
      assert.ok(/\?\?\s+p5undo-b\.txt/.test(status), `expected untracked b: ${status}`);

      const list = p3.changelistsFor(repo).getLists().find((l) => l.name === 'Fix parser bug');
      assert.ok(list, 'changelist named after the subject missing');
      assert.deepStrictEqual([...list.files].sort(), ['p5undo-a.txt', 'p5undo-b.txt']);

      const input = p1.sourceControls.get(canonicalKey(repoRoot))?.sc.inputBox;
      assert.ok(input, 'input box missing');
      assert.ok(input.value.includes('Fix parser bug'), `input: ${input.value}`);
      assert.ok(input.value.includes('details body'), 'full message (body) must be restored');
      assert.notStrictEqual(git('rev-parse', 'HEAD').trim(), committed);
    } finally {
      fs.rmSync(abs('p5undo-a.txt'), { force: true });
      fs.rmSync(abs('p5undo-b.txt'), { force: true });
      const input = p1.sourceControls.get(canonicalKey(repoRoot))?.sc.inputBox;
      if (input) input.value = '';
      if (p3.paradigm.paradigm !== originalParadigm) {
        await p3.paradigm.switch();
        await waitFor(() => p3.paradigm.paradigm === originalParadigm, 10_000);
      }
      await repo.refresher.refreshNow();
    }
  });

  test('T3: drop of a mid commit preserves descendant content and is undoable in-session', async function () {
    this.timeout(60_000);
    const core = await activateGitTree();
    const reg = core.debugRegistry.get('phase05') as Phase05RegistryShape;
    const base = onBranch('dropcmd');
    commit('p5a.txt', 'a1\n', 'A');
    const b = commit('p5b.txt', 'b\n', 'B dropped');
    write('p5a.txt', 'a2\n');
    write('p5c.txt', 'c\n');
    git('add', '--', 'p5a.txt', 'p5c.txt');
    git('commit', '-m', 'C');
    const preHead = git('rev-parse', 'HEAD').trim();
    const preBlobA = git('rev-parse', 'HEAD:p5a.txt').trim();
    const preBlobC = git('rev-parse', 'HEAD:p5c.txt').trim();

    const result = await reg.undoDrop.dropCommit(repo, b);
    assert.strictEqual(result.status, 'completed', 'stderr' in result ? result.stderr : undefined);
    assert.deepStrictEqual(subjects(base), ['A', 'C']);
    assert.ok(!fs.existsSync(abs('p5b.txt')), 'dropped file must be gone');
    assert.strictEqual(git('rev-parse', 'HEAD:p5a.txt').trim(), preBlobA, 'descendant blob A changed');
    assert.strictEqual(git('rev-parse', 'HEAD:p5c.txt').trim(), preBlobC, 'descendant blob C changed');

    // In-session Undo (the toast action) restores the pre-drop head.
    const undone = await reg.undoDrop.undoLastDrop(repo);
    assert.strictEqual(undone, true);
    assert.strictEqual(git('rev-parse', 'HEAD').trim(), preHead);
    assert.deepStrictEqual(subjects(base), ['A', 'B dropped', 'C']);
  });

  test('T3: undo and drop refuse published commits unless forced', async function () {
    this.timeout(90_000);
    const core = await activateGitTree();
    const reg = core.debugRegistry.get('phase05') as Phase05RegistryShape;
    onBranch('published');
    const a = commit('p5a.txt', 'a\n', 'A published');
    commit('p5b.txt', 'b\n', 'B published');
    const head = git('rev-parse', 'HEAD').trim();

    const remoteDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gittree-p5-remote-'));
    execFileSync('git', ['init', '--bare', remoteDir]);
    git('remote', 'add', 'p5origin', remoteDir);
    try {
      git('push', '-u', 'p5origin', 'p5/published');
      await repo.refresher.refreshNow();

      // Auto-decline the warn modal → both operations must refuse.
      process.env['GITTREE_TEST_AUTOCONFIRM'] = '0';
      const undoRefused = await reg.undoDrop.undoCommit(repo);
      assert.strictEqual(undoRefused.status, 'refused-published');
      assert.strictEqual(git('rev-parse', 'HEAD').trim(), head, 'refused undo must not move HEAD');
      const dropRefused = await reg.undoDrop.dropCommit(repo, a);
      assert.strictEqual(dropRefused.status, 'refused-published');
      assert.strictEqual(git('rev-parse', 'HEAD').trim(), head, 'refused drop must not move HEAD');

      // Forced (acknowledged modal) → the drop proceeds.
      process.env['GITTREE_TEST_AUTOCONFIRM'] = '1';
      const forced = await reg.undoDrop.dropCommit(repo, a);
      assert.strictEqual(forced.status, 'completed', 'stderr' in forced ? forced.stderr : undefined);
      assert.deepStrictEqual(
        git('log', '--format=%s', '-1').trim(),
        'B published',
        'forced drop must remove the published commit',
      );
    } finally {
      // The runner sets '1' globally — restore it, never delete.
      process.env['GITTREE_TEST_AUTOCONFIRM'] = '1';
      try {
        git('remote', 'remove', 'p5origin');
      } catch {
        // best effort
      }
      rmrfGitDir(remoteDir);
    }
  });

  test('T4: revert of a merge commit uses -m 1 and undoes the merged branch', async function () {
    this.timeout(60_000);
    const core = await activateGitTree();
    const reg = core.debugRegistry.get('phase05') as Phase05RegistryShape;
    onBranch('revmerge');
    commit('p5m.txt', 'mainline\n', 'M base');
    git('checkout', '-b', 'p5/revmerge-side');
    commit('p5s.txt', 'side\n', 'S side');
    write('p5m.txt', 'side changed\n');
    git('add', '--', 'p5m.txt');
    git('commit', '-m', 'S modifies m');
    git('checkout', 'p5/revmerge');
    git('merge', '--no-ff', '-m', 'M merge side', 'p5/revmerge-side');
    const mergeSha = git('rev-parse', 'HEAD').trim();
    await repo.refresher.refreshNow();

    const outcome = await reg.revertPick.revert(repo, [mergeSha]);
    assert.strictEqual(outcome.status, 'completed', outcome.stderr);
    assert.strictEqual(outcome.newShas?.length, 1);
    assert.ok(!fs.existsSync(abs('p5s.txt')), 'side-branch file must be undone');
    assert.strictEqual(fs.readFileSync(abs('p5m.txt'), 'utf8'), 'mainline\n', 'mainline content restored');
    assert.ok(
      git('log', '--format=%s', '-1').trim().startsWith('Revert "M merge side"'),
      'default revert message template must be preserved',
    );
  });

  test('T4: multi-pick with a mid-sequence conflict → skip → completes the rest', async function () {
    this.timeout(90_000);
    const core = await activateGitTree();
    const reg = core.debugRegistry.get('phase05') as Phase05RegistryShape;
    // Source branch: three picks, the middle one conflicting with the target.
    onBranch('picksrc');
    commit('p5conflict.txt', 'base\n', 'seed');
    const seed = git('rev-parse', 'HEAD').trim();
    const s1 = commit('p5f1.txt', 'f1\n', 'S1 clean');
    write('p5conflict.txt', 'source\n');
    git('add', '--', 'p5conflict.txt');
    git('commit', '-m', 'S2 conflicts');
    const s2 = git('rev-parse', 'HEAD').trim();
    const s3 = commit('p5f3.txt', 'f3\n', 'S3 clean');

    // Target diverges on the same file.
    git('checkout', '-b', 'p5/picktarget', seed);
    write('p5conflict.txt', 'target\n');
    git('add', '--', 'p5conflict.txt');
    git('commit', '-m', 'T1 target');
    await repo.refresher.refreshNow();

    const outcome = await reg.revertPick.cherryPick(repo, [s1, s2, s3]);
    assert.strictEqual(outcome.status, 'paused', outcome.stderr);
    assert.strictEqual(outcome.step, 2, 'paused at the 2nd of 3 picks');
    assert.strictEqual(outcome.total, 3);
    assert.ok(fs.existsSync(path.join(repo.dirs.gitDir, 'CHERRY_PICK_HEAD')), 'CHERRY_PICK_HEAD expected');

    const done = await reg.revertPick.skipSequence(repo, 'cherry-pick');
    assert.strictEqual(done.status, 'completed', done.stderr);
    assert.deepStrictEqual(done.newShas?.length, 2, 'S1 and S3 picked, S2 skipped');
    const log = git('log', '--format=%s', `${seed}..HEAD`);
    assert.ok(log.includes('S1 clean') && log.includes('S3 clean'), `log: ${log}`);
    assert.ok(!log.includes('S2 conflicts'), 'skipped commit must not appear');
    assert.strictEqual(fs.readFileSync(abs('p5conflict.txt'), 'utf8'), 'target\n');
    assert.ok(fs.existsSync(abs('p5f1.txt')) && fs.existsSync(abs('p5f3.txt')));
  });

  test('T4: recordOrigin setting adds the -x trailer', async function () {
    this.timeout(60_000);
    const core = await activateGitTree();
    const reg = core.debugRegistry.get('phase05') as Phase05RegistryShape;
    onBranch('picksrc2');
    commit('p5seed2.txt', 'seed\n', 'seed2');
    const seed = git('rev-parse', 'HEAD').trim();
    const src = commit('p5x.txt', 'x\n', 'X picked with origin');
    git('checkout', '-b', 'p5/picktarget2', seed);
    await repo.refresher.refreshNow();

    const config = vscode.workspace.getConfiguration('gittree.cherryPick');
    await config.update('recordOrigin', true, vscode.ConfigurationTarget.Global);
    try {
      const outcome = await reg.revertPick.cherryPick(repo, [src]);
      assert.strictEqual(outcome.status, 'completed', outcome.stderr);
      const body = git('log', '--format=%B', '-1');
      assert.ok(
        body.includes(`(cherry picked from commit ${src})`),
        `-x trailer missing in: ${body}`,
      );
    } finally {
      await config.update('recordOrigin', undefined, vscode.ConfigurationTarget.Global);
    }
  });

  test('T5: reword mid-history rewrites only messages (tree ids unchanged across the range)', async function () {
    this.timeout(60_000);
    const core = await activateGitTree();
    const reg = core.debugRegistry.get('phase05') as Phase05RegistryShape;
    const base = onBranch('reword2');
    commit('p5a.txt', 'a\n', 'A');
    const b = commit('p5b.txt', 'b\n', 'B original');
    commit('p5c.txt', 'c\n', 'C');
    const preTrees = trees(base);

    process.env['GITTREE_TEST_REWORD_MESSAGE'] = 'B message rewritten\n\nwith a new body';
    try {
      const result = await reg.reword.reword(repo, b);
      assert.strictEqual(result, 'done');
    } finally {
      delete process.env['GITTREE_TEST_REWORD_MESSAGE'];
    }
    assert.deepStrictEqual(subjects(base), ['A', 'B message rewritten', 'C']);
    assert.ok(git('log', '--format=%B', '-1', 'HEAD^').includes('with a new body'));
    assert.deepStrictEqual(trees(base), preTrees, 'reword must not change any tree in the range');
  });

  test('T5: reword of HEAD amends the message only — staged changes stay staged', async function () {
    this.timeout(60_000);
    const core = await activateGitTree();
    const reg = core.debugRegistry.get('phase05') as Phase05RegistryShape;
    onBranch('rewordhead');
    const head = commit('p5a.txt', 'a\n', 'A head original');
    const preTree = git('rev-parse', 'HEAD^{tree}').trim();
    // A staged-but-uncommitted file must NOT be swept into the amend.
    write('p5staged.txt', 'staged only\n');
    git('add', '--', 'p5staged.txt');

    process.env['GITTREE_TEST_REWORD_MESSAGE'] = 'A head reworded';
    try {
      const result = await reg.reword.reword(repo, head);
      assert.strictEqual(result, 'done');
      assert.strictEqual(git('log', '--format=%s', '-1').trim(), 'A head reworded');
      assert.strictEqual(git('rev-parse', 'HEAD^{tree}').trim(), preTree, 'tree must be untouched');
      const status = git('status', '--porcelain');
      assert.ok(/^A\s+p5staged\.txt/m.test(status), `staged file must remain staged: ${status}`);
    } finally {
      delete process.env['GITTREE_TEST_REWORD_MESSAGE'];
      try {
        git('reset', '--', 'p5staged.txt');
      } catch {
        // nothing staged
      }
      fs.rmSync(abs('p5staged.txt'), { force: true });
    }
  });

  test('T6: rewrite on a published branch offers force-with-lease and it updates the remote', async function () {
    this.timeout(90_000);
    const core = await activateGitTree();
    const reg = core.debugRegistry.get('phase05') as Phase05RegistryShape;
    onBranch('pushsafety');
    // Mid-history commit: its reword runs through the engine, whose
    // completion event drives the push-safety offer.
    const a = commit('p5a.txt', 'a\n', 'A to reword');
    commit('p5b.txt', 'b\n', 'B');
    const remoteDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gittree-p5-lease-'));
    execFileSync('git', ['init', '--bare', remoteDir]);
    git('remote', 'add', 'p5safety', remoteDir);

    const offers: string[] = [];
    const sub = reg.pushSafety.onDidOffer((e) => offers.push(e.upstream));
    process.env['GITTREE_TEST_PUSHSAFETY_CHOICE'] = 'push';
    try {
      git('push', '-u', 'p5safety', 'p5/pushsafety');
      await repo.refresher.refreshNow();

      // Rewrite a published commit (autoconfirm accepts the published modal).
      process.env['GITTREE_TEST_REWORD_MESSAGE'] = 'A reworded after publish';
      const result = await reg.reword.reword(repo, a);
      assert.strictEqual(result, 'done');
      delete process.env['GITTREE_TEST_REWORD_MESSAGE'];

      // The engine fires the rewrite event → offer → seam chooses push.
      await waitFor(() => offers.length > 0, 15_000);
      assert.strictEqual(offers[0], 'p5safety/p5/pushsafety');
      const localHead = git('rev-parse', 'HEAD').trim();
      await waitFor(
        () =>
          execFileSync('git', ['rev-parse', 'refs/heads/p5/pushsafety'], {
            cwd: remoteDir,
            encoding: 'utf8',
          }).trim() === localHead,
        20_000,
      );
    } finally {
      delete process.env['GITTREE_TEST_PUSHSAFETY_CHOICE'];
      delete process.env['GITTREE_TEST_REWORD_MESSAGE'];
      sub.dispose();
      try {
        git('remote', 'remove', 'p5safety');
      } catch {
        // best effort
      }
      rmrfGitDir(remoteDir);
    }
  });

  test('T6: a stale lease refuses the force push and the remote stays intact', async function () {
    this.timeout(90_000);
    const core = await activateGitTree();
    const reg = core.debugRegistry.get('phase05') as Phase05RegistryShape;
    onBranch('stalelease');
    commit('p5a.txt', 'a\n', 'A');
    const b = commit('p5b.txt', 'b\n', 'B stale');
    const remoteDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gittree-p5-stale-'));
    const cloneDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gittree-p5-clone-'));
    execFileSync('git', ['init', '--bare', remoteDir]);
    git('remote', 'add', 'p5stale', remoteDir);
    try {
      git('push', '-u', 'p5stale', 'p5/stalelease');

      // Someone else advances the remote after our last fetch…
      execFileSync('git', ['clone', '--branch', 'p5/stalelease', remoteDir, path.join(cloneDir, 'c')]);
      const c = path.join(cloneDir, 'c');
      execFileSync('git', ['config', 'user.email', 't@t.dev'], { cwd: c });
      execFileSync('git', ['config', 'user.name', 'T'], { cwd: c });
      fs.writeFileSync(path.join(c, 'other.txt'), 'other\n');
      execFileSync('git', ['add', '.'], { cwd: c });
      execFileSync('git', ['commit', '-m', 'remote moved'], { cwd: c });
      execFileSync('git', ['push'], { cwd: c });
      const remoteTip = execFileSync('git', ['rev-parse', 'refs/heads/p5/stalelease'], {
        cwd: remoteDir,
        encoding: 'utf8',
      }).trim();

      // …meanwhile we rewrite locally and force-with-lease against stale info.
      process.env['GITTREE_TEST_REWORD_MESSAGE'] = 'B reworded stale';
      const result = await reg.reword.reword(repo, b);
      assert.strictEqual(result, 'done');
      delete process.env['GITTREE_TEST_REWORD_MESSAGE'];

      await vscode.commands.executeCommand('gittree.pushForceWithLease', repo.root);

      // The lease must refuse: remote tip unchanged, no crash surfaced.
      const after = execFileSync('git', ['rev-parse', 'refs/heads/p5/stalelease'], {
        cwd: remoteDir,
        encoding: 'utf8',
      }).trim();
      assert.strictEqual(after, remoteTip, 'stale lease must not overwrite the remote');
      assert.notStrictEqual(after, git('rev-parse', 'HEAD').trim());
    } finally {
      delete process.env['GITTREE_TEST_REWORD_MESSAGE'];
      try {
        git('remote', 'remove', 'p5stale');
      } catch {
        // best effort
      }
      rmrfGitDir(remoteDir);
      rmrfGitDir(cloneDir);
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
