import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { Core, RepoHandle } from '../../../src/core/core';
import { canonicalKey } from '../../../src/core/repoDiscovery';
import type { Phase02Registry } from '../../../src/branches/register';
import {
  applicableBranchActions,
  type BranchActionContext,
} from '../../../src/branches/branchActions';
import {
  buildBranchActionItems,
  buildPopupItems,
  folderOf,
  HUB_VERBS,
} from '../../../src/branches/branchesPopup';
import { activateGitTree, gitWithRetry, waitFor, workspaceRepoB } from '../setup';

/**
 * P13-T5 — the branches popup as an action hub. The QuickPick itself cannot be
 * driven from a test, so the assertions target the two pure halves the popup is
 * assembled from (`buildPopupItems`, `buildBranchActionItems`) plus the real
 * dispatch of every registry action through its command.
 */
suite('P13 branches hub', () => {
  let core: Core;
  let p2: Phase02Registry;
  let repo: RepoHandle;
  let repoRoot: string;
  let branch: string;

  const git = (...args: string[]): string => gitWithRetry(repoRoot, args);

  suiteSetup(async function () {
    this.timeout(90_000);
    repoRoot = workspaceRepoB();
    core = await activateGitTree();
    p2 = core.debugRegistry.get('phase02') as Phase02Registry;
    repo = core.repoForPath(repoRoot)!;
    assert.ok(p2 && repo, 'phase02 registry or repo missing');
    branch = repo.model.snapshot.headRef!;

    // A folder-shaped set of branches, so the drill-in has something to fold.
    for (const name of ['p13hub/alpha', 'p13hub/beta', 'p13flat']) {
      try {
        git('branch', name);
      } catch {
        /* already exists from a previous run */
      }
    }
    await repo.refresher.refreshNow();
    await waitFor(
      () => repo.model.snapshot.refs.some((r) => r.name === 'p13hub/alpha'),
      15_000,
    );
  });

  suiteTeardown(function () {
    this.timeout(60_000);
    for (const name of ['p13hub/alpha', 'p13hub/beta', 'p13flat']) {
      try {
        git('branch', '-D', name);
      } catch {
        /* already gone */
      }
    }
  });

  const popupInput = (over: Partial<Parameters<typeof buildPopupItems>[0]> = {}) => {
    // Keyed by canonical root — grabbing "the first key" picks another repo.
    const service = p2.refServices.get(canonicalKey(repo.root))!;
    assert.ok(service, 'no RefService for this repo');
    return {
      current: service.currentBranch,
      locals: service.localBranches,
      remotes: service.remoteBranches,
      tags: repo.model.snapshot.refs.filter((r) => r.type === 'tag'),
      recent: [] as string[],
      favorites: new Set<string>(),
      prefix: '',
      filtering: false,
      showInOut: false,
      ...over,
    };
  };

  test('T5: the top-level verbs come first, before any branch', () => {
    const items = buildPopupItems(popupInput());
    const firstBranchAt = items.findIndex((i) => i.branch !== undefined);
    const verbIndexes = HUB_VERBS.map((v) => items.findIndex((i) => i.command === v.command));
    assert.ok(
      verbIndexes.every((i) => i >= 0),
      `a hub verb is missing: ${JSON.stringify(verbIndexes)}`,
    );
    assert.ok(
      verbIndexes.every((i) => i < firstBranchAt),
      'the verbs must precede the branch rows',
    );
    // §2A's exact list, in order.
    assert.deepStrictEqual(HUB_VERBS.map((v) => v.label), [
      'Update Project…',
      // POST-P14bm: GitTree's own, right under the one it varies.
      'Update Project Without Fetching…',
      'Commit…',
      'Push…',
      'New Branch…',
      'Checkout Tag or Revision…',
    ]);
  });

  test('T5: typing "merge" finds an action, not just branches', () => {
    const items = buildPopupItems(popupInput());
    const hit = items.find(
      (i) => i.command !== undefined && (i.searchText ?? '').toLowerCase().includes('merge'),
    );
    assert.ok(hit, 'no verb matches "merge"');
    assert.strictEqual(hit.command, 'gittree.update.dialog');
  });

  test('T5: folder rows fold a prefix, and drilling in scopes the list', () => {
    const top = buildPopupItems(popupInput());
    const folder = top.find((i) => i.folder === 'p13hub/');
    assert.ok(folder, `no folder row for p13hub: ${JSON.stringify(top.map((i) => i.label))}`);
    assert.match(folder.description ?? '', /2 branches/);
    // The folded branches are not also listed at the top level.
    assert.ok(!top.some((i) => i.branch?.name === 'p13hub/alpha'));
    // A branch with no slash stays a plain row.
    assert.ok(top.some((i) => i.branch?.name === 'p13flat'));

    const drilled = buildPopupItems(popupInput({ prefix: 'p13hub/' }));
    assert.ok(drilled.some((i) => i.back === true), 'the drill-in needs a ‹ Back row');
    assert.ok(drilled.some((i) => i.branch?.name === 'p13hub/alpha'));
    assert.ok(!drilled.some((i) => i.branch?.name === 'p13flat'), 'out-of-scope branch leaked in');
    // The label is relative inside the folder, the search text absolute.
    const alpha = drilled.find((i) => i.branch?.name === 'p13hub/alpha');
    assert.match(alpha?.label ?? '', /alpha$/);
    assert.strictEqual(alpha?.searchText, 'p13hub/alpha');
  });

  test('T5: typing searches flat across every level, folders collapse away', () => {
    const filtered = buildPopupItems(popupInput({ prefix: 'p13hub/', filtering: true }));
    assert.ok(!filtered.some((i) => i.folder !== undefined), 'folders must fold away when filtering');
    // Out-of-scope branches are reachable again — drill-in never traps anyone.
    assert.ok(filtered.some((i) => i.branch?.name === 'p13flat'));
    assert.ok(filtered.some((i) => i.branch?.name === 'p13hub/alpha'));
    // Full names, so the filter matches what the user typed.
    assert.match(
      filtered.find((i) => i.branch?.name === 'p13hub/alpha')?.label ?? '',
      /p13hub\/alpha/,
    );
  });

  test('T5: folderOf folds only below the current prefix', () => {
    assert.strictEqual(folderOf('feature/x', ''), 'feature');
    assert.strictEqual(folderOf('feature/a/b', 'feature/'), 'a');
    assert.strictEqual(folderOf('feature/x', 'feature/'), undefined);
    assert.strictEqual(folderOf('main', ''), undefined);
    assert.strictEqual(folderOf('other/x', 'feature/'), undefined);
  });

  test('T5: the submenu is the reference list, with names interpolated', () => {
    const ctx: BranchActionContext = {
      repo,
      name: 'p13flat',
      type: 'local',
      isCurrent: false,
    };
    const items = buildBranchActionItems(p2.actions, ctx, branch);
    const labels = items.filter((i) => i.action !== undefined).map((i) => i.label);

    for (const expected of [
      'Checkout',
      "New Branch from 'p13flat'…",
      `Checkout and Rebase onto '${branch}'`,
      `Compare with '${branch}'`,
      'Show Diff with Working Tree',
      `Rebase '${branch}' onto 'p13flat'`,
      `Merge 'p13flat' into '${branch}'`,
      "New Worktree from 'p13flat'…",
      'Push…',
      'Rename…',
      'Delete',
    ]) {
      assert.ok(labels.includes(expected), `missing submenu item "${expected}" in ${labels.join(' | ')}`);
    }
    // Separators between the reference's groups.
    assert.ok(
      items.some((i) => i.kind === vscode.QuickPickItemKind.Separator),
      'the submenu needs group separators',
    );
    // POST-QA: no F2 beside Rename… here — F2 is the Repositories panel's
    // own key, and this QuickPick, its input focused, never sees it.
    assert.strictEqual(items.find((i) => i.label === 'Rename…')?.description, undefined);
  });

  test('T5: irrelevant items are hidden, not disabled — per ref type', () => {
    const labelsFor = (ctx: BranchActionContext): string[] =>
      buildBranchActionItems(p2.actions, ctx, branch)
        .filter((i) => i.action !== undefined)
        .map((i) => i.label);

    // The current branch: no checkout, no merge-into-itself, no delete.
    const current = labelsFor({ repo, name: branch, type: 'head', isCurrent: true });
    assert.ok(!current.includes('Checkout'));
    assert.ok(!current.some((l) => l.startsWith('Merge ')));
    assert.ok(!current.includes('Delete'));
    assert.ok(current.some((l) => l.startsWith('New Branch from')), 'still branchable from HEAD');

    // A remote branch: pull/delete-on-remote in, rename/local-delete/push out.
    const remote = labelsFor({ repo, name: 'origin/main', type: 'remote', isCurrent: false });
    assert.ok(remote.includes('Checkout'));
    assert.ok(remote.some((l) => l.startsWith('Pull into')));
    assert.ok(remote.some((l) => l.startsWith("Delete 'origin/main' on Remote")));
    assert.ok(!remote.includes('Rename…'));
    assert.ok(!remote.includes('Delete'));
    assert.ok(!remote.includes('Push…'));

    // A tag: no rebase/merge verbs that assume a branch.
    const tag = labelsFor({ repo, name: 'v1.0', type: 'tag', isCurrent: false });
    assert.ok(!tag.some((l) => l.startsWith('Rebase ')));
    assert.ok(!tag.includes('Rename…'));
  });

  test('T5: every applicable action has a runnable entry for all three ref kinds', () => {
    for (const ctx of [
      { repo, name: 'p13flat', type: 'local' as const, isCurrent: false },
      { repo, name: 'origin/main', type: 'remote' as const, isCurrent: false },
      { repo, name: branch, type: 'head' as const, isCurrent: true },
    ]) {
      const applicable = applicableBranchActions(p2.actions, ctx);
      assert.ok(applicable.length > 0, `no actions for ${ctx.type}`);
      for (const action of applicable) {
        assert.strictEqual(typeof action.run, 'function', `${action.id} has no run`);
        assert.ok(action.label(ctx, branch).length > 0, `${action.id} has an empty label`);
      }
    }
  });

  test('POST-P14bp: from the palette, with several repositories, Checkout Tag or Revision asks which', async function () {
    this.timeout(90_000);
    assert.ok(core.repos.length > 1, 'needs several repositories in the workspace');
    const NAME = 'p14bp-revision';
    git('branch', '-f', NAME, 'HEAD');
    const headsOf = (): string[] =>
      core.repos.map((r) => gitWithRetry(r.root, ['rev-parse', '--abbrev-ref', 'HEAD']).trim());
    const before = headsOf();
    const saved = {
      pick: process.env['GITTREE_TEST_REPO_PICK'],
      revision: process.env['GITTREE_TEST_CHECKOUT_REVISION'],
    };
    process.env['GITTREE_TEST_CHECKOUT_REVISION'] = NAME;
    try {
      // Escape: nothing checked out anywhere — not the editor's repository, not the first.
      process.env['GITTREE_TEST_REPO_PICK'] = 'cancel';
      await vscode.commands.executeCommand('gittree.branches.checkoutRevision');
      assert.deepStrictEqual(headsOf(), before);

      // This repository picked: checked out here, and only here.
      process.env['GITTREE_TEST_REPO_PICK'] = repoRoot;
      await vscode.commands.executeCommand('gittree.branches.checkoutRevision');
      await waitFor(() => git('rev-parse', '--abbrev-ref', 'HEAD').trim() === NAME, 30_000);
      const after = headsOf();
      core.repos.forEach((r, i) => {
        if (r !== repo) assert.strictEqual(after[i], before[i], `${r.root} was checked out too`);
      });

      // Named, as a repository's own menu names it: no question — `cancel` would stop it.
      git('checkout', '-q', branch);
      await repo.refresher.refreshNow();
      process.env['GITTREE_TEST_REPO_PICK'] = 'cancel';
      await vscode.commands.executeCommand('gittree.branches.checkoutRevision', repoRoot);
      await waitFor(() => git('rev-parse', '--abbrev-ref', 'HEAD').trim() === NAME, 30_000);
    } finally {
      if (saved.pick === undefined) delete process.env['GITTREE_TEST_REPO_PICK'];
      else process.env['GITTREE_TEST_REPO_PICK'] = saved.pick;
      if (saved.revision === undefined) delete process.env['GITTREE_TEST_CHECKOUT_REVISION'];
      else process.env['GITTREE_TEST_CHECKOUT_REVISION'] = saved.revision;
      git('checkout', '-q', branch);
      git('branch', '-D', NAME);
      await repo.refresher.refreshNow();
    }
  });

  test('T5: merge-into-current works from a command, with no drag-and-drop', async function () {
    this.timeout(90_000);
    // The defect this task fixes: before P13-T5 `mergeIntoCurrent` had exactly
    // one call site, the tree's drag-and-drop handler.
    const all = await vscode.commands.getCommands(true);
    for (const id of [
      'gittree.branch.mergeIntoCurrent',
      'gittree.branch.checkoutAndRebase',
      'gittree.branch.rebaseCurrentOnto',
      'gittree.branch.newWorktree',
      'gittree.branch.pullIntoCurrent',
      'gittree.branch.deleteOnRemote',
      'gittree.branch.new',
      'gittree.branches.checkoutRevision',
    ]) {
      assert.ok(all.includes(id), `${id} is not registered`);
    }

    // A real merge: a side branch one commit ahead, merged into the current one.
    const base = git('rev-parse', 'HEAD').trim();
    git('branch', 'p13hub/mergeme');
    git('checkout', 'p13hub/mergeme');
    git('-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '--allow-empty', '-m', 'P13-T5 merge me');
    const sideSha = git('rev-parse', 'HEAD').trim();
    git('checkout', branch);
    await repo.refresher.refreshNow();

    try {
      await vscode.commands.executeCommand(
        'gittree.branch.mergeIntoCurrent',
        repo.root,
        'p13hub/mergeme',
      );
      await waitFor(() => git('rev-parse', 'HEAD').trim() !== base, 30_000);
      // Fast-forward or merge commit — either way the side commit is reachable.
      const reachable = gitWithRetry(repoRoot, [
        'merge-base',
        '--is-ancestor',
        sideSha,
        'HEAD',
      ]);
      assert.strictEqual(reachable, '', 'the merged commit must be reachable from HEAD');
    } finally {
      git('reset', '--hard', base);
      try {
        git('branch', '-D', 'p13hub/mergeme');
      } catch {
        /* already gone */
      }
      await repo.refresher.refreshNow();
    }
  });

  test('T5: an action that does not apply reports instead of running', async function () {
    this.timeout(60_000);
    const before = git('rev-parse', 'HEAD').trim();
    // Merging the current branch into itself is not an applicable action.
    await vscode.commands.executeCommand('gittree.branch.mergeIntoCurrent', repo.root, branch);
    assert.strictEqual(git('rev-parse', 'HEAD').trim(), before, 'nothing should have run');
  });

  // ---- P13-T7 · VCS Operations Popup ---------------------------------------

  suite('T7 operations popup', () => {
    interface OpsRegistry {
      readContext(repoRoot?: string): { hasRepo: boolean; dirty: boolean; inProgressOp?: string };
      buildItems(repoRoot?: string): Array<{ command: string; group: string; label: string }>;
    }
    let ops: OpsRegistry;

    suiteSetup(function () {
      this.timeout(30_000);
      ops = core.debugRegistry.get('operationsPopup') as OpsRegistry;
      assert.ok(ops, 'operationsPopup registry missing');
    });

    suiteTeardown(async function () {
      this.timeout(60_000);
      try {
        git('merge', '--abort');
      } catch {
        /* not mid-merge */
      }
      git('reset', '--hard');
      git('clean', '-fd');
      await repo.refresher.refreshNow();
    });

    test('T7: the command is registered and bound to the hub', async () => {
      const all = await vscode.commands.getCommands(true);
      assert.ok(all.includes('gittree.operationsPopup'), 'gittree.operationsPopup is missing');
    });

    test('T7: no item appears that would immediately fail its own precondition', async function () {
      this.timeout(60_000);
      git('reset', '--hard');
      git('clean', '-fd');
      await repo.refresher.refreshNow();
      await waitFor(() => !ops.readContext(repo.root).dirty, 15_000);

      const commands = ops.buildItems(repo.root).map((i) => i.command);
      // A clean tree has nothing to commit, stash, shelve or roll back.
      for (const c of [
        'gittree.commit',
        'gittree.stash.dialog',
        'gittree.shelve.dialog',
        'gittree.rollback.dialog',
      ]) {
        assert.ok(!commands.includes(c), `${c} must not be offered on a clean tree`);
      }
      // No stash exists here either.
      assert.ok(!commands.includes('gittree.unstash.dialog'));
      // But repository-level actions do apply.
      assert.ok(commands.includes('gittree.merge.dialog'));
      assert.ok(commands.includes('gittree.clone.dialog'));
    });

    test('T7: a dirty tree changes the item set', async function () {
      this.timeout(60_000);
      const rel = 'p13-ops-dirty.txt';
      fs.writeFileSync(path.join(repoRoot, rel), 'dirty\n');
      await repo.refresher.refreshNow();
      await waitFor(() => ops.readContext(repo.root).dirty, 15_000);

      const commands = ops.buildItems(repo.root).map((i) => i.command);
      for (const c of [
        'gittree.commit',
        'gittree.stash.dialog',
        'gittree.shelve.dialog',
        'gittree.rollback.dialog',
      ]) {
        assert.ok(commands.includes(c), `${c} should be offered on a dirty tree`);
      }

      git('clean', '-fd');
      await repo.refresher.refreshNow();
      await waitFor(() => !ops.readContext(repo.root).dirty, 15_000);
    });

    test('T7: mid-merge the continue/abort actions come first', async function () {
      this.timeout(120_000);
      const base = git('rev-parse', 'HEAD').trim();
      const rel = 'p13-ops-conflict.txt';
      // Two branches editing the same line — a guaranteed conflict.
      fs.writeFileSync(path.join(repoRoot, rel), 'base\n');
      git('add', '--', rel);
      git('-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '-m', 'ops base');
      const forkPoint = git('rev-parse', 'HEAD').trim();
      git('checkout', '-b', 'p13ops/side');
      fs.writeFileSync(path.join(repoRoot, rel), 'side\n');
      git('add', '--', rel);
      git('-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '-m', 'ops side');
      git('checkout', branch);
      fs.writeFileSync(path.join(repoRoot, rel), 'mine\n');
      git('add', '--', rel);
      git('-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '-m', 'ops mine');

      try {
        try {
          git('merge', 'p13ops/side');
          assert.fail('the merge was expected to conflict');
        } catch {
          /* conflict is the point */
        }
        await repo.refresher.refreshNow();
        await waitFor(() => ops.readContext(repo.root).inProgressOp !== undefined, 20_000);

        const items = ops.buildItems(repo.root);
        assert.strictEqual(items[0]?.group, 'inProgress', 'the in-progress group must be first');
        assert.strictEqual(items[0]?.command, 'gittree.merge.continueOp');
        const commands = items.map((i) => i.command);
        assert.ok(commands.includes('gittree.merge.abortOp'));
        // A merge has no "skip" — only a rebase does.
        assert.ok(!commands.includes('gittree.rebase.skip'));
      } finally {
        try {
          git('merge', '--abort');
        } catch {
          /* already aborted */
        }
        git('reset', '--hard', base);
        git('clean', '-fd');
        try {
          git('branch', '-D', 'p13ops/side');
        } catch {
          /* already gone */
        }
        void forkPoint;
        await repo.refresher.refreshNow();
      }
    });

    test('T7: every offered item is a registered command', async function () {
      this.timeout(60_000);
      const all = new Set(await vscode.commands.getCommands(true));
      const missing = ops
        .buildItems()
        .map((i) => i.command)
        .filter((c) => !all.has(c));
      assert.deepStrictEqual(
        missing,
        [],
        `the popup offers unregistered commands: ${missing.join(', ')}`,
      );
    });
  });
});
