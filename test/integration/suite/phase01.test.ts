import * as assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { canonicalKey } from '../../../src/core/repoDiscovery';
import { isConflicted, isStaged, isUnstaged, isUntracked } from '../../../src/core/model/statusEntry';
import { activateGitTree, gitWithRetry, waitFor, workspaceRepoA } from '../setup';

/**
 * Phase 1 acceptance: SCM groups, rev provider, file ops, commit MVP,
 * status-bar widget + sync against a local bare remote.
 * Runs against workspace repoA (safe: the discovery suite runs earlier).
 * Each test seeds and cleans up its own repo state.
 */
suite('P1 core SCM', () => {
  let repoRoot: string;

  const git = (...args: string[]): string => gitWithRetry(repoRoot, args);

  const write = (rel: string, content: string): void =>
    fs.writeFileSync(path.join(repoRoot, rel), content);

  /**
   * P14-T4: no `sourceControls` any more. The status bar owns real
   * `StatusBarItem`s, and `titles` is the seam that replaced reading
   * `SourceControl.statusBarCommands[i].title`.
   */
  interface BarShape {
    update(): void;
    titles: string[];
    tooltips: string[];
  }
  interface Phase01RegistryShape {
    statusBars: Map<string, BarShape>;
  }

  /**
   * POST-P14r: `gittree.statusBar` decides the widget's shape, and `auto` — the
   * default — picks the compact button whenever the built-in Git extension is
   * present, which it always is in this window. Assertions about the *readout*
   * therefore have to say which mode they mean.
   */
  async function withStatusBarMode(
    mode: 'button' | 'full' | 'off',
    bar: BarShape,
    fn: () => void | Promise<void>,
  ): Promise<void> {
    const cfg = vscode.workspace.getConfiguration('gittree');
    await cfg.update('statusBar', mode, vscode.ConfigurationTarget.Workspace);
    try {
      // The config listener fires on its own; this makes the read deterministic
      // rather than racing the event.
      bar.update();
      await fn();
    } finally {
      await cfg.update('statusBar', undefined, vscode.ConfigurationTarget.Workspace);
      bar.update();
    }
  }

  /** P14-T2: file commands now take the commit window's context shape. */
  const fileArg = (rel: string) => ({ repoRoot, relPath: rel });

  async function barOf(root: string) {
    const core = await activateGitTree();
    const reg = core.debugRegistry.get('phase01') as Phase01RegistryShape | undefined;
    assert.ok(reg, 'phase01 registry missing — registerPhase01 not run?');
    const bar = reg.statusBars.get(canonicalKey(root));
    assert.ok(bar, `no status bar controller for ${root}`);
    return bar;
  }

  async function refresh(): Promise<void> {
    const core = await activateGitTree();
    await core.repoForPath(repoRoot)!.refresher.refreshNow();
  }

  let coreCache: Awaited<ReturnType<typeof activateGitTree>> | undefined;
  const paradigmOf = (): string | undefined =>
    (coreCache?.debugRegistry.get('phase03') as { paradigm: { paradigm: string } } | undefined)
      ?.paradigm.paradigm;

  suiteSetup(async function () {
    this.timeout(60_000);
    repoRoot = workspaceRepoA();
    coreCache = await activateGitTree();

    // Phase 3's changelists paradigm is the default; this suite asserts on
    // staged/unstaged classification, so run it in staging mode.
    await vscode.workspace
      .getConfiguration('gittree')
      .update('commit.paradigm', 'staging', vscode.ConfigurationTarget.Workspace);
    await waitFor(() => paradigmOf() === 'staging', 10_000);
  });

  suiteTeardown(async function () {
    this.timeout(30_000);
    // Restore the default paradigm for the Phase 3 suite.
    await vscode.workspace
      .getConfiguration('gittree')
      .update('commit.paradigm', undefined, vscode.ConfigurationTarget.Workspace);
    await waitFor(() => paradigmOf() === 'changelists', 10_000);
  });

  test('T1: status entries classify into the four kinds and the badge counts them', async function () {
    this.timeout(60_000);

    // Conflict first (merge requires a clean index)…
    write('conflict.txt', 'base\n');
    git('add', 'conflict.txt');
    git('commit', '-m', 'conflict base');
    git('checkout', '-b', 'p1-side');
    write('conflict.txt', 'side\n');
    git('commit', '-am', 'side');
    git('checkout', '-');
    write('conflict.txt', 'main\n');
    git('commit', '-am', 'main');
    try {
      git('merge', 'p1-side');
    } catch {
      // expected conflict
    }
    // …then seed the other groups mid-merge (git add works during merges).
    write('staged.txt', 'staged content\n');
    git('add', 'staged.txt');
    fs.appendFileSync(path.join(repoRoot, 'README.md'), 'unstaged edit\n');
    write('untracked.txt', 'new\n');

    await refresh();
    // P14-T2 retired the four resource groups; what they rendered was always
    // this classification. P14-T4 moved the count badge itself onto the commit
    // view, where the phase14 suite asserts it — what belongs here is that the
    // classification totals what the badge would show.
    const core = await activateGitTree();
    const entriesOf = () => core.repoForPath(repoRoot)!.model.snapshot.statusEntries;
    const kinds = () => {
      const e = entriesOf().filter((x) => x.kind !== 'ignored');
      return {
        merge: e.filter((x) => isConflicted(x)).length,
        untracked: e.filter((x) => isUntracked(x)).length,
        staged: e.filter((x) => !isConflicted(x) && !isUntracked(x) && isStaged(x)).length,
        changes: e.filter((x) => !isConflicted(x) && !isUntracked(x) && isUnstaged(x)).length,
      };
    };
    await waitFor(() => {
      const k = kinds();
      return k.merge === 1 && k.staged === 1 && k.changes === 1 && k.untracked === 1;
    }, 15_000);
    const k = kinds();
    assert.strictEqual(
      k.merge + k.staged + k.changes + k.untracked,
      4,
      'every classified entry must be counted exactly once',
    );

    const conflict = entriesOf().find((e) => e.path.endsWith('conflict.txt'));
    assert.ok(conflict && isConflicted(conflict), 'conflict.txt should be unmerged');
    const staged = entriesOf().find((e) => e.path.endsWith('staged.txt'));
    assert.ok(staged && isStaged(staged), 'staged.txt should be staged');

    // Cleanup: resolve the merge (commits staged.txt too), restore the rest.
    git('add', 'conflict.txt');
    git('commit', '-m', 'resolve p1 conflict');
    git('branch', '-D', 'p1-side');
    git('restore', 'README.md');
    fs.rmSync(path.join(repoRoot, 'untracked.txt'));
    await refresh();
  });

  test('T2: gittree-rev provider serves index and HEAD content', async function () {
    this.timeout(30_000);
    await activateGitTree();
    write('t2-index.txt', 'index only\n');
    git('add', 't2-index.txt');

    const q = (rel: string, ref: string) =>
      vscode.Uri.from({
        scheme: 'gittree-rev',
        path: '/' + rel,
        query: JSON.stringify({ repo: repoRoot, rel, ref }),
      });
    const indexDoc = await vscode.workspace.openTextDocument(q('t2-index.txt', ':0'));
    assert.strictEqual(indexDoc.getText(), 'index only\n');
    const headDoc = await vscode.workspace.openTextDocument(q('t2-index.txt', 'HEAD'));
    assert.strictEqual(headDoc.getText(), ''); // not committed → empty original
    const readmeHead = await vscode.workspace.openTextDocument(q('README.md', 'HEAD'));
    assert.ok(readmeHead.getText().startsWith('# repoA'));

    git('rm', '--cached', '-q', 't2-index.txt');
    fs.rmSync(path.join(repoRoot, 't2-index.txt'));
    await refresh();
  });

  test('T4: stage / unstage / rollback via commands', async function () {
    this.timeout(60_000);
    // P14-T2: the arguments are the commit window's {repoRoot, relPath} context
    // now that the SCM resource states are gone — the same path a right-click
    // in the change tree takes.
    const core = await activateGitTree();
    const entry = (rel: string) =>
      core.repoForPath(repoRoot)!.model.snapshot.statusEntries.find((e) => e.path === rel);

    fs.appendFileSync(path.join(repoRoot, 'README.md'), 'unstaged edit\n');
    write('t4-untracked.txt', 'x\n');
    await refresh();
    await waitFor(() => {
      const e = entry('README.md');
      return e !== undefined && isUnstaged(e);
    }, 15_000);

    // Stage via command.
    await vscode.commands.executeCommand('gittree.add', fileArg('README.md'));
    await refresh();
    await waitFor(() => {
      const e = entry('README.md');
      return e !== undefined && isStaged(e);
    }, 15_000);

    // Unstage via command.
    await vscode.commands.executeCommand('gittree.unstage', fileArg('README.md'));
    await refresh();
    await waitFor(() => {
      const e = entry('README.md');
      return e !== undefined && isUnstaged(e);
    }, 15_000);

    // Rollback (modal auto-confirmed in the test env) → file restored.
    await vscode.commands.executeCommand('gittree.rollbackFile', fileArg('README.md'));
    await waitFor(
      () => !fs.readFileSync(path.join(repoRoot, 'README.md'), 'utf8').includes('unstaged edit'),
      15_000,
    );

    // Rollback of an untracked file deletes it.
    await refresh();
    await waitFor(() => {
      const e = entry('t4-untracked.txt');
      return e !== undefined && isUntracked(e);
    }, 15_000);
    await vscode.commands.executeCommand('gittree.rollbackFile', fileArg('t4-untracked.txt'));
    await waitFor(() => !fs.existsSync(path.join(repoRoot, 't4-untracked.txt')), 15_000);
    await refresh();
  });

  test('POST-P14w: Add to .gitignore writes the nearest ignore file', async function () {
    this.timeout(60_000);
    const core = await activateGitTree();
    const entry = (rel: string) =>
      core.repoForPath(repoRoot)!.model.snapshot.statusEntries.find((e) => e.path === rel);
    const pkgDir = path.join(repoRoot, 'pkg');
    const rootIgnore = path.join(repoRoot, '.gitignore');
    const pkgIgnore = path.join(pkgDir, '.gitignore');

    fs.mkdirSync(pkgDir, { recursive: true });
    // The package already keeps its own ignore file; the root does not, so the
    // command has to create one — both halves of the rule in one run.
    fs.writeFileSync(pkgIgnore, '*.tmp\n');
    write('w-root.log', 'x\n');
    fs.writeFileSync(path.join(pkgDir, 'gen.ts'), 'x\n');
    await refresh();
    await waitFor(() => entry('w-root.log') !== undefined && entry('pkg/gen.ts') !== undefined, 15_000);

    try {
      await vscode.commands.executeCommand('gittree.gitignore.add', {
        repoRoot,
        relPath: 'w-root.log',
        relPaths: ['w-root.log', 'pkg/gen.ts'],
      });
      // Anchored and relative to the file it is written into: `/gen.ts` in the
      // package, not `/pkg/gen.ts`, which would match nothing from there.
      await waitFor(() => fs.existsSync(rootIgnore), 15_000);
      assert.match(fs.readFileSync(rootIgnore, 'utf8'), /^\/w-root\.log$/mu);
      const pkgText = fs.readFileSync(pkgIgnore, 'utf8');
      assert.match(pkgText, /^\/gen\.ts$/mu);
      assert.match(pkgText, /^\*\.tmp$/mu, 'existing rules must survive the append');

      // The rows are gone from the commit window because git no longer reports
      // them — which is the whole point of the action.
      await refresh();
      await waitFor(() => entry('w-root.log') === undefined && entry('pkg/gen.ts') === undefined, 15_000);
    } finally {
      // Every byte this test wrote goes, or the next suite inherits an
      // untracked file it never made — the pollution `discovery.test.ts`
      // records as the cause of cascading false failures.
      fs.rmSync(rootIgnore, { force: true });
      fs.rmSync(path.join(repoRoot, 'w-root.log'), { force: true });
      fs.rmSync(pkgDir, { recursive: true, force: true });
      await refresh();
    }
  });

  test('POST-P14bq: Reveal in File Explorer shows the row it was opened on', async function () {
    this.timeout(60_000);
    const core = await activateGitTree();
    const reveals = core.debugRegistry.get('revealInOS') as
      | {
          supported: boolean;
          recent(): Array<{ outcome: string; path?: string }>;
          clear(): void;
        }
      | undefined;
    assert.ok(reveals, 'revealInOS registry missing — registerRevealInOS not run?');
    // The test window is a local desktop one, where the item is offered.
    assert.strictEqual(reveals.supported, true);
    // Under GITTREE_TEST nothing opens: the registry is what the user would have seen.
    const root = core.repoForPath(repoRoot)!.root;
    const dir = path.join(repoRoot, 'reveal-me');
    fs.mkdirSync(path.join(dir, 'deep'), { recursive: true });
    write('reveal-me/deep/here.txt', 'x\n');
    reveals.clear();
    try {
      // A file row inside a selection of two: the row clicked, alone. Any of
      // the three commands does it; each platform's menu shows its own.
      await vscode.commands.executeCommand('gittree.revealFileInOS.windows', {
        webviewSection: 'commitFile',
        repoRoot,
        relPath: 'reveal-me/deep/here.txt',
        relPaths: ['reveal-me/deep/here.txt', 'README.md'],
      });
      // A folder row: its folder, not the first file it also carries.
      await vscode.commands.executeCommand('gittree.revealFileInOS.linux', {
        webviewSection: 'commitFolder',
        repoRoot,
        relPath: 'reveal-me/deep/here.txt',
        relPaths: ['reveal-me/deep/here.txt'],
        folder: 'reveal-me/deep',
      });
      // Gone since the tree was drawn: said, not attempted.
      await vscode.commands.executeCommand('gittree.revealFileInOS.mac', {
        repoRoot,
        relPath: 'reveal-me/not-there.txt',
      });
      // Out of the repository: refused before anything is looked at.
      await vscode.commands.executeCommand('gittree.revealFileInOS.windows', { repoRoot, relPath: '../outside.txt' });
      assert.deepStrictEqual(reveals.recent(), [
        { outcome: 'revealed', path: path.join(root, 'reveal-me', 'deep', 'here.txt') },
        { outcome: 'revealed', path: path.join(root, 'reveal-me', 'deep') },
        { outcome: 'missing', path: path.join(root, 'reveal-me', 'not-there.txt') },
      ]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      reveals.clear();
      await refresh();
    }
  });

  test('T7: commit from the commit window message box (staged + amend)', async function () {
    this.timeout(60_000);
    // P14-T2: the SCM input box is gone; the commit window's message box is the
    // one place a message lives, and the same commands read it.
    const core = await activateGitTree();
    const reg = core.debugRegistry.get('phase03') as {
      messageBoxFor: (r: ReturnType<typeof core.repoForPath>) => { value: string };
    };
    const box = reg.messageBoxFor(core.repoForPath(repoRoot));
    write('t7.txt', 'commit me\n');
    git('add', 't7.txt');
    await refresh();
    const before = git('rev-parse', 'HEAD').trim();

    // The commit flow gates on the check pipeline, and whether a check has a
    // finding to report is timing-dependent (analyze waits for diagnostics to
    // quiesce). Declare the intent explicitly, the way phase03's T5 does — and
    // RESTORE the previous value rather than deleting it, because the runner
    // sets this kind of env once for the whole process (see setup.ts).
    const prevChoice = process.env['GITTREE_TEST_CHECKS_CHOICE'];
    process.env['GITTREE_TEST_CHECKS_CHOICE'] = 'anyway';
    try {
      // The window's setter persists through workspaceState without awaiting,
      // so read it back first: an empty message aborts the flow silently and
      // would look exactly like "the commit never ran".
      box.value = 'p1 commit from the commit window';
      await waitFor(() => box.value === 'p1 commit from the commit window', 5_000);
      await vscode.commands.executeCommand('gittree.commit', repoRoot);
      await waitFor(() => git('rev-parse', 'HEAD').trim() !== before, 30_000);
      assert.strictEqual(git('log', '-1', '--format=%s').trim(), 'p1 commit from the commit window');
      assert.strictEqual(box.value, '');

      // `commitAmend` decides what it is amending from the repo model, and the
      // commit command resolves while the refresh it kicked off is still in
      // flight. Synchronize on the precondition itself — the model observing
      // the commit — instead of on elapsed time; under full-suite load the
      // incidental delay is not enough and the amend races the stale HEAD.
      const committed = git('rev-parse', 'HEAD').trim();
      await refresh();
      await waitFor(() => core.repoForPath(repoRoot)!.model.snapshot.headSha === committed, 30_000);

      box.value = 'p1 amended message';
      await waitFor(() => box.value === 'p1 amended message', 5_000);
      await vscode.commands.executeCommand('gittree.commitAmend', repoRoot);
      await waitFor(() => git('log', '-1', '--format=%s').trim() === 'p1 amended message', 30_000);
    } finally {
      if (prevChoice === undefined) delete process.env['GITTREE_TEST_CHECKS_CHOICE'];
      else process.env['GITTREE_TEST_CHECKS_CHOICE'] = prevChoice;
    }
    await refresh();
  });

  test('T5: status bar reflects divergence and sync round-trips', async function () {
    this.timeout(120_000);
    const core = await activateGitTree();
    const repo = core.repoForPath(repoRoot)!;
    const bar = await barOf(repoRoot);

    // Local bare remote + upstream.
    const remote = fs.mkdtempSync(path.join(os.tmpdir(), 'gittree-p1-remote-'));
    execFileSync('git', ['init', '--bare'], { cwd: remote });
    const branch = git('rev-parse', '--abbrev-ref', 'HEAD').trim();
    execFileSync('git', ['symbolic-ref', 'HEAD', `refs/heads/${branch}`], { cwd: remote });
    git('remote', 'add', 'origin', remote);
    git('push', '-u', 'origin', branch);

    // Diverge: 1 ahead (local), 2 behind (remote commits via clone).
    write('ahead.txt', 'ahead\n');
    git('add', 'ahead.txt');
    git('commit', '-m', 'local ahead');
    const cloneDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gittree-p1-clone-'));
    execFileSync('git', ['clone', remote, 'c'], { cwd: cloneDir });
    const clone = path.join(cloneDir, 'c');
    const cgit = (...args: string[]) => execFileSync('git', args, { cwd: clone, encoding: 'utf8' });
    cgit('config', 'user.email', 't@t.dev');
    cgit('config', 'user.name', 'T');
    for (const n of [1, 2]) {
      fs.writeFileSync(path.join(clone, `remote${n}.txt`), `${n}\n`);
      cgit('add', '.');
      cgit('commit', '-m', `remote ${n}`);
    }
    cgit('push');

    git('fetch');
    await refresh();
    await waitFor(
      () => (repo.model.snapshot.behind ?? 0) === 2 && (repo.model.snapshot.ahead ?? 0) === 1,
      15_000,
    );

    // POST-P14r: divergence is the `full` widget's job. The default is the
    // compact button, because VS Code's own Git widget is already reporting
    // this — so the readout is asserted in the mode that owns it.
    await withStatusBarMode('full', bar, () => {
      const title = bar.titles[0] ?? '';
      assert.ok(title.includes(branch), `widget: ${title}`);
      assert.ok(title.includes('$(arrow-down) 2'), `widget: ${title}`);
      assert.ok(title.includes('$(arrow-up) 1'), `widget: ${title}`);
      // One item now, not two: the sync readout folded into the widget.
      assert.ok(
        (bar.titles[1] ?? '') === '',
        `expected a single widget item, got ${JSON.stringify(bar.titles)}`,
      );
    });

    // And in the default mode it costs a fixed width and says none of it.
    const button = bar.titles[0] ?? '';
    assert.strictEqual(button, '$(list-tree) GitTree $(chevron-down)', `button: ${button}`);
    const tip = bar.tooltips[0] ?? '';
    assert.ok(tip.includes('2 behind'), `tooltip must carry the exact counts: ${tip}`);
    assert.ok(tip.includes('1 ahead'), `tooltip must carry the exact counts: ${tip}`);

    await vscode.commands.executeCommand('gittree.sync', repoRoot);
    await refresh();
    await waitFor(
      () => (repo.model.snapshot.ahead ?? 0) === 0 && (repo.model.snapshot.behind ?? 0) === 0,
      20_000,
    );
    const remoteLog = execFileSync('git', ['log', '--format=%s', branch], {
      cwd: remote,
      encoding: 'utf8',
    });
    assert.ok(remoteLog.includes('local ahead'));
  });

  test('T5: detached HEAD renders short sha in the widget', async function () {
    this.timeout(30_000);
    const core = await activateGitTree();
    const repo = core.repoForPath(repoRoot)!;
    const bar = await barOf(repoRoot);
    const branch = git('rev-parse', '--abbrev-ref', 'HEAD').trim();
    git('checkout', '--detach', 'HEAD');
    await refresh();
    await waitFor(() => repo.model.snapshot.detached, 15_000);
    await withStatusBarMode('full', bar, () => {
      const title = bar.titles[0] ?? '';
      assert.ok(title.includes('$(git-commit)'), `widget: ${title}`);
    });
    // The button says nothing about it — but its tooltip still has to.
    assert.ok(
      (bar.tooltips[0] ?? '').includes('Detached at'),
      `tooltip: ${bar.tooltips[0] ?? ''}`,
    );
    git('checkout', branch);
    await refresh();
  });
});
