import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { RepoHandle } from '../../../src/core/core';
import { canonicalKey } from '../../../src/core/repoDiscovery';
import type { Phase02Registry } from '../../../src/branches/register';
import type { Phase04Registry } from '../../../src/log/register';
import { LOG_METHODS } from '../../../src/shared/protocol';
import { activateGitTree, gitWithRetry, waitFor, workspaceRepoC } from '../setup';

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

  suiteSetup(async function () {
    this.timeout(60_000);
    repoRoot = workspaceRepoC();
    const core = await activateGitTree();
    reg = core.debugRegistry.get('phase04') as Phase04Registry;
    p2 = core.debugRegistry.get('phase02') as Phase02Registry;
    repo = core.repoForPath(repoRoot)!;
    assert.ok(reg && p2 && repo, 'registries missing');
  });

  test('T1: every webview→host log method has a host handler', async function () {
    this.timeout(30_000);
    await vscode.commands.executeCommand('gittree.log.focus');
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
    await vscode.commands.executeCommand('gittree.log.branch.checkout', {
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
    // The log session follows the active editor's repo; anchor it to repoC the
    // way a user working in this repo would be.
    write('p12/anchor.txt', 'anchor\n');
    await vscode.window.showTextDocument(
      await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(repoRoot, 'p12/anchor.txt'))),
    );
    await reg.logView.setFilter({ sort: 'topo', refs: ['feature/f2'] });
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

    await reg.logView.setFilter({ sort: 'topo', refs: 'HEAD' });
    await waitFor(() => (reg.logView.currentSession?.rowCount ?? 0) > 0, 30_000);
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    fs.rmSync(path.join(repoRoot, 'p12/anchor.txt'), { force: true });
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

  test('T3: the 3-commit aggregate matches git diff, and a root commit falls back to the empty tree', async function () {
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

    const service = reg.logView.logServiceFor(repo);
    const aggregate = await service.getAggregateFiles(c1, c3);
    const expected = git('diff', '--name-status', `${c1}^..${c3}`)
      .trim()
      .split('\n')
      .filter((l) => l.length > 0)
      .map((l) => l.split('\t')[1]!)
      .sort();
    assert.deepStrictEqual(
      aggregate.files.map((f) => f.path).sort(),
      expected,
      'the aggregate must be exactly `git diff <oldest>^..<newest>`',
    );

    // Root commit: no parent — the empty tree stands in.
    const root = git('rev-list', '--max-parents=0', 'HEAD').trim().split('\n')[0]!;
    const rootAgg = await service.getAggregateFiles(root, root);
    assert.strictEqual(rootAgg.base, '4b825dc642cb6eb9a060e54bf8d69288fbee4904');
    assert.ok(rootAgg.files.length > 0, 'the root commit introduces its own files');
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
});
