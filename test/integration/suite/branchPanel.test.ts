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
import type { Phase04Registry } from '../../../src/log/register';
import type { NotificationsRegistry } from '../../../src/ui/notify';
import { repoLabels } from '../../../src/core/util/repoLabels';
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
    details(target: BranchPanelTargetDto, scope?: readonly string[]): Promise<BranchPanelDetailsDto>;
    menu(
      of: { target: BranchPanelTargetDto; scope?: readonly string[] } | { root: string },
    ): Promise<BranchPanelMenuItemDto[]>;
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
    const header = items.findIndex((i) => i.kind === 'header' && i.label === 'In one repository');
    assert.ok(header > 0);
    const subs = items.slice(header + 1).filter((i) => i.kind === 'submenu');
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

  // ---- POST-P14ax · one branch in every repository ---------------------------

  /** repoE gets a remote of its own, beside repoD's: nothing leaves the machine. */
  const REMOTE_E = 'gtporigin-e';
  const withRemoteE = async <T>(body: () => Promise<T>): Promise<T> => {
    assert.ok(remoteDir !== undefined, 'T7 made the remotes directory');
    const bare = path.join(remoteDir, 'remote-e.git').replace(/\\/g, '/');
    if (!fs.existsSync(bare)) execFileSync('git', ['init', '--bare', bare], { cwd: remoteDir, encoding: 'utf8' });
    git(repoE, 'remote', 'add', REMOTE_E, bare);
    try {
      return await body();
    } finally {
      for (const repo of [repoD, repoE]) {
        try {
          git(repo, 'reset', '-q', '--hard');
          git(repo, 'checkout', '-q', 'main');
        } catch {
          /* left as it was */
        }
      }
      git(repoE, 'remote', 'remove', REMOTE_E);
      await refresh();
    }
  };
  /** `name` on each repository's remote, and in repoD as a local branch too. */
  const acrossBranch = async (name: string, change?: { file: string; content: string }): Promise<void> => {
    for (const [repo, remote] of [
      [repoD, REMOTE],
      [repoE, REMOTE_E],
    ] as const) {
      git(repo, 'checkout', '-q', '-b', name, 'main');
      if (change !== undefined) {
        fs.writeFileSync(path.join(repo.root, change.file), change.content);
        git(repo, 'add', '--', change.file);
        git(repo, '-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', `${name} change`);
      }
      git(repo, 'push', '-q', remote, `${name}:refs/heads/${name}`);
      git(repo, 'checkout', '-q', 'main');
      made.push([repo, name]);
    }
    // repoE keeps only the remote branch: a Checkout there makes it.
    git(repoE, 'branch', '-D', name);
    git(repoE, 'fetch', '-q', REMOTE_E);
    git(repoD, 'fetch', '-q', REMOTE);
    await refresh();
    await waitFor(
      () => repoE.model.snapshot.refs.some((r) => r.type === 'remote' && r.name === `${REMOTE_E}/${name}`),
      10_000,
    );
  };
  const label = (repo: RepoHandle): string => repoLabels(core.repos.map((r) => r.root)).get(repo.root) ?? '';
  const headIs = (repo: RepoHandle): string => git(repo, 'rev-parse', '--abbrev-ref', 'HEAD').trim();
  const lastQuestion = () =>
    (core.debugRegistry.get('phase02') as { lastLocalChangesQuestion: () => { message: string } | undefined })
      .lastLocalChangesQuestion();
  const withSmartChoice = async <T>(choice: string, body: () => Promise<T>): Promise<T> => {
    const saved = process.env['GITTREE_TEST_SMART_CHOICE'];
    process.env['GITTREE_TEST_SMART_CHOICE'] = choice;
    try {
      return await body();
    } finally {
      if (saved === undefined) delete process.env['GITTREE_TEST_SMART_CHOICE'];
      else process.env['GITTREE_TEST_SMART_CHOICE'] = saved;
    }
  };

  test('T18 a local branch in one repository offers Checkout in every one that has it, remote or not', async function () {
    this.timeout(120_000);
    await withRemoteE(async () => {
      await acrossBranch('gtp/across');
      const target: BranchPanelTargetDto = { kind: 'local', name: 'gtp/across', roots: [repoD.root] };
      const items = await panel.menu({ target, scope: [repoD.root, repoE.root] });
      const first = items[0];
      assert.ok(first?.kind === 'item' && first.run.type === 'checkoutAcross', JSON.stringify(first));
      assert.strictEqual(first.label, 'Checkout in all 2 repositories');
      // Without the repositories in view, it is the row's own repository's menu.
      const own = await panel.menu({ target });
      assert.ok(!labelsIn(own).some((l) => l.startsWith('Checkout in')), labelsIn(own).join(' | '));

      notes().clear();
      await panel.run(first.run);
      await refresh();
      assert.strictEqual(headIs(repoD), 'gtp/across');
      assert.strictEqual(headIs(repoE), 'gtp/across');
      assert.strictEqual(
        git(repoE, 'for-each-ref', '--format=%(upstream:short)', 'refs/heads/gtp/across').trim(),
        `${REMOTE_E}/gtp/across`,
        'made in repoE from its remote branch, and tracking it',
      );
      assert.deepStrictEqual(notes().recent().map((n) => n.message), [
        `Checked out gtp/across in ${label(repoD)} and ${label(repoE)}; in ${label(repoE)} as a new branch tracking ${REMOTE_E}/gtp/across.`,
      ]);
    });
  });

  test('T19 local changes in the way are asked about once; Cancel leaves that repository where it is', async function () {
    this.timeout(120_000);
    await withRemoteE(async () => {
      await acrossBranch('gtp/clash', { file: 'gtp-clash.txt', content: 'on the branch\n' });
      // In repoD a file of that name, not in git: the checkout would overwrite it.
      fs.writeFileSync(path.join(repoD.root, 'gtp-clash.txt'), 'mine, not committed\n');
      await refresh();
      const run: BranchPanelRunDto = {
        type: 'checkoutAcross',
        roots: [repoD.root, repoE.root],
        name: 'gtp/clash',
      };
      notes().clear();
      await withSmartChoice('cancel', () => panel.run(run));
      await refresh();
      assert.match(lastQuestion()?.message ?? '', new RegExp(`Your local changes in ${label(repoD)} would be overwritten`, 'u'));
      assert.strictEqual(headIs(repoD), 'main', 'left where it was');
      assert.strictEqual(headIs(repoE), 'gtp/clash', 'the other went on');
      assert.strictEqual(fs.readFileSync(path.join(repoD.root, 'gtp-clash.txt'), 'utf8'), 'mine, not committed\n');
      const said = notes().recent();
      assert.strictEqual(said.length, 1);
      assert.strictEqual(said[0]!.kind, 'warning');
      assert.ok(said[0]!.message.startsWith(`${label(repoD)} stays on main: your local changes to gtp-clash.txt`), said[0]!.message);
      fs.rmSync(path.join(repoD.root, 'gtp-clash.txt'));
    });
  });

  test('T20 Smart Checkout sets them aside and puts them back, in every repository it stopped', async function () {
    this.timeout(120_000);
    await withRemoteE(async () => {
      await acrossBranch('gtp/smart', { file: 'gtp-smart.txt', content: 'one\nkeep\nthree\n' });
      git(repoD, 'checkout', '-q', 'gtp/smart');
      git(repoD, 'checkout', '-q', 'main');
      // Tracked on main too, with a change of mine away from the branch's lines.
      fs.writeFileSync(path.join(repoD.root, 'gtp-smart.txt'), 'one\nkeep\nthree\n');
      git(repoD, 'add', '--', 'gtp-smart.txt');
      git(repoD, '-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'gtp smart base');
      const mainWithFile = git(repoD, 'rev-parse', 'HEAD').trim();
      git(repoD, 'checkout', '-q', 'gtp/smart');
      fs.writeFileSync(path.join(repoD.root, 'gtp-smart.txt'), 'ONE\nkeep\nthree\n');
      git(repoD, 'commit', '-q', '-a', '-m', 'gtp smart: the branch changes line one');
      git(repoD, 'checkout', '-q', 'main');
      fs.writeFileSync(path.join(repoD.root, 'gtp-smart.txt'), 'one\nkeep\nTHREE, mine\n');
      await refresh();
      try {
        await withSmartChoice('smart', () =>
          panel.run({ type: 'checkoutAcross', roots: [repoD.root, repoE.root], name: 'gtp/smart' }),
        );
        await refresh();
        assert.strictEqual(headIs(repoD), 'gtp/smart');
        assert.strictEqual(fs.readFileSync(path.join(repoD.root, 'gtp-smart.txt'), 'utf8'), 'ONE\nkeep\nTHREE, mine\n');
        assert.strictEqual(git(repoD, 'stash', 'list').trim(), '', 'nothing left behind in the stash');
      } finally {
        git(repoD, 'reset', '-q', '--hard');
        git(repoD, 'checkout', '-q', 'main');
        git(repoD, 'reset', '-q', '--hard', mainWithFile + '~1');
      }
    });
  });

  test('T21 a repository with conflicts to resolve is skipped, and the run does not wait on it', async function () {
    this.timeout(120_000);
    await withRemoteE(async () => {
      await acrossBranch('gtp/past-conflict');
      // repoE: conflicted files, and no merge behind them — what a stash that did
      // not go back cleanly leaves. The conflict lifecycle holds its mutations.
      git(repoE, 'checkout', '-q', '-b', 'gtp/side', 'main');
      fs.writeFileSync(path.join(repoE.root, 'gtp-side.txt'), 'side\n');
      git(repoE, 'add', '--', 'gtp-side.txt');
      git(repoE, '-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'side');
      made.push([repoE, 'gtp/side']);
      git(repoE, 'checkout', '-q', 'main');
      fs.writeFileSync(path.join(repoE.root, 'gtp-side.txt'), 'main\n');
      git(repoE, 'add', '--', 'gtp-side.txt');
      git(repoE, '-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'main side');
      const mainE = git(repoE, 'rev-parse', 'HEAD~1').trim();
      try {
        git(repoE, 'merge', 'gtp/side');
      } catch {
        /* the conflict this needs */
      }
      for (const f of ['MERGE_HEAD', 'MERGE_MSG', 'MERGE_MODE']) fs.rmSync(path.join(repoE.dirs.gitDir, f), { force: true });
      await refresh();
      await waitFor(() => repoE.model.snapshot.statusEntries.some((e) => e.kind === 'unmerged'), 10_000);
      try {
        notes().clear();
        await panel.run({ type: 'checkoutAcross', roots: [repoD.root, repoE.root], name: 'gtp/past-conflict' });
        await refresh();
        assert.strictEqual(headIs(repoD), 'gtp/past-conflict');
        assert.strictEqual(headIs(repoE), 'main');
        assert.match(
          notes().recent().at(-1)?.message ?? '',
          new RegExp(`Skipped ${label(repoE)} \\(it has conflicts to resolve\\)`, 'u'),
        );
      } finally {
        git(repoE, 'reset', '-q', '--hard', mainE);
      }
    });
  });

  test('T22 New Branch goes on past local changes in the way: made there, not checked out', async function () {
    this.timeout(120_000);
    await withRemoteE(async () => {
      await acrossBranch('gtp/base', { file: 'gtp-base.txt', content: 'base\n' });
      fs.writeFileSync(path.join(repoD.root, 'gtp-base.txt'), 'mine, not committed\n');
      await refresh();
      notes().clear();
      const roots = [repoD.root, repoE.root];
      // repoE has the branch only as gtporigin-e/gtp/base: the form offers what both have.
      git(repoE, 'branch', '--no-track', 'gtp/base', `${REMOTE_E}/gtp/base`);
      await refresh();
      const result = await withSmartChoice('cancel', () =>
        panel.create({ name: 'gtp/from-base', from: 'gtp/base', roots, checkout: true }),
      );
      made.push([repoD, 'gtp/from-base'], [repoE, 'gtp/from-base']);
      assert.deepStrictEqual(result, { ok: true }, 'some of it went through: the form closes');
      await refresh();
      assert.ok(has(repoD, 'gtp/from-base'), 'made in repoD all the same');
      assert.strictEqual(headIs(repoD), 'main', 'and not checked out there');
      assert.strictEqual(headIs(repoE), 'gtp/from-base');
      const said = notes().recent().at(-1);
      assert.strictEqual(said?.kind, 'warning');
      assert.ok(said?.message.includes('gtp/from-base is there, not checked out'), said?.message);
      fs.rmSync(path.join(repoD.root, 'gtp-base.txt'));
    });
  });

  // ---- Show in New Log Tab ----------------------------------------------------

  const showInLog = (repo: RepoHandle, name: string): BranchPanelRunDto => ({
    type: 'command',
    command: 'gittree.branches.showInLog',
    root: repo.root,
    arg: name,
  });

  test('T23 Show in New Log Tab sits with the ways of looking at a branch, and names each repository', async () => {
    const one = await panel.menu({ target: { kind: 'local', name: 'gtp/shared', roots: [repoD.root] } });
    const at = one.findIndex((i) => i.kind === 'item' && i.label === 'Show in New Log Tab');
    const show = one[at];
    assert.ok(show?.kind === 'item', labelsIn(one).join(' | '));
    assert.deepStrictEqual(show.run, showInLog(repoD, 'gtp/shared'));
    assert.strictEqual(labelsIn(one).filter((l) => l === 'Show in New Log Tab').length, 1, 'once');
    // After the checkout group, leading Compare with… and Show Diff with Working Tree.
    assert.strictEqual(one[at - 1]?.kind, 'separator');
    const before = one[at - 2];
    assert.ok(before?.kind === 'item' && /^(Checkout|New Branch from)/u.test(before.label), JSON.stringify(before));
    const after = one[at + 1];
    assert.ok(
      after?.kind === 'item' && /^(Compare with|Show Diff with Working Tree)/u.test(after.label),
      JSON.stringify(after),
    );

    // A remote branch has it too, and shows the remote branch.
    const remoteBranch = `${REMOTE}/gtp/develop`;
    const remote = await panel.menu({ target: { kind: 'remote', name: remoteBranch, roots: [repoD.root] } });
    const remoteItem = remote.find((i) => i.kind === 'item' && i.label === 'Show in New Log Tab');
    assert.ok(remoteItem?.kind === 'item', labelsIn(remote).join(' | '));
    assert.deepStrictEqual(remoteItem.run, showInLog(repoD, remoteBranch));

    // A branch both have: the Log draws one repository at a time, so it asks which.
    const both = await panel.menu({
      target: { kind: 'local', name: 'gtp/shared', roots: [repoD.root, repoE.root] },
    });
    const sub = both.find((i) => i.kind === 'submenu' && i.label === 'Show in New Log Tab');
    assert.ok(sub?.kind === 'submenu', labelsIn(both).join(' | '));
    const labels = repoLabels(core.repos.map((r) => r.root));
    assert.deepStrictEqual(
      sub.items.map((i) => (i.kind === 'item' ? { label: i.label, run: i.run } : i.kind)),
      [repoD, repoE].map((repo) => ({ label: labels.get(repo.root), run: showInLog(repo, 'gtp/shared') })),
    );
    // After what runs in all of them, before each repository's own menu.
    const header = both.findIndex((i) => i.kind === 'header' && i.label === 'In one repository');
    const where = both.indexOf(sub);
    assert.ok(where > 0 && where < header, labelsIn(both).join(' | '));
  });

  test('T24 Show in New Log Tab opens that repository’s branch in a Log tab of its own, once', async function () {
    this.timeout(120_000);
    const log = (core.debugRegistry.get('phase04') as Phase04Registry).logView;
    await vscode.commands.executeCommand('gittree.log.focus');
    await waitFor(() => log.currentSession !== undefined, 30_000);
    const before = log.logTabs.tabs;
    const inFront = log.logTabs.active;
    const labels = repoLabels(core.repos.map((r) => r.root));
    const opened: string[] = [];
    try {
      await panel.run(showInLog(repoE, 'gtp/shared'));
      const tabE = log.logTabs.active;
      assert.ok(!before.includes(tabE), 'a tab of its own: the one in front keeps its filter');
      opened.push(tabE);
      await waitFor(() => log.currentSession?.logTab === tabE, 30_000);
      assert.strictEqual(canonicalKey(log.currentSession!.repoRoot), canonicalKey(repoE.root));
      assert.deepStrictEqual(log.currentSession!.filter.refs, ['gtp/shared']);
      await waitFor(() => (log.currentSession?.rowCount ?? 0) > 0, 30_000);
      // The strip can say which repository it shows: there are several.
      assert.strictEqual(log.logTabs.repos[tabE], labels.get(repoE.root));

      // Asked again, that tab comes forward: no second one.
      await panel.run(showInLog(repoE, 'gtp/shared'));
      assert.strictEqual(log.logTabs.active, tabE);
      assert.strictEqual(log.logTabs.tabs.length, before.length + 1);

      // The same branch in the other repository is a tab of its own.
      await panel.run(showInLog(repoD, 'gtp/shared'));
      const tabD = log.logTabs.active;
      assert.notStrictEqual(tabD, tabE);
      opened.push(tabD);
      await waitFor(() => log.currentSession?.logTab === tabD, 30_000);
      assert.strictEqual(canonicalKey(log.currentSession!.repoRoot), canonicalKey(repoD.root));
      assert.strictEqual(log.logTabs.repos[tabD], labels.get(repoD.root));
    } finally {
      log.closeLogTabs(opened);
      log.showLogTab(inFront);
    }
    assert.deepStrictEqual(log.logTabs.tabs, before, 'the Log is left as it was found');
    assert.strictEqual(log.logTabs.active, inFront);
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
