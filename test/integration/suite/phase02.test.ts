import * as assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { BranchOps } from '../../../src/branches/branchOps';
import type { BranchesViewProvider, BranchNode } from '../../../src/branches/branchesView';
import type { CompareService } from '../../../src/branches/compare';
import type { RefService } from '../../../src/branches/refService';
import { buildPopupItems } from '../../../src/branches/branchesPopup';
import { canonicalKey } from '../../../src/core/repoDiscovery';
import type { RepoHandle } from '../../../src/core/core';
import { activateGitTree, gitWithRetry, waitFor, workspaceRepoB } from '../setup';

interface Phase02RegistryShape {
  refServices: Map<string, RefService>;
  ops: BranchOps;
  viewProvider: BranchesViewProvider;
  compare: CompareService;
}

/** Phase 2 acceptance on workspace repoB (repoA belongs to the P1 suite). */
suite('P2 branches', () => {
  let repoRoot: string;
  let repo: RepoHandle;
  let reg: Phase02RegistryShape;

  const git = (...args: string[]): string => gitWithRetry(repoRoot, args);
  const write = (rel: string, content: string): void =>
    fs.writeFileSync(path.join(repoRoot, rel), content);

  async function refresh(): Promise<void> {
    await repo.refresher.refreshNow();
  }

  suiteSetup(async function () {
    this.timeout(60_000);
    repoRoot = workspaceRepoB();
    const core = await activateGitTree();
    repo = core.repoForPath(repoRoot)!;
    assert.ok(repo, 'repoB not discovered');
    reg = core.debugRegistry.get('phase02') as Phase02RegistryShape;
    assert.ok(reg, 'phase02 registry missing');
  });

  function refService(): RefService {
    const s = reg.refServices.get(canonicalKey(repoRoot));
    assert.ok(s, 'RefService missing for repoB');
    return s;
  }

  test('T1: recent branches from real reflog traffic + favorites persist', async function () {
    this.timeout(60_000);
    git('checkout', '-b', 'feature/one');
    git('checkout', '-b', 'feature/two');
    git('checkout', 'feature/one');
    git('checkout', 'main');
    await refresh();

    const recent = await refService().getRecentBranches();
    assert.ok(recent.includes('feature/one'), `recent: ${recent.join(', ')}`);
    assert.ok(!recent.includes('main'), 'current branch must be excluded');

    const nowFav = await refService().toggleFavorite('feature/one');
    assert.strictEqual(nowFav, true);
    assert.ok((await refService().getFavorites()).has('feature/one'));
    await refService().toggleFavorite('feature/one');
    assert.ok(!(await refService().getFavorites()).has('feature/one'));
  });

  test('T2: popup items build sections correctly and fast on 500 branches', async function () {
    this.timeout(120_000);
    // 500 refs in one git process via update-ref --stdin.
    const head = git('rev-parse', 'HEAD').trim();
    const stdin =
      Array.from({ length: 500 }, (_, i) => `create refs/heads/bulk/b${i} ${head}`).join('\n') + '\n';
    execFileSync('git', ['update-ref', '--stdin'], { cwd: repoRoot, input: stdin });
    await refresh();
    await waitFor(() => repo.model.snapshot.refs.filter((r) => r.type === 'head').length >= 500, 15_000);

    const service = refService();
    await service.toggleFavorite('feature/two');

    const t0 = Date.now();
    const items = buildPopupItems({
      current: service.currentBranch,
      locals: service.localBranches,
      remotes: service.remoteBranches,
      // P13-T5 widened the input: tags, the drill-in prefix, the flat-search
      // mode and the incoming/outgoing toggle. Top level, not filtering.
      tags: [],
      recent: ['feature/one'],
      favorites: await service.getFavorites(),
      prefix: '',
      filtering: false,
      showInOut: false,
    });
    const elapsed = Date.now() - t0;
    assert.ok(elapsed < 150, `buildPopupItems took ${elapsed}ms (budget 150)`);

    const labels = items.map((i) => i.label);
    assert.ok(labels.some((l) => l.includes('$(check)')), 'current section missing');
    assert.ok(labels.some((l) => l.includes('$(star-full) feature/two')), 'favorites section missing');
    assert.ok(labels.some((l) => l.includes('$(history) feature/one')), 'recent section missing');
    // Separators present for sections.
    const seps = items.filter((i) => i.kind === vscode.QuickPickItemKind.Separator).map((i) => i.label);
    assert.ok(seps.includes('Current') && seps.includes('Local'), `separators: ${seps.join(',')}`);

    // Cleanup bulk refs.
    const del =
      Array.from({ length: 500 }, (_, i) => `delete refs/heads/bulk/b${i}`).join('\n') + '\n';
    execFileSync('git', ['update-ref', '--stdin'], { cwd: repoRoot, input: del });
    await service.toggleFavorite('feature/two');
    await refresh();
  });

  test('T3: new branch / rename / delete / force-delete flows', async function () {
    this.timeout(60_000);
    // New branch (input via test seam), created without checkout.
    process.env['GITTREE_TEST_BRANCH_NAME'] = 'ops/created';
    process.env['GITTREE_TEST_BRANCH_MODE'] = 'create';
    try {
      await reg.ops.newBranchFrom(repo, 'HEAD');
    } finally {
      delete process.env['GITTREE_TEST_BRANCH_NAME'];
      delete process.env['GITTREE_TEST_BRANCH_MODE'];
    }
    assert.ok(git('branch', '--list', 'ops/created').includes('ops/created'));

    // Rename.
    process.env['GITTREE_TEST_BRANCH_NAME'] = 'ops/renamed';
    try {
      await reg.ops.renameBranch(repo, 'ops/created');
    } finally {
      delete process.env['GITTREE_TEST_BRANCH_NAME'];
    }
    assert.ok(git('branch', '--list', 'ops/renamed').includes('ops/renamed'));
    assert.strictEqual(git('branch', '--list', 'ops/created').trim(), '');

    // Plain delete (merged → -d succeeds).
    await refresh();
    await reg.ops.deleteBranch(repo, 'ops/renamed');
    assert.strictEqual(git('branch', '--list', 'ops/renamed').trim(), '');

    // Force delete: branch with unmerged commit → -d fails → modal (auto-yes) → -D.
    git('checkout', '-b', 'ops/unmerged');
    write('unmerged.txt', 'x\n');
    git('add', '.');
    git('commit', '-m', 'unmerged work');
    git('checkout', 'main');
    await refresh();
    await reg.ops.deleteBranch(repo, 'ops/unmerged');
    assert.strictEqual(git('branch', '--list', 'ops/unmerged').trim(), '');
  });

  test('T4: smart checkout stashes, switches and restores', async function () {
    this.timeout(60_000);
    // Branch that changes tracked.txt; dirty edit of the same file on main.
    write('tracked.txt', 'base\n');
    git('add', '.');
    git('commit', '-m', 'tracked base');
    git('checkout', '-b', 'smart/target');
    write('tracked.txt', 'target version\n');
    git('commit', '-am', 'target change');
    git('checkout', 'main');
    write('tracked.txt', 'dirty local edit\n'); // blocks checkout
    await refresh();

    process.env['GITTREE_TEST_SMART_CHOICE'] = 'smart';
    try {
      await reg.ops.checkout(repo, 'smart/target');
    } finally {
      delete process.env['GITTREE_TEST_SMART_CHOICE'];
    }
    await refresh();
    await waitFor(() => repo.model.snapshot.headRef === 'smart/target', 15_000);
    // Pop conflicts (dirty edit vs target version) keep the stash + unmerged file.
    const stashes = git('stash', 'list');
    const conflicted = git('status', '--porcelain').includes('UU tracked.txt');
    if (conflicted) {
      assert.ok(stashes.includes('gittree-smart:smart/target'), 'conflicting pop must keep the stash');
      git('checkout', '--theirs', 'tracked.txt');
      git('add', 'tracked.txt');
      git('reset');
      git('checkout', '-f', 'smart/target');
      git('stash', 'drop');
    } else {
      // Clean pop: change restored on target, stash gone.
      assert.strictEqual(fs.readFileSync(path.join(repoRoot, 'tracked.txt'), 'utf8'), 'dirty local edit\n');
      assert.ok(!stashes.includes('gittree-smart:smart/target'));
      git('checkout', '-f', 'smart/target');
    }
    git('checkout', '-f', 'main');
    await refresh();
  });

  test('T4: force checkout discards but snapshots first', async function () {
    this.timeout(60_000);
    const core = await activateGitTree();
    write('tracked.txt', 'will be discarded\n');
    await refresh();
    await waitFor(() => repo.model.snapshot.statusEntries.some((e) => e.path === 'tracked.txt'), 15_000);

    process.env['GITTREE_TEST_SMART_CHOICE'] = 'force';
    try {
      await reg.ops.checkout(repo, 'smart/target');
    } finally {
      delete process.env['GITTREE_TEST_SMART_CHOICE'];
    }
    await refresh();
    await waitFor(() => repo.model.snapshot.headRef === 'smart/target', 15_000);
    assert.strictEqual(
      fs.readFileSync(path.join(repoRoot, 'tracked.txt'), 'utf8'),
      'target version\n',
    );
    // P9 snapshot captured the discarded content.
    const p9 = core.debugRegistry.get('phase09') as {
      getStore(root: string): { list(): { label: string; id: string }[]; read(id: string, rel: string): Buffer | undefined } | undefined;
    };
    const store = p9.getStore(repoRoot);
    assert.ok(store, 'snapshot store missing for repoB');
    const snap = store.list().find((m) => m.label === 'Before: force checkout');
    assert.ok(snap, 'force checkout snapshot missing');
    assert.strictEqual(store.read(snap.id, 'tracked.txt')?.toString(), 'will be discarded\n');
    git('checkout', '-f', 'main');
    await refresh();
  });

  test('T5: compare with current shows left/right commits and file diff opens', async function () {
    this.timeout(60_000);
    // smart/target has 1 commit not on main; give main one of its own.
    write('main-only.txt', 'm\n');
    git('add', '.');
    git('commit', '-m', 'main only');
    await refresh();

    await vscode.commands.executeCommand('gittree.branches.compareWithCurrent', repoRoot, 'smart/target');
    const state = reg.compare.provider.state;
    assert.ok(state, 'compare state not set');
    assert.strictEqual(state.branch, 'smart/target');
    const left = state.commits.filter((c) => c.side === 'left');
    const right = state.commits.filter((c) => c.side === 'right');
    assert.ok(left.some((c) => c.subject === 'target change'), 'left commits missing');
    assert.ok(right.some((c) => c.subject === 'main only'), 'right commits missing');

    await vscode.commands.executeCommand('gittree.compare.showFileDiff');
    // The multi-diff editor opened as a tab.
    const tabs = vscode.window.tabGroups.all.flatMap((g) => g.tabs);
    assert.ok(
      tabs.some((t) => t.label.includes('smart/target')),
      `no compare tab: ${tabs.map((t) => t.label).join(' | ')}`,
    );
  });

  test('T6: branches view exposes sections, context values and drag-merge', async function () {
    this.timeout(60_000);
    // Multi-root workspace: root level lists repos; descend into repoB.
    const rootNodes = await reg.viewProvider.getChildren();
    const repoNode = rootNodes.find(
      (n) => n.kind === 'repo' && canonicalKey(n.repo.root) === canonicalKey(repoRoot),
    );
    assert.ok(repoNode, `repo nodes: ${rootNodes.map((n) => n.kind).join(',')}`);
    const sections = await reg.viewProvider.getChildren(repoNode);
    const local = sections.find((n) => n.kind === 'section' && n.section === 'local');
    assert.ok(local, `sections: ${sections.map((n) => n.kind).join(',')}`);
    const branches = (await reg.viewProvider.getChildren(local)) as Extract<
      BranchNode,
      { kind: 'branch' }
    >[];
    const current = branches.find((b) => b.ref.isHead);
    assert.ok(current, 'current branch node missing');
    const item = reg.viewProvider.getTreeItem(current);
    assert.strictEqual(item.contextValue, 'branch:current');
    const other = branches.find((b) => b.ref.name === 'smart/target');
    assert.ok(other);
    assert.strictEqual(reg.viewProvider.getTreeItem(other).contextValue, 'branch:local');

    // Drag smart/target onto main → merge (choices auto-picked in test env).
    const before = git('rev-parse', 'HEAD').trim();
    process.env['GITTREE_TEST_DROP_CHOICE'] = 'merge';
    try {
      await reg.viewProvider.showDropActions(repo, 'smart/target', 'main');
    } finally {
      delete process.env['GITTREE_TEST_DROP_CHOICE'];
    }
    await refresh();
    const after = git('rev-parse', 'HEAD').trim();
    assert.notStrictEqual(after, before, 'merge did not advance HEAD');
    const mergedContent = fs.readFileSync(path.join(repoRoot, 'tracked.txt'), 'utf8');
    assert.strictEqual(mergedContent, 'target version\n');
  });
});
