import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { PANEL_COMMANDS } from '../../../src/branches/panelActions';
import type { Core, RepoHandle } from '../../../src/core/core';
import { canonicalKey } from '../../../src/core/repoDiscovery';
import type {
  BranchPanelCreateDto,
  BranchPanelCreateResultDto,
  BranchPanelDetailsDto,
  BranchPanelMenuItemDto,
  BranchPanelRunDto,
  BranchPanelStateDto,
  BranchPanelTargetDto,
} from '../../../src/shared/protocol';
import { activateGitTree, gitWithRetry, waitFor, workspaceRepoD, workspaceRepoE } from '../setup';

/**
 * new-way-4 — the Branches panel's host, against two real repositories
 * (repoD and repoE, which start on `main` with one commit each). The webview
 * is covered by `webview-ui/tests/branches.spec.ts`; this is what it talks to.
 *
 * Every branch made here is deleted afterwards, and repoD's `main` is put back
 * where it was, so the suites after this one find the repositories as the
 * runner made them.
 */
suite('new-way-4 Branches panel', () => {
  interface PanelShape {
    buildState(): Promise<BranchPanelStateDto>;
    details(target: BranchPanelTargetDto): Promise<BranchPanelDetailsDto>;
    menu(of: { target: BranchPanelTargetDto } | { root: string }): Promise<BranchPanelMenuItemDto[]>;
    create(request: BranchPanelCreateDto): Promise<BranchPanelCreateResultDto>;
    run(run: BranchPanelRunDto): Promise<void>;
  }

  let core: Core;
  let panel: PanelShape;
  let repoD: RepoHandle;
  let repoE: RepoHandle;
  let mainD: string;
  const made: Array<[RepoHandle, string]> = [];

  const git = (repo: RepoHandle, ...args: string[]): string => gitWithRetry(repo.root, args);
  const refresh = async (): Promise<void> => {
    await Promise.all([repoD.refresher.refreshNow(), repoE.refresher.refreshNow()]);
  };
  const has = (repo: RepoHandle, name: string): boolean =>
    repo.model.snapshot.refs.some((r) => r.type === 'head' && r.name === name);
  const dtoOf = (state: BranchPanelStateDto, repo: RepoHandle) =>
    state.repos.find((r) => canonicalKey(r.root) === canonicalKey(repo.root));

  suiteSetup(async function () {
    this.timeout(60_000);
    core = await activateGitTree();
    panel = (core.debugRegistry.get('phase02') as { panel: PanelShape }).panel;
    assert.ok(panel, 'phase02 registry exposes the Branches panel');
    repoD = core.repoForPath(workspaceRepoD())!;
    repoE = core.repoForPath(workspaceRepoE())!;
    assert.ok(repoD && repoE, 'repoD and repoE discovered');
    mainD = git(repoD, 'rev-parse', 'main').trim();
  });

  suiteTeardown(async function () {
    this.timeout(60_000);
    for (const repo of [repoD, repoE]) git(repo, 'checkout', 'main');
    git(repoD, 'reset', '--hard', mainD);
    for (const [repo, name] of made) {
      try {
        git(repo, 'branch', '-D', name);
      } catch {
        // Clean Up deleted it already.
      }
    }
    await refresh();
  });

  test('T1 the state names every repository and what it has checked out', async () => {
    const state = await panel.buildState();
    assert.strictEqual(state.repos.length, core.repos.length, 'one entry per repository');
    const labels = state.repos.map((r) => r.label);
    assert.deepStrictEqual(labels, [...labels].sort((a, b) => a.localeCompare(b)), 'in the order the user reads');
    const d = dtoOf(state, repoD);
    assert.ok(d, 'repoD is there');
    assert.strictEqual(d.head, 'main');
    assert.ok(d.locals.some((l) => l.name === 'main' && l.current === true), 'main is ticked');
    assert.ok(d.colorIdx >= 0 && d.colorIdx < 12, 'a palette slot');
    assert.strictEqual(d.mainBranch, 'main', 'no remote: the local main is what merged means');
  });

  test('T2 New Branch makes it in every repository chosen, and refuses what would fail', async function () {
    this.timeout(60_000);
    const roots = [repoD.root, repoE.root];
    const ok = await panel.create({ name: 'gtp/shared', from: 'HEAD', roots, checkout: false });
    assert.deepStrictEqual(ok, { ok: true });
    made.push([repoD, 'gtp/shared'], [repoE, 'gtp/shared']);
    await refresh();
    assert.ok(has(repoD, 'gtp/shared') && has(repoE, 'gtp/shared'), 'in both');
    assert.strictEqual(repoD.model.snapshot.headRef, 'main', 'not checked out: the box was unticked');

    const taken = await panel.create({ name: 'gtp/shared', from: 'HEAD', roots, checkout: false });
    assert.strictEqual(taken.ok, false);
    assert.match(taken.error ?? '', /already has a branch named/u);

    const bad = await panel.create({ name: 'bad name', from: 'HEAD', roots, checkout: false });
    assert.strictEqual(bad.ok, false);
    assert.match(bad.error ?? '', /not a valid branch name/u);

    const nowhere = await panel.create({ name: 'gtp/x', from: 'no-such-ref', roots, checkout: false });
    assert.strictEqual(nowhere.ok, false);
    assert.match(nowhere.error ?? '', /nothing called “no-such-ref”/u);
    await refresh();
    assert.ok(!has(repoD, 'gtp/x') && !has(repoE, 'gtp/x'), 'a refusal changes nothing anywhere');
  });

  test('T3 a branch both have: its menu acts in both, and offers each its own', async () => {
    const target: BranchPanelTargetDto = { kind: 'local', name: 'gtp/shared', roots: [repoD.root, repoE.root] };
    const items = await panel.menu({ target });
    const labels = items.flatMap((i) => (i.kind === 'item' || i.kind === 'submenu' ? [i.label] : []));
    assert.ok(labels.includes('Checkout in all 2 repositories'), labels.join(' | '));
    assert.ok(items.some((i) => i.kind === 'header' && i.label === 'In one repository'));
    const subs = items.filter((i) => i.kind === 'submenu');
    assert.strictEqual(subs.length, 2, 'a submenu per repository');
    const first = subs[0];
    assert.ok(first?.kind === 'submenu');
    const checkout = first.items.find((i) => i.kind === 'item' && i.label === 'Checkout');
    assert.ok(checkout?.kind === 'item' && checkout.run.type === 'action' && checkout.run.root !== undefined,
      "a repository's own entry runs in that repository alone");

    const details = await panel.details(target);
    assert.strictEqual(details.repos.length, 2);
    assert.strictEqual(details.buttons[0]?.label, 'Checkout in 2');

    const repoMenu = await panel.menu({ root: repoD.root });
    assert.ok(
      repoMenu.some((i) => i.kind === 'item' && i.run.type === 'command' && i.run.command === 'gittree.fetch'),
      'a repository has its own menu',
    );
  });

  test('T4 Checkout runs in both repositories, and back again, from the runs the panel sends', async function () {
    this.timeout(60_000);
    const both = [repoD.root, repoE.root];
    await panel.run({ type: 'action', target: { kind: 'local', name: 'gtp/shared', roots: both }, action: 'checkout' });
    await refresh();
    await waitFor(
      () => repoD.model.snapshot.headRef === 'gtp/shared' && repoE.model.snapshot.headRef === 'gtp/shared',
      10_000,
    );
    await panel.run({ type: 'action', target: { kind: 'local', name: 'main', roots: both }, action: 'checkout' });
    await refresh();
    await waitFor(
      () => repoD.model.snapshot.headRef === 'main' && repoE.model.snapshot.headRef === 'main',
      10_000,
    );
  });

  test('T4b a command the panel does not offer is never run, whatever the webview sends', () => {
    // Asserted on the allowlist itself: proving it by sending one would run it if it failed.
    assert.ok(PANEL_COMMANDS.has('gittree.fetch'));
    assert.ok(PANEL_COMMANDS.has('gittree.rebase.continue'));
    assert.ok(!PANEL_COMMANDS.has('workbench.action.closeWindow'));
    assert.ok(!PANEL_COMMANDS.has('gittree.discardAll'));
  });

  test("T5 a card says how a branch stands against what is checked out, and who made it", async function () {
    this.timeout(60_000);
    git(repoD, 'checkout', '-b', 'gtp/ahead');
    made.push([repoD, 'gtp/ahead']);
    fs.writeFileSync(path.join(repoD.root, 'ahead.txt'), 'ahead\n');
    git(repoD, 'add', 'ahead.txt');
    git(repoD, 'commit', '-m', 'ahead of main');
    git(repoD, 'checkout', 'main');
    await refresh();

    const details = await panel.details({ kind: 'local', name: 'gtp/ahead', roots: [repoD.root] });
    const d = details.repos[0];
    assert.ok(d, 'one repository');
    assert.deepStrictEqual(d.vsHead, { head: 'main', ahead: 1, behind: 0 });
    assert.ok((d.author ?? '').length > 0, 'the author');
    assert.strictEqual(typeof d.date, 'number');
    assert.deepStrictEqual(
      details.buttons.map((b) => b.label),
      ['Checkout', 'Merge into main'],
      'a branch with work main lacks: Checkout, and Merge',
    );
  });

  test('T6 a merged branch is marked, offered by Clean Up, and deleted', async function () {
    this.timeout(60_000);
    git(repoD, 'merge', '--no-ff', '-m', 'merge gtp/ahead', 'gtp/ahead');
    await refresh();
    const d = dtoOf(await panel.buildState(), repoD);
    assert.ok(d?.merged.includes('gtp/ahead'), `merged: ${JSON.stringify(d?.merged)}`);

    const details = await panel.details({ kind: 'local', name: 'gtp/ahead', roots: [repoD.root] });
    assert.deepStrictEqual(
      details.buttons.map((b) => b.label),
      ['Checkout', 'Delete'],
      'a finished branch: Delete takes Merge’s place',
    );

    const saved = process.env['GITTREE_TEST_CLEANUP'];
    // By name: other suites' branches in repoD are not this test's to delete.
    process.env['GITTREE_TEST_CLEANUP'] = 'names:gtp/ahead';
    try {
      await vscode.commands.executeCommand('gittree.branches.cleanup', repoD.root);
    } finally {
      if (saved === undefined) delete process.env['GITTREE_TEST_CLEANUP'];
      else process.env['GITTREE_TEST_CLEANUP'] = saved;
    }
    await refresh();
    assert.ok(!has(repoD, 'gtp/ahead'), 'the merged branch is gone');
    assert.ok(has(repoD, 'gtp/shared'), 'what was not picked stays');
    assert.ok(has(repoE, 'gtp/shared'), 'another repository was not touched');
    assert.strictEqual(repoD.model.snapshot.headRef, 'main', 'the checked-out branch is never offered');
  });
});
