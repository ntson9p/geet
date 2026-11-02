import * as assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
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
import type { BranchOps } from '../../../src/branches/branchOps';
import type { NotificationsRegistry } from '../../../src/ui/notify';
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
  /** A bare repository standing in for a remote, from T7 on: nothing leaves the machine. */
  const REMOTE = 'gtporigin';
  let remoteDir: string | undefined;

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
    if (remoteDir !== undefined) {
      try {
        git(repoD, 'remote', 'remove', REMOTE);
        fs.rmSync(remoteDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      } catch {
        // T7 stopped before adding it; or Windows keeps pack files read-only and
        // the OS reclaims %TEMP%.
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

  // ---- what a branch tracks -------------------------------------------------

  /** What git says the branch tracks: `''` for nothing. */
  const trackedBy = (name: string): string =>
    git(repoD, 'for-each-ref', '--format=%(upstream:short)', `refs/heads/${name}`).trim();

  const opsOf = (): BranchOps => (core.debugRegistry.get('phase02') as { ops: BranchOps }).ops;
  const notes = (): NotificationsRegistry => core.debugRegistry.get('notifications') as NotificationsRegistry;

  /** A branch on the remote, fetched, with nothing tracking it yet. */
  const onRemote = async (name: string): Promise<string> => {
    git(repoD, 'push', REMOTE, `main:refs/heads/${name}`);
    git(repoD, 'fetch', REMOTE);
    await refresh();
    const remoteBranch = `${REMOTE}/${name}`;
    await waitFor(
      () => repoD.model.snapshot.refs.some((r) => r.type === 'remote' && r.name === remoteBranch),
      10_000,
    );
    return remoteBranch;
  };

  /** A local branch tracking `upstream`, in the snapshot as well as in git. */
  const tracking = async (name: string, upstream: string): Promise<void> => {
    git(repoD, 'branch', `--no-track`, name, 'main');
    made.push([repoD, name]);
    git(repoD, 'branch', `--set-upstream-to=${upstream}`, name);
    await refresh();
    await waitFor(
      () => repoD.model.snapshot.refs.some((r) => r.type === 'head' && r.name === name && r.upstream === upstream),
      10_000,
    );
  };

  const labelsIn = (items: readonly BranchPanelMenuItemDto[]): string[] =>
    items.flatMap((i) => (i.kind === 'item' || i.kind === 'submenu' ? [i.label] : []));

  test('T7 a new branch from a remote branch of another name tracks nothing, its first push its own', async function () {
    this.timeout(120_000);
    remoteDir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'gittree-track-')));
    const bare = path.join(remoteDir, 'remote.git').replace(/\\/g, '/');
    execFileSync('git', ['init', '--bare', bare], { cwd: remoteDir, encoding: 'utf8' });
    git(repoD, 'remote', 'add', REMOTE, bare);
    const from = await onRemote('gtp/develop');

    const kept = await panel.create({ name: 'gtp/mine', from, roots: [repoD.root], checkout: false });
    assert.deepStrictEqual(kept, { ok: true });
    made.push([repoD, 'gtp/mine']);
    assert.strictEqual(trackedBy('gtp/mine'), '', 'created, not checked out: tracks nothing');

    const out = await panel.create({ name: 'gtp/mine-co', from, roots: [repoD.root], checkout: true });
    assert.deepStrictEqual(out, { ok: true });
    made.push([repoD, 'gtp/mine-co']);
    assert.strictEqual(git(repoD, 'rev-parse', '--abbrev-ref', 'HEAD').trim(), 'gtp/mine-co');
    assert.strictEqual(trackedBy('gtp/mine-co'), '', 'checked out: tracks nothing');
    git(repoD, 'checkout', 'main');
    await refresh();
  });

  test('T8 the rule holds whatever git is configured to do', async function () {
    this.timeout(60_000);
    const from = `${REMOTE}/gtp/develop`;
    git(repoD, 'config', 'branch.autoSetupMerge', 'always');
    try {
      const result = await panel.create({ name: 'gtp/always', from, roots: [repoD.root], checkout: false });
      assert.deepStrictEqual(result, { ok: true });
      made.push([repoD, 'gtp/always']);
      assert.strictEqual(trackedBy('gtp/always'), '', 'from a remote branch');
      const fromLocal = await panel.create({ name: 'gtp/always-l', from: 'gtp/mine', roots: [repoD.root], checkout: false });
      assert.deepStrictEqual(fromLocal, { ok: true });
      made.push([repoD, 'gtp/always-l']);
      assert.strictEqual(trackedBy('gtp/always-l'), '', 'from a local branch');
    } finally {
      git(repoD, 'config', '--unset', 'branch.autoSetupMerge');
    }
    await refresh();
  });

  test('T9 a new branch taking the remote branch’s own name tracks it', async function () {
    this.timeout(60_000);
    const from = await onRemote('gtp/same');
    const result = await panel.create({ name: 'gtp/same', from, roots: [repoD.root], checkout: false });
    assert.deepStrictEqual(result, { ok: true });
    made.push([repoD, 'gtp/same']);
    assert.strictEqual(trackedBy('gtp/same'), from);
  });

  test('T10 the input-box path follows the same rule', async function () {
    this.timeout(60_000);
    await refresh();
    process.env['GITTREE_TEST_BRANCH_MODE'] = 'create';
    try {
      process.env['GITTREE_TEST_BRANCH_NAME'] = 'gtp/asked';
      await opsOf().newBranchFrom(repoD, `${REMOTE}/gtp/develop`);
      made.push([repoD, 'gtp/asked']);
      assert.strictEqual(trackedBy('gtp/asked'), '');
    } finally {
      delete process.env['GITTREE_TEST_BRANCH_NAME'];
      delete process.env['GITTREE_TEST_BRANCH_MODE'];
    }
  });

  test('T11 Stop Tracking cuts the link and nothing else, and Undo puts it back', async function () {
    this.timeout(90_000);
    const upstream = `${REMOTE}/gtp/develop`;
    await tracking('gtp/wrong', upstream);
    const target: BranchPanelTargetDto = { kind: 'local', name: 'gtp/wrong', roots: [repoD.root] };
    const offered = labelsIn(await panel.menu({ target }));
    assert.ok(offered.includes(`Stop Tracking '${upstream}'`), offered.join(' | '));
    const tip = git(repoD, 'rev-parse', 'gtp/wrong').trim();

    await panel.run({ type: 'action', target, action: 'stopTracking' });
    assert.strictEqual(trackedBy('gtp/wrong'), '', 'git no longer has it tracking');
    assert.ok(
      !repoD.model.snapshot.refs.some((r) => r.name === 'gtp/wrong' && r.upstream !== undefined),
      'the panel knows without waiting',
    );
    assert.strictEqual(git(repoD, 'rev-parse', 'gtp/wrong').trim(), tip, 'the branch is where it was');
    assert.ok(
      git(repoD, 'rev-parse', '--verify', upstream).trim().length > 0,
      'the remote branch is still there',
    );
    const told = notes().recent().at(-1);
    assert.strictEqual(told?.message, `Branch gtp/wrong no longer tracks ${upstream}`);
    assert.deepStrictEqual(told?.actions, ['Undo']);
    assert.ok(
      !labelsIn(await panel.menu({ target })).some((l) => l.startsWith('Stop Tracking')),
      'nothing left to stop',
    );

    await tracking('gtp/undo', upstream);
    process.env['GITTREE_TEST_NOTIFICATION_ACTION'] = 'Undo';
    try {
      await panel.run({
        type: 'action',
        target: { kind: 'local', name: 'gtp/undo', roots: [repoD.root] },
        action: 'stopTracking',
      });
      await waitFor(() => trackedBy('gtp/undo') === upstream, 10_000);
    } finally {
      delete process.env['GITTREE_TEST_NOTIFICATION_ACTION'];
    }
  });

  test('T12 a branch whose upstream the remote deleted can let go of it too, with no Undo to offer', async function () {
    this.timeout(90_000);
    const upstream = await onRemote('gtp/deleted');
    await tracking('gtp/orphan', upstream);
    git(repoD, 'update-ref', '-d', `refs/remotes/${upstream}`);
    await refresh();
    await waitFor(
      () => repoD.model.snapshot.refs.some((r) => r.name === 'gtp/orphan' && r.upstreamGone === true),
      10_000,
    );
    const target: BranchPanelTargetDto = { kind: 'local', name: 'gtp/orphan', roots: [repoD.root] };
    const offered = labelsIn(await panel.menu({ target }));
    assert.ok(offered.includes(`Stop Tracking '${upstream}'`), offered.join(' | '));
    assert.ok(!offered.includes('Update'), 'nothing to update from');

    await panel.run({ type: 'action', target, action: 'stopTracking' });
    assert.strictEqual(trackedBy('gtp/orphan'), '');
    assert.deepStrictEqual(notes().recent().at(-1)?.actions, [], 'the remote branch cannot be tracked again');
  });

  test('T13 a branch several repositories have stops tracking where it tracks something', async function () {
    this.timeout(90_000);
    const upstream = `${REMOTE}/gtp/develop`;
    await tracking('gtp/both', upstream);
    git(repoE, 'branch', '--no-track', 'gtp/both', 'main');
    made.push([repoE, 'gtp/both']);
    await refresh();
    const target: BranchPanelTargetDto = { kind: 'local', name: 'gtp/both', roots: [repoD.root, repoE.root] };
    const offered = labelsIn(await panel.menu({ target }));
    assert.ok(offered.includes('Stop tracking in 1 of 2 repositories'), offered.join(' | '));
    await panel.run({ type: 'action', target, action: 'stopTracking' });
    assert.strictEqual(trackedBy('gtp/both'), '');
    assert.ok(has(repoE, 'gtp/both'), 'the repository with nothing to stop was left alone');
  });

  test('T14 a rename never offers to delete a remote branch of another name', async function () {
    this.timeout(90_000);
    const other = `${REMOTE}/gtp/develop`;
    await tracking('gtp/renamed-a', other);
    process.env['GITTREE_TEST_BRANCH_NAME'] = 'gtp/renamed-b';
    try {
      await opsOf().renameBranch(repoD, 'gtp/renamed-a');
    } finally {
      delete process.env['GITTREE_TEST_BRANCH_NAME'];
    }
    made.push([repoD, 'gtp/renamed-b']);
    const told = notes().recent().at(-1);
    assert.strictEqual(told?.message, `Branch gtp/renamed-a was renamed to gtp/renamed-b. It still tracks ${other}.`);
    assert.deepStrictEqual(told?.actions, [`Stop Tracking ${other}`], 'develop is not this branch to delete');

    // Its own name on the remote: moving it there is on offer, and is what the button says.
    const own = await onRemote('gtp/renamed-c');
    await tracking('gtp/renamed-c', own);
    process.env['GITTREE_TEST_BRANCH_NAME'] = 'gtp/renamed-d';
    process.env['GITTREE_TEST_NOTIFICATION_ACTION'] = `Stop Tracking ${own}`;
    try {
      await opsOf().renameBranch(repoD, 'gtp/renamed-c');
      await waitFor(() => trackedBy('gtp/renamed-d') === '', 10_000);
    } finally {
      delete process.env['GITTREE_TEST_BRANCH_NAME'];
      delete process.env['GITTREE_TEST_NOTIFICATION_ACTION'];
    }
    made.push([repoD, 'gtp/renamed-d']);
    const offered = notes()
      .recent()
      .find((n) => n.message.startsWith('Branch gtp/renamed-c was renamed'));
    assert.deepStrictEqual(offered?.actions, [
      'Push "gtp/renamed-d" and delete "gtp/renamed-c" on the remote',
      `Stop Tracking ${own}`,
    ]);
    git(repoD, 'rev-parse', '--verify', own);
  });

  test('T15 Clean Up’s Restore brings a branch back tracking what it tracked', async function () {
    this.timeout(90_000);
    const upstream = `${REMOTE}/gtp/develop`;
    await tracking('gtp/tidied', upstream);
    const savedCleanup = process.env['GITTREE_TEST_CLEANUP'];
    process.env['GITTREE_TEST_CLEANUP'] = 'names:gtp/tidied';
    process.env['GITTREE_TEST_NOTIFICATION_ACTION'] = 'Restore';
    try {
      await vscode.commands.executeCommand('gittree.branches.cleanup', repoD.root);
      await waitFor(() => trackedBy('gtp/tidied') === upstream, 10_000);
    } finally {
      delete process.env['GITTREE_TEST_NOTIFICATION_ACTION'];
      if (savedCleanup === undefined) delete process.env['GITTREE_TEST_CLEANUP'];
      else process.env['GITTREE_TEST_CLEANUP'] = savedCleanup;
    }
  });

  test('T16 a panel action that fails is reported, not thrown at the webview', async function () {
    this.timeout(60_000);
    const upstream = `${REMOTE}/gtp/develop`;
    await tracking('gtp/raced', upstream);
    // Behind the panel's back and with no await after it, so the snapshot still
    // says tracked and git refuses: `branch 'x' has no upstream information`.
    git(repoD, 'branch', '--unset-upstream', 'gtp/raced');
    await panel.run({
      type: 'action',
      target: { kind: 'local', name: 'gtp/raced', roots: [repoD.root] },
      action: 'stopTracking',
    });
    await refresh();
    assert.strictEqual(trackedBy('gtp/raced'), '');
  });

  test('T17 a right-click on the opt-in Branches tree reaches the branch', async function () {
    this.timeout(60_000);
    await tracking('gtp/tree-row', `${REMOTE}/gtp/develop`);
    // What `gittree.branchesTree` hands its menu: a `TreeRow`, not a `BranchNode`.
    await vscode.commands.executeCommand('gittree.branch.stopTracking', {
      kind: 'ref',
      repoRoot: repoD.root,
      ref: repoD.model.snapshot.refs.find((r) => r.type === 'head' && r.name === 'gtp/tree-row'),
    });
    assert.strictEqual(trackedBy('gtp/tree-row'), '');
  });
});
