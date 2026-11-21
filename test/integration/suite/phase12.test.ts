import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { RepoHandle } from '../../../src/core/core';
import { canonicalKey } from '../../../src/core/repoDiscovery';
import type { Phase02Registry } from '../../../src/branches/register';
import type { Phase04Registry } from '../../../src/log/register';
import type { Phase13Registry } from '../../../src/scm/dialogs/register';
import { zipChanges } from '../../../src/log/zipChanges';
import { applyPatchFile } from '../../../src/rewrite/patch/applyPatch';
import { createPatchText, createPatchToFile } from '../../../src/rewrite/patch/createPatch';
import { LOG_METHODS } from '../../../src/shared/protocol';
import { activateGeet, gitWithRetry, waitFor, workspaceRepoC } from '../setup';

/**
 * P12 Git tool window — host half. The four-pane layout, pane cycling and
 * persistence are Playwright-covered (log.spec.ts); these tests pin the host
 * contract: every webview→host method is answered, and the selection model
 * lives host-side.
 */
suite('P12 git tool window', () => {
  let reg: Phase04Registry;
  let p2: Phase02Registry;
  let repo: RepoHandle;
  let repoRoot: string;

  const git = (...args: string[]): string => gitWithRetry(repoRoot, args);
  const write = (rel: string, content: string): void => {
    const p = path.join(repoRoot, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  };

  let coreRef: Awaited<ReturnType<typeof activateGeet>>;

  suiteSetup(async function () {
    this.timeout(60_000);
    repoRoot = workspaceRepoC();
    const core = await activateGeet();
    coreRef = core;
    reg = core.debugRegistry.get('phase04') as Phase04Registry;
    p2 = core.debugRegistry.get('phase02') as Phase02Registry;
    repo = core.repoForPath(repoRoot)!;
    assert.ok(reg && p2 && repo, 'registries missing');
    // The log shows one repository and no longer re-picks it from the focused
    // editor, so this suite claims repoC outright instead of nudging the guess
    // by opening a file in it.
    reg.logView.showRoot(repo.root);
  });

  /** Re-tick the default list so later tests keep their commit targets. */
  const restoreChecked = (): void => {
    const p3 = coreRef.debugRegistry.get('phase03') as {
      changelistsFor(r: RepoHandle): { setListChecked(id: string, checked: boolean): void };
    };
    p3.changelistsFor(repo).setListChecked('default', true);
  };

  test('T1: every webview→host log method has a host handler', async function () {
    this.timeout(30_000);
    await vscode.commands.executeCommand('geet.log.focus');
    await waitFor(() => reg.logView.hasHandler(LOG_METHODS.init), 15_000);
    // The P11-T3 lesson: `on()` and `onEvent()` are different routers, and a
    // missing handler fails in total silence. Assert the whole surface.
    for (const [name, method] of Object.entries(LOG_METHODS)) {
      if (name.startsWith('evt')) continue; // host → webview
      assert.ok(reg.logView.hasHandler(method), `no host handler for ${method}`);
    }
  });

  test('T1: the selection model lives host-side and starts empty', function () {
    this.timeout(15_000);
    assert.deepStrictEqual([...reg.logView.selectedCommits], []);
  });

  test('T2: the branches DTO groups refs, favorites and the current branch', async function () {
    this.timeout(60_000);
    const base = git('rev-parse', '--abbrev-ref', 'HEAD').trim();
    git('branch', 'feature/f1');
    git('branch', 'feature/f1-1');
    git('branch', 'feature/f2');
    git('tag', 'p12-tag');
    await repo.refresher.refreshNow();
    await waitFor(
      () => repo.model.snapshot.refs.some((r) => r.name === 'feature/f1-1'),
      20_000,
    );

    const refService = p2.refServices.get(canonicalKey(repoRoot))!;
    await refService.toggleFavorite('feature/f2');
    try {
      const dto = await reg.logView.branchesBridge.buildBranches(repo);
      assert.strictEqual(dto.current, base);
      assert.strictEqual(dto.detached, false);
      const names = dto.locals.map((b) => b.name);
      for (const expected of ['feature/f1', 'feature/f1-1', 'feature/f2', base]) {
        assert.ok(names.includes(expected), `missing local ${expected}: ${names.join(', ')}`);
      }
      assert.strictEqual(dto.locals.find((b) => b.name === 'feature/f2')?.favorite, true);
      assert.strictEqual(dto.locals.find((b) => b.name === 'feature/f1')?.favorite, false);
      assert.ok(dto.tags.includes('p12-tag'), `tags: ${dto.tags.join(', ')}`);
    } finally {
      await refService.toggleFavorite('feature/f2');
    }
  });

  test('T2: registry dispatch and the native-menu command run the same checkout', async function () {
    this.timeout(60_000);
    const base = git('rev-parse', '--abbrev-ref', 'HEAD').trim();
    // The pane's rail path: the shared registry.
    await reg.logView.branchesBridge.dispatch(repo, {
      action: 'checkout',
      name: 'feature/f1',
      type: 'local',
    });
    await waitFor(() => git('rev-parse', '--abbrev-ref', 'HEAD').trim() === 'feature/f1', 20_000);
    // The pane's context-menu path: the command with the webview context arg.
    await vscode.commands.executeCommand('geet.log.branch.checkout', {
      repoRoot,
      refName: base,
      refType: 'local',
    });
    await waitFor(() => git('rev-parse', '--abbrev-ref', 'HEAD').trim() === base, 20_000);
  });

  test('T2: selecting a ref filters the commits pane to that branch', async function () {
    this.timeout(90_000);
    const base = git('rev-parse', '--abbrev-ref', 'HEAD').trim();
    git('checkout', 'feature/f2');
    write('p12/f2-only.txt', 'only on f2\n');
    git('add', 'p12/f2-only.txt');
    git('commit', '-m', 'p12 f2 only commit');
    git('checkout', base);
    await repo.refresher.refreshNow();

    const expected = Number.parseInt(git('rev-list', '--count', 'feature/f2').trim(), 10);
    // `feature/f2` is one of *this* repository's branches, so the filter names
    // where it lives. It used to have to anchor the guess by opening a file
    // here first, which is not something a caller should have to arrange.
    await reg.logView.setFilter({ sort: 'topo', refs: ['feature/f2'] }, repoRoot);
    // The REAL webview requests the pages after the reset — same as a user
    // clicking the branch in the pane.
    try {
      await waitFor(() => reg.logView.currentSession?.rowCount === expected, 30_000);
    } catch (err) {
      throw new Error(
        `rowCount=${reg.logView.currentSession?.rowCount} expected=${expected} ` +
          `filter=${JSON.stringify(reg.logView.currentSession?.filter)} ` +
          `trail=${reg.logView.debugTrail.slice(-12).join(' | ')} (${String(err)})`,
      );
    }
    assert.deepStrictEqual(reg.logView.currentSession?.filter.refs, ['feature/f2']);

    await reg.logView.setFilter({ sort: 'topo', refs: 'HEAD' }, repoRoot);
    await waitFor(() => (reg.logView.currentSession?.rowCount ?? 0) > 0, 30_000);
  });

  test('T3: single-commit files match git show — rename pair and merge semantics', async function () {
    this.timeout(90_000);
    const service = reg.logView.logServiceFor(repo);

    write('p12/mv-src.txt', 'move me\n');
    git('add', 'p12/mv-src.txt');
    git('commit', '-m', 'p12 rename base');
    git('mv', 'p12/mv-src.txt', 'p12/mv-dst.txt');
    git('commit', '-m', 'p12 rename move');
    const renameSha = git('rev-parse', 'HEAD').trim();

    const rename = await service.getCommitDetails(renameSha);
    assert.ok(rename, 'rename commit details missing');
    assert.strictEqual(rename.files.length, 1);
    assert.ok(rename.files[0]!.status.startsWith('R'), rename.files[0]!.status);
    assert.strictEqual(rename.files[0]!.path, 'p12/mv-dst.txt');
    assert.strictEqual(rename.files[0]!.origPath, 'p12/mv-src.txt');

    // A clean merge: `git show --name-status` prints no per-file rows for
    // merges (combined-diff semantics) — matching git IS the acceptance.
    const base = git('rev-parse', '--abbrev-ref', 'HEAD').trim();
    git('checkout', '-b', 'p12/merge-side');
    write('p12/merge-side.txt', 'side\n');
    git('add', 'p12/merge-side.txt');
    git('commit', '-m', 'p12 side commit');
    git('checkout', base);
    git('merge', '--no-ff', '-m', 'p12 merge commit', 'p12/merge-side');
    const mergeSha = git('rev-parse', 'HEAD').trim();
    const merge = await service.getCommitDetails(mergeSha);
    assert.ok(merge, 'merge details missing');
    const gitShown = git('show', '--name-status', '--format=', mergeSha).trim();
    assert.strictEqual(
      merge.files.length,
      gitShown.length === 0 ? 0 : gitShown.split('\n').length,
      `files must match git show (git said: ${JSON.stringify(gitShown)})`,
    );
    git('branch', '-D', 'p12/merge-side');
  });

  test('T3: a 500-file commit reports all 500 files', async function () {
    this.timeout(120_000);
    for (let i = 0; i < 500; i++) {
      write(`p12bulk/f${String(i).padStart(3, '0')}.txt`, `${i}\n`);
    }
    git('add', 'p12bulk');
    git('commit', '-m', 'p12 bulk 500');
    const sha = git('rev-parse', 'HEAD').trim();
    const details = await reg.logView.logServiceFor(repo).getCommitDetails(sha);
    assert.strictEqual(details?.files.length, 500);
    assert.ok(details.files.every((f) => f.status === 'A'));
  });

  test('T3: several selected commits list exactly their own files, as IntelliJ merges them', async function () {
    this.timeout(90_000);
    const mk = (n: number): string => {
      write(`p12/agg-${n}.txt`, `${n}\n`);
      git('add', `p12/agg-${n}.txt`);
      git('commit', '-m', `p12 agg ${n}`);
      return git('rev-parse', 'HEAD').trim();
    };
    const c1 = mk(1);
    mk(2);
    const c3 = mk(3);
    // c1 touches agg-1 again, out of the selection, so the merged row must
    // still start before c1 and end after c3.
    write('p12/agg-1.txt', '1 again\n');
    git('add', 'p12/agg-1.txt');
    git('commit', '-m', 'p12 agg 1 again');
    const c4 = git('rev-parse', 'HEAD').trim();

    const service = reg.logView.logServiceFor(repo);
    // Selected: c4, c3, c1 — newest first, as the graph lists them; c2 is not.
    const perCommit = await service.getCommitsFiles([c1, c3, c4]);
    assert.deepStrictEqual(
      perCommit.map((c) => c.sha),
      [c1, c3, c4],
      'one entry per commit, in the order asked',
    );
    const zipped = zipChanges(perCommit);
    assert.deepStrictEqual(
      zipped.map((f) => f.path).sort(),
      ['p12/agg-1.txt', 'p12/agg-3.txt'],
      'agg-2 belongs to a commit nobody selected',
    );
    const agg1 = zipped.find((f) => f.path === 'p12/agg-1.txt')!;
    assert.strictEqual(agg1.status, 'A', 'added inside the selection, so added overall');
    assert.strictEqual(agg1.after, c4, 'ends at the latest selected commit that touched it');

    // A root commit has no parent; its files still read.
    const root = git('rev-list', '--max-parents=0', 'HEAD').trim().split('\n')[0]!;
    const [rootFiles] = await service.getCommitsFiles([root]);
    assert.ok(rootFiles !== undefined && rootFiles.files.length > 0, 'the root commit introduces its own files');
  });

  test('T5: a saved filter preset persists and restores across a re-init', async function () {
    this.timeout(60_000);
    const config = vscode.workspace.getConfiguration('geet.log');
    const preset = {
      name: 'p12 preset',
      filter: { sort: 'topo' as const, refs: 'HEAD' as const, authors: ['Geet Test'] },
    };
    try {
      await config.update('filterPresets', [preset], vscode.ConfigurationTarget.Workspace);
      // The config change re-inits the session? Presets ship with init — apply
      // the preset's filter and prove the session restores it after a reset,
      // which is exactly what a webview reload does.
      await reg.logView.setFilter(preset.filter, repoRoot);
      await waitFor(() => {
        const f = reg.logView.currentSession?.filter;
        return f !== undefined && JSON.stringify(f.authors) === JSON.stringify(['Geet Test']);
      }, 20_000);
      const stored = vscode.workspace
        .getConfiguration('geet.log')
        .get<Array<{ name: string }>>('filterPresets');
      assert.strictEqual(stored?.[0]?.name, 'p12 preset', 'the preset must survive in settings');
    } finally {
      await config.update('filterPresets', undefined, vscode.ConfigurationTarget.Workspace);
      await reg.logView.setFilter({ sort: 'topo', refs: 'HEAD' }, repoRoot);
    }
  });

  test('T5: a two-path filter pages exactly `git log -- a b`', async function () {
    this.timeout(90_000);
    write('p12/pa/one.txt', '1\n');
    git('add', 'p12/pa/one.txt');
    git('commit', '-m', 'p12 path a');
    write('p12/pb/two.txt', '2\n');
    git('add', 'p12/pb/two.txt');
    git('commit', '-m', 'p12 path b');
    await repo.refresher.refreshNow();

    const expected = Number.parseInt(
      git('rev-list', '--count', 'HEAD', '--', 'p12/pa', 'p12/pb').trim(),
      10,
    );
    assert.ok(expected >= 2, `expected at least the two seeded commits, got ${expected}`);
    await reg.logView.setFilter({ sort: 'topo', refs: 'HEAD', paths: ['p12/pa', 'p12/pb'] }, repoRoot);
    await waitFor(() => reg.logView.currentSession?.rowCount === expected, 30_000);

    await reg.logView.setFilter({ sort: 'topo', refs: 'HEAD' }, repoRoot);
    await waitFor(() => (reg.logView.currentSession?.rowCount ?? 0) > expected, 30_000);
  });

  test('T6: create-from-2-commits → reset --hard → apply restores identical trees', async function () {
    this.timeout(120_000);
    write('p12/patch-a.txt', 'alpha\n');
    git('add', 'p12/patch-a.txt');
    git('commit', '-m', 'p12 patch one');
    const c1 = git('rev-parse', 'HEAD').trim();
    write('p12/patch-b.txt', 'beta\n');
    git('add', 'p12/patch-b.txt');
    git('commit', '-m', 'p12 patch two');
    const c2 = git('rev-parse', 'HEAD').trim();
    const wantTree = git('rev-parse', 'HEAD^{tree}').trim();
    const base = git('rev-parse', 'HEAD~2').trim();

    const patchPath = path.join(repoRoot, '.git', 'p12-roundtrip.patch');
    await createPatchToFile(repo, { kind: 'commits', shas: [c2, c1] }, patchPath);
    assert.ok(fs.readFileSync(patchPath, 'latin1').startsWith('From '), 'mailbox format expected');

    git('reset', '--hard', base);
    await repo.refresher.refreshNow();
    const result = await applyPatchFile(repo, patchPath);
    assert.strictEqual(result.status, 'applied', JSON.stringify(result));
    assert.strictEqual(result.appliedAsCommits, true, 'a mailbox must replay via git am');
    assert.strictEqual(
      git('rev-parse', 'HEAD^{tree}').trim(),
      wantTree,
      'the replayed history must reproduce the identical tree',
    );
    assert.strictEqual(git('log', '-1', '--format=%s').trim(), 'p12 patch two');
    fs.rmSync(patchPath, { force: true });
    await repo.refresher.refreshNow();
  });

  test('T6: a conflicting patch reports its files and leaves no .rej litter', async function () {
    this.timeout(120_000);
    write('p12/conflict.txt', 'line one\nline two\n');
    git('add', 'p12/conflict.txt');
    git('commit', '-m', 'p12 conflict base');
    write('p12/conflict.txt', 'line one CHANGED\nline two\n');
    git('add', 'p12/conflict.txt');
    git('commit', '-m', 'p12 conflict edit');
    const editSha = git('rev-parse', 'HEAD').trim();

    const patchPath = path.join(repoRoot, '.git', 'p12-conflict.patch');
    await createPatchToFile(repo, { kind: 'commits', shas: [editSha] }, patchPath);

    // Move the base under the patch so the 3way has to conflict.
    git('reset', '--hard', 'HEAD~1');
    write('p12/conflict.txt', 'line one DIVERGED\nline two\n');
    git('add', 'p12/conflict.txt');
    git('commit', '-m', 'p12 diverged');

    const result = await applyPatchFile(repo, patchPath);
    assert.strictEqual(result.status, 'conflicts', JSON.stringify(result));
    assert.deepStrictEqual(result.rejected, ['p12/conflict.txt']);
    const rejFiles = fs
      .readdirSync(path.join(repoRoot, 'p12'))
      .filter((f) => f.endsWith('.rej'));
    assert.deepStrictEqual(rejFiles, [], 'no .rej litter — conflicts are unmerged entries');

    // Clean up the conflict state entirely.
    git('reset', '--hard', 'HEAD');
    git('checkout', '--', '.');
    fs.rmSync(patchPath, { force: true });
    await repo.refresher.refreshNow();
  });

  test('T6: binary content round-trips byte-exactly', async function () {
    this.timeout(120_000);
    const bytes = Buffer.from([0, 1, 2, 3, 255, 254, 128, 10, 13, 0, 42]);
    fs.mkdirSync(path.join(repoRoot, 'p12'), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, 'p12/blob.bin'), bytes);
    git('add', 'p12/blob.bin');
    git('commit', '-m', 'p12 binary');
    const sha = git('rev-parse', 'HEAD').trim();

    const patchPath = path.join(repoRoot, '.git', 'p12-binary.patch');
    await createPatchToFile(repo, { kind: 'commits', shas: [sha] }, patchPath);
    git('reset', '--hard', 'HEAD~1');
    assert.ok(!fs.existsSync(path.join(repoRoot, 'p12/blob.bin')));

    const result = await applyPatchFile(repo, patchPath);
    assert.strictEqual(result.status, 'applied', JSON.stringify(result));
    assert.ok(
      fs.readFileSync(path.join(repoRoot, 'p12/blob.bin')).equals(bytes),
      'binary bytes must survive format-patch --binary + am',
    );
    fs.rmSync(patchPath, { force: true });
    await repo.refresher.refreshNow();
  });

  test('T6: a worktree-selection patch carries real context and applies back', async function () {
    this.timeout(120_000);
    write('p12/wt.txt', 'w1\nw2\nw3\n');
    git('add', 'p12/wt.txt');
    git('commit', '-m', 'p12 wt base');
    write('p12/wt.txt', 'w1\nCHANGED\nw3\n');
    await repo.refresher.refreshNow();

    const text = await createPatchText(repo, {
      kind: 'worktree',
      wholePaths: ['p12/wt.txt'],
      partials: [],
    });
    assert.ok(text.includes('@@'), 'a real diff with hunks');
    assert.ok(text.includes(' w1'), 'context lines must be present (not unidiff-zero)');

    git('checkout', '--', 'p12/wt.txt');
    const patchPath = path.join(repoRoot, '.git', 'p12-wt.patch');
    fs.writeFileSync(patchPath, Buffer.from(text, 'latin1'));
    const result = await applyPatchFile(repo, patchPath);
    assert.strictEqual(result.status, 'applied', JSON.stringify(result));
    assert.strictEqual(fs.readFileSync(path.join(repoRoot, 'p12/wt.txt'), 'utf8'), 'w1\nCHANGED\nw3\n');

    git('checkout', '--', 'p12/wt.txt');
    git('reset', '-q');
    fs.rmSync(patchPath, { force: true });
    await repo.refresher.refreshNow();
  });

  test('T7: fixup + autosquash folds the ticked change into the target, linearly', async function () {
    this.timeout(150_000);
    write('p12/fix.txt', 'v1\n');
    git('add', 'p12/fix.txt');
    git('commit', '-m', 'p12 fixup target');
    const target = git('rev-parse', 'HEAD').trim();
    write('p12/other.txt', 'other\n');
    git('add', 'p12/other.txt');
    git('commit', '-m', 'p12 after target');
    const countBefore = git('rev-list', '--count', 'HEAD').trim();

    write('p12/fix.txt', 'v1\nv2 fixed\n');
    await repo.refresher.refreshNow();
    await waitFor(() => {
      const p3 = coreRef.debugRegistry.get('phase03') as {
        changelistsFor(r: RepoHandle): { getLists(): Array<{ checked: string[] }> };
      };
      return p3.changelistsFor(repo).getLists().some((l) => l.checked.includes('p12/fix.txt'));
    }, 20_000);

    process.env['GEET_TEST_AUTOSQUASH'] = 'yes';
    try {
      await vscode.commands.executeCommand('geet.log.fixup', { sha: target });
    } finally {
      delete process.env['GEET_TEST_AUTOSQUASH'];
    }

    await waitFor(() => git('rev-list', '--count', 'HEAD').trim() === countBefore, 30_000);
    const subjects = git('log', '--format=%s', '-5').trim().split('\n');
    assert.ok(!subjects.some((s) => s.startsWith('fixup!')), `history must be linear: ${subjects.join(' | ')}`);
    assert.ok(subjects.includes('p12 fixup target'));
    // The fixup content folded into the target commit itself.
    const rewrittenTarget = git('log', '--format=%H', '--grep=p12 fixup target', '-1').trim();
    assert.strictEqual(git('show', `${rewrittenTarget}:p12/fix.txt`), 'v1\nv2 fixed\n');
    restoreChecked();
  });

  test('T7: a fixup of a non-ancestor is refused with a reason', async function () {
    this.timeout(60_000);
    // A commit on a side branch is not an ancestor of HEAD.
    const base = git('rev-parse', '--abbrev-ref', 'HEAD').trim();
    git('checkout', '-b', 'p12/not-ancestor');
    write('p12/side2.txt', 's\n');
    git('add', 'p12/side2.txt');
    git('commit', '-m', 'p12 side only');
    const side = git('rev-parse', 'HEAD').trim();
    git('checkout', base);
    const head = git('rev-parse', 'HEAD').trim();
    await vscode.commands.executeCommand('geet.log.fixup', { sha: side });
    assert.strictEqual(git('rev-parse', 'HEAD').trim(), head, 'a refused fixup must change nothing');
    git('branch', '-D', 'p12/not-ancestor');
  });

  test('T7: Push All up to Here opens the Push dialog for the commit, which pushes exactly through it', async function () {
    this.timeout(150_000);
    const p13 = coreRef.debugRegistry.get('phase13') as Phase13Registry;
    const branch = git('rev-parse', '--abbrev-ref', 'HEAD').trim();
    const bare = path.join(path.dirname(repoRoot), `p12-bare-${Date.now()}.git`);
    gitWithRetry(path.dirname(repoRoot), ['init', '--bare', bare]);
    const onRemote = (): string => gitWithRetry(bare, ['rev-parse', `refs/heads/${branch}`]).trim();
    try {
      git('remote', 'add', 'origin', bare);
      // Seed the remote two commits behind and set the upstream.
      const base = git('rev-parse', 'HEAD~2').trim();
      git('push', 'origin', `${base}:refs/heads/${branch}`);
      git('fetch', 'origin');
      git('branch', `--set-upstream-to=origin/${branch}`);
      await repo.refresher.refreshNow();
      await waitFor(() => repo.model.snapshot.upstream !== undefined, 20_000);

      // IntelliJ's GitPushUpToCommitAction: the dialog, with the commit as the
      // source and the branch it is on — nothing is pushed until it says so.
      const mid = git('rev-parse', 'HEAD~1').trim();
      const saved = process.env['GEET_TEST_PUSH_DIALOG'];
      process.env['GEET_TEST_PUSH_DIALOG'] = 'cancel';
      p13.clearLastPushDialogRequest();
      try {
        await vscode.commands.executeCommand('geet.log.pushAllUpToHere', { sha: mid });
      } finally {
        if (saved === undefined) delete process.env['GEET_TEST_PUSH_DIALOG'];
        else process.env['GEET_TEST_PUSH_DIALOG'] = saved;
      }
      const opened = p13.lastPushDialogOpened();
      assert.deepStrictEqual(opened?.source, { kind: 'revision', sha: mid, branch });
      assert.deepStrictEqual(opened?.repos, [repo.root]);
      assert.strictEqual(onRemote(), base, 'nothing is pushed before the dialog says so');

      // The row reads `<short hash> → origin : <branch>`, with the one commit
      // between the remote and the selected commit under it.
      const params = await p13.buildPushParams({
        repos: [repo],
        preselected: [repo],
        current: repo,
        source: { kind: 'revision', sha: mid, branch },
      });
      const row = params.repos[0]!;
      assert.strictEqual(row.source.presentation, mid.slice(0, 8));
      assert.deepStrictEqual(row.target, { remote: 'origin', branch, isNew: false, type: 'tracking' });
      assert.deepStrictEqual(
        row.commits.map((c) => c.sha),
        [mid],
      );

      const outcomes = await p13.applyPushResult({
        repos: [{ root: repo.root, source: row.source, target: { remote: 'origin', branch }, setUpstream: false }],
        tags: 'none',
        runHooks: true,
        force: false,
      });
      assert.match(outcomes[0]!, /pushed/, outcomes.join(' · '));
      assert.strictEqual(onRemote(), mid);
      assert.notStrictEqual(onRemote(), git('rev-parse', 'HEAD').trim(), 'HEAD itself must NOT have been pushed');

      // An older commit is a non-fast-forward: the remote turns it away, and
      // being a commit rather than the branch, it is not updated and pushed again.
      git('fetch', 'origin');
      const older = git('rev-parse', 'HEAD~2').trim();
      p13.clearLastPushRejectedPrompt();
      const refused = await p13.applyPushResult({
        repos: [
          {
            root: repo.root,
            source: { kind: 'revision', presentation: older.slice(0, 8), revision: older, branch },
            target: { remote: 'origin', branch },
            setUpstream: false,
          },
        ],
        tags: 'none',
        runHooks: true,
        force: false,
      });
      assert.doesNotMatch(refused[0]!, /pushed$/, refused.join(' · '));
      assert.strictEqual(onRemote(), mid, 'a non-fast-forward push must leave the remote untouched');
      assert.strictEqual(p13.lastPushRejectedPrompt(), undefined, 'a commit pushed on its own is never updated');
    } finally {
      git('remote', 'remove', 'origin');
      try {
        // Bare pack files are read-only on Windows; retries + best effort —
        // a leftover dir in OS temp must never mask a real assertion failure.
        fs.rmSync(bare, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      } catch {
        // leftover temp dir — harmless
      }
      await repo.refresher.refreshNow();
    }
  });

  test('T7: geet-tree serves a 3-commits-ago file read-only', async function () {
    this.timeout(90_000);
    const { makeRevTreeUri } = await import('../../../src/core/vdocs/revTreeFs');
    const rev = git('rev-parse', 'HEAD~3').trim();
    const known = git('ls-tree', '-r', '--name-only', rev)
      .trim()
      .split('\n')
      .find((l) => l.trim().length > 0)!;
    assert.ok(known, 'the revision must have at least one file');

    await vscode.commands.executeCommand('geet.log.showRepoAtRevision', { sha: rev });
    assert.strictEqual(reg.revTree.currentTarget?.rev, rev);

    const rootEntries = await reg.revTreeFs.readDirectory(makeRevTreeUri(repoRoot, rev, ''));
    assert.ok(rootEntries.length > 0, 'the revision root must list entries');

    const uri = makeRevTreeUri(repoRoot, rev, known);
    const bytes = Buffer.from(await reg.revTreeFs.readFile(uri));
    assert.strictEqual(bytes.toString('utf8'), git('show', `${rev}:${known}`));
    const stat = await reg.revTreeFs.stat(uri);
    assert.strictEqual(stat.permissions, vscode.FilePermission.Readonly);
    assert.throws(
      () => reg.revTreeFs.writeFile(),
      /read-only/,
      'writes must be refused',
    );
    const doc = await vscode.workspace.openTextDocument(uri);
    assert.strictEqual(doc.getText(), git('show', `${rev}:${known}`));
    await vscode.commands.executeCommand('geet.revTree.close');
    assert.strictEqual(reg.revTree.currentTarget, undefined);
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });

  test('T7: Reset → Keep refuses rather than discard local changes', async function () {
    this.timeout(90_000);
    write('p12/keep.txt', 'k1\n');
    git('add', 'p12/keep.txt');
    git('commit', '-m', 'p12 keep base');
    write('p12/keep.txt', 'k2\n');
    git('add', 'p12/keep.txt');
    git('commit', '-m', 'p12 keep edit');
    const head = git('rev-parse', 'HEAD').trim();

    const target = git('rev-parse', `${head}~1`).trim();

    // A local change to the very file the reset would rewrite → git refuses.
    write('p12/keep.txt', 'k-local\n');
    await repo.refresher.refreshNow();
    process.env['GEET_TEST_RESET_MODE'] = 'keep';
    try {
      await vscode.commands.executeCommand('geet.log.resetHere', { sha: target });
      assert.strictEqual(git('rev-parse', 'HEAD').trim(), head, 'refused keep must not move HEAD');
      assert.strictEqual(
        fs.readFileSync(path.join(repoRoot, 'p12/keep.txt'), 'utf8'),
        'k-local\n',
        'the local change must survive untouched',
      );

      // With the worktree clean for that file, keep moves HEAD.
      git('checkout', '--', 'p12/keep.txt');
      await vscode.commands.executeCommand('geet.log.resetHere', { sha: target });
      await waitFor(() => git('rev-parse', 'HEAD').trim() !== head, 20_000);
      assert.strictEqual(fs.readFileSync(path.join(repoRoot, 'p12/keep.txt'), 'utf8'), 'k1\n');
    } finally {
      delete process.env['GEET_TEST_RESET_MODE'];
      git('reset', '--hard', head);
      await repo.refresher.refreshNow();
      restoreChecked();
    }
  });

  test('T4: details carry the %G? signature state; unsigned reads N', async function () {
    this.timeout(60_000);
    const service = reg.logView.logServiceFor(repo);
    const head = git('rev-parse', 'HEAD').trim();
    const details = await service.getCommitDetails(head);
    assert.ok(details, 'details missing');
    assert.strictEqual(details.signature, 'N', 'an unsigned commit must read N, never blank');
    assert.ok(details.parents.length > 0, 'parents ship for the parent links');
  });

  test('T4: --contains is lazy and answers the containing branches', async function () {
    this.timeout(60_000);
    const service = reg.logView.logServiceFor(repo);
    const before = service.containsCalls;
    const head = git('rev-parse', 'HEAD').trim();
    await service.getCommitDetails(head);
    assert.strictEqual(
      service.containsCalls,
      before,
      'selection (details) must never run branch --contains',
    );

    const branches = await service.getContainingBranches(head);
    assert.strictEqual(service.containsCalls, before + 1);
    const current = git('rev-parse', '--abbrev-ref', 'HEAD').trim();
    assert.ok(branches.includes(current), `HEAD's branch must contain HEAD: ${branches.join(', ')}`);
  });

  test('T8: every executor run — failures included — lands in the console ring', async function () {
    this.timeout(30_000);
    // By this point in a full run the ring sits AT its cap, so size cannot
    // grow — the seq cursor is the only honest "these runs arrived" witness.
    const log = coreRef.commandLog;
    const lastSeq = log.entries()[log.size - 1]?.seq ?? 0;

    // A successful run and a failing one, both through the core executor —
    // the ring must see exactly what ran, exit codes intact.
    await coreRef.git.exec(repoRoot, ['rev-parse', '--verify', 'HEAD']);
    await coreRef.git.exec(repoRoot, ['rev-parse', '--verify', '--quiet', 'gt-definitely-missing'], {
      allowNonZeroExit: true,
    });

    const fresh = log.entriesAfter(lastSeq);
    assert.ok(fresh.length >= 2, `both runs must enter the ring (got ${fresh.length} fresh)`);
    const okRun = fresh.find(
      (e) => e.argv.join(' ') === 'rev-parse --verify HEAD' && e.exitCode === 0,
    );
    assert.ok(okRun, 'successful run recorded with exit 0');
    const failRun = fresh.find((e) => e.argv.includes('gt-definitely-missing'));
    assert.ok(failRun, 'failing run recorded');
    assert.notStrictEqual(failRun.exitCode, 0, 'failure keeps its non-zero exit code');
    assert.ok(failRun.durationMs >= 0 && failRun.ts > 0, 'timing fields populated');
  });

  test('T8: the console RPC serves deltas and clear empties the ring', async function () {
    this.timeout(30_000);
    // The webview reads via log/console {afterSeq}; prove the seam end-to-end
    // through the same CommandLog instance the view handlers use.
    const log = coreRef.commandLog;
    await coreRef.git.exec(repoRoot, ['status', '--porcelain']);
    const all = log.entriesAfter(0);
    assert.ok(all.length > 0, 'ring has entries');
    const mid = all[Math.floor(all.length / 2)]!.seq;
    const delta = log.entriesAfter(mid);
    assert.ok(delta.every((e) => e.seq > mid), 'delta strictly after the cursor');

    const maxSeq = all[all.length - 1]!.seq;
    await vscode.commands.executeCommand('geet.log.console.clear');
    // Background refreshers may push a run between clear and this line —
    // "empty" means everything pre-clear is gone, not that git went quiet.
    const after = log.entriesAfter(0);
    assert.ok(
      after.every((e) => e.seq > maxSeq),
      `pre-clear entries survived the clear (size ${after.length})`,
    );
    assert.ok(after.length < 20, `ring effectively empty after clear, got ${after.length}`);
  });
});
