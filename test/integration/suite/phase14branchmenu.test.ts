import * as assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  applicableBranchActions,
  type BranchActionContext,
} from '../../../src/branches/branchActions';
import type { Phase02Registry } from '../../../src/branches/register';
import type { BranchNode } from '../../../src/branches/branchesView';
import type { Core, RepoHandle } from '../../../src/core/core';
import { canonicalKey } from '../../../src/core/repoDiscovery';
import type { Phase13Registry } from '../../../src/scm/dialogs/register';
import { activateGitTree, gitWithRetry, waitFor, workspaceRepoB } from '../setup';

/**
 * The four rows the Branches context menu was missing next to IntelliJ's —
 * Show Diff with Working Tree, New Worktree, Update, Tracked Branch — plus the
 * `:tracked` contextValue they are gated on.
 *
 * The menu *shape* is asserted in `test/unit/branches/branchMenu.test.ts`,
 * which can read the `when` clauses directly. What needs a real repository is
 * the other half: that the registry agrees with those clauses, that the
 * contextValue tracks the upstream as it comes and goes, and that `Update`
 * really moves a branch nobody has checked out — and really refuses to when
 * the move would not be a fast-forward.
 */
suite('P14 branch menu parity', () => {
  let core: Core;
  let p2: Phase02Registry;
  let repo: RepoHandle;
  let repoRoot: string;
  let tmpDir: string;
  let bareUrl: string;
  let current: string;

  const REMOTE = 'p14bmremote';
  const TARGET = 'p14bm/target';

  const git = (...args: string[]): string => gitWithRetry(repoRoot, args);
  /** A commit built without touching HEAD or the working tree. */
  const commitOnto = (parent: string, message: string): string =>
    git(
      '-c',
      'user.name=GitTree Test',
      '-c',
      'user.email=test@example.invalid',
      'commit-tree',
      `${parent}^{tree}`,
      '-p',
      parent,
      '-m',
      message,
    ).trim();

  const nodeFor = async (name: string): Promise<BranchNode> => {
    const roots = await p2.viewProvider.getChildren();
    // Canonical, never raw: on Windows the same root can be spelled long or
    // 8.3, and picking the wrong repo here would silently test another one.
    const forRepo = roots.find(
      (n) => n.kind === 'repo' && canonicalKey(n.repo.root) === canonicalKey(repo.root),
    );
    const sections = forRepo ? await p2.viewProvider.getChildren(forRepo) : roots;
    const local = sections.find((n) => n.kind === 'section' && n.section === 'local');
    assert.ok(local, 'no Local section');
    const branches = await p2.viewProvider.getChildren(local);
    const node = branches.find((n) => n.kind === 'branch' && n.ref.name === name);
    assert.ok(node, `branch node ${name} missing`);
    return node;
  };

  const contextValueOf = async (name: string): Promise<string> => {
    const item = p2.viewProvider.getTreeItem(await nodeFor(name));
    return String(item.contextValue);
  };

  const labelsFor = (ctx: BranchActionContext): string[] =>
    applicableBranchActions(p2.actions, ctx).map((a) =>
      a.label(ctx, repo.model.snapshot.headRef),
    );

  const targetUpstream = (): string | undefined =>
    repo.model.snapshot.refs.find((r) => r.type === 'head' && r.name === TARGET)?.upstream;

  /**
   * `refreshNow()` COALESCES: when a refresh is already in flight it records
   * "go round again" and returns at once, so awaiting it does not mean the
   * snapshot has caught up. Every row here is gated on tracking read from that
   * snapshot, so a bare `refreshNow()` lets a test act on the state before its
   * own `git` call — which is how the untracked case first ran `Update` on a
   * branch the model still believed was tracked, and fast-forwarded it.
   */
  const refreshUntil = async (cond: () => boolean): Promise<void> => {
    await repo.refresher.refreshNow();
    await waitFor(cond, 20_000);
  };

  suiteSetup(async function () {
    this.timeout(120_000);
    repoRoot = workspaceRepoB();
    core = await activateGitTree();
    p2 = core.debugRegistry.get('phase02') as Phase02Registry;
    repo = core.repoForPath(repoRoot)!;
    assert.ok(p2 && repo, 'phase02 registry or repo missing');
    current = repo.model.snapshot.headRef!;

    // A local bare repo stands in for a remote: the suite needs a real
    // upstream to fast-forward from, and nothing here ever leaves the machine.
    tmpDir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'gittree-p14bm-')));
    bareUrl = path.join(tmpDir, 'remote.git').replace(/\\/g, '/');
    execFileSync('git', ['init', '--bare', bareUrl], { cwd: tmpDir, encoding: 'utf8' });
    git('remote', 'add', REMOTE, bareUrl);
    await repo.refresher.refreshNow();
  });

  suiteTeardown(function () {
    this.timeout(180_000);
    for (const name of [TARGET]) {
      try {
        git('branch', '-D', name);
      } catch {
        /* already gone */
      }
    }
    try {
      git('remote', 'remove', REMOTE);
    } catch {
      /* already gone */
    }
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      /* Windows keeps pack files read-only; the OS reclaims %TEMP% */
    }
  });

  // ---- contextValue ---------------------------------------------------------

  test('the tracked bit appears and disappears with the upstream', async function () {
    this.timeout(90_000);
    const base = git('rev-parse', 'HEAD').trim();
    git('branch', '-f', TARGET, base);
    git('push', REMOTE, `${TARGET}:refs/heads/${TARGET}`);
    // Explicit rather than relying on push's tracking-ref DWIM, because
    // `--set-upstream-to` below has to find `refs/remotes/<remote>/<branch>`.
    git('fetch', REMOTE);
    await refreshUntil(() => repo.model.snapshot.refs.some((r) => r.name === TARGET));

    // No upstream yet: the kind alone, so Update and the submenu stay hidden.
    assert.strictEqual(await contextValueOf(TARGET), 'branch:local');

    git('branch', `--set-upstream-to=${REMOTE}/${TARGET}`, TARGET);
    await refreshUntil(() => targetUpstream() !== undefined);
    assert.strictEqual(await contextValueOf(TARGET), 'branch:local:tracked');

    git('branch', '--unset-upstream', TARGET);
    await refreshUntil(() => targetUpstream() === undefined);
    assert.strictEqual(await contextValueOf(TARGET), 'branch:local');
  });

  // ---- the registry, which the popup and the tree both read -----------------

  test('the checked-out branch keeps the rows that apply to it', function () {
    this.timeout(60_000);
    // The regression this guards: `refTypeOf` narrows the current branch to
    // `head`, and every predicate spelled `type === 'local'` evaporated on it —
    // the branches popup offered exactly one row for HEAD.
    const ctx: BranchActionContext = { repo, name: current, type: 'head', isCurrent: true };
    const labels = labelsFor(ctx);
    for (const expected of [
      `New Branch from '${current}'…`,
      'Show Diff with Working Tree',
      `New Worktree from '${current}'…`,
      'Push…',
      'Rename…',
      'Toggle Favorite',
    ]) {
      assert.ok(labels.includes(expected), `missing "${expected}" in ${labels.join(' | ')}`);
    }
    // And still nothing that cannot mean anything on the branch you are on.
    assert.ok(!labels.includes('Checkout'));
    assert.ok(!labels.includes('Delete'));
    assert.ok(!labels.some((l) => l.startsWith('Merge ')));
    assert.ok(!labels.some((l) => l.startsWith('Compare with ')));
  });

  test('Update and Tracked Branch follow the upstream, under a HEAD context too', async function () {
    this.timeout(120_000);
    // `type: 'head'` is what `refTypeOf` hands the registry for the
    // checked-out branch, and it is the case both rows used to fall through:
    // predicates spelled `type === 'local'` do not match it. Asserted against
    // a branch of our own rather than by re-pointing the shared fixture's
    // HEAD, which other suites in this window still depend on.
    const base = git('rev-parse', 'HEAD').trim();
    git('branch', '-f', TARGET, base);
    try {
      git('branch', '--unset-upstream', TARGET);
    } catch {
      /* already unset */
    }
    await refreshUntil(() => targetUpstream() === undefined);

    const asHead: BranchActionContext = { repo, name: TARGET, type: 'head', isCurrent: true };
    const asLocal: BranchActionContext = { repo, name: TARGET, type: 'local', isCurrent: false };
    for (const ctx of [asHead, asLocal]) {
      assert.ok(!labelsFor(ctx).includes('Update'), `Update offered while untracked (${ctx.type})`);
      assert.ok(
        !labelsFor(ctx).some((l) => l.startsWith('Tracked Branch')),
        `Tracked Branch offered while untracked (${ctx.type})`,
      );
    }

    git('push', '--force', REMOTE, `${TARGET}:refs/heads/${TARGET}`);
    git('fetch', REMOTE);
    git('branch', `--set-upstream-to=${REMOTE}/${TARGET}`, TARGET);
    await refreshUntil(() => targetUpstream() !== undefined);

    for (const ctx of [asHead, asLocal]) {
      const labels = labelsFor(ctx);
      assert.ok(labels.includes('Update'), `Update missing while tracked (${ctx.type})`);
      assert.ok(
        labels.includes(`Tracked Branch '${REMOTE}/${TARGET}'…`),
        `Tracked Branch missing (${ctx.type}) in ${labels.join(' | ')}`,
      );
    }
  });

  // ---- Update, the only genuinely new behaviour -----------------------------

  test('Update fast-forwards a branch that is not checked out', async function () {
    this.timeout(120_000);
    const base = git('rev-parse', 'HEAD').trim();
    const ahead = commitOnto(base, 'p14bm: upstream moves on');

    git('branch', '-f', TARGET, base);
    git('push', '--force', REMOTE, `${ahead}:refs/heads/${TARGET}`);
    git('fetch', REMOTE);
    git('branch', `--set-upstream-to=${REMOTE}/${TARGET}`, TARGET);
    // The row is gated on tracking read from the snapshot: without waiting for
    // it, a stale snapshot makes `Update` inapplicable and this test would
    // fail for a reason that has nothing to do with fast-forwarding.
    await refreshUntil(() => targetUpstream() !== undefined);
    assert.strictEqual(git('rev-parse', TARGET).trim(), base, 'precondition: local is behind');

    await vscode.commands.executeCommand('gittree.branch.update', await nodeFor(TARGET));
    await waitFor(() => git('rev-parse', TARGET).trim() === ahead, 30_000);

    assert.strictEqual(git('rev-parse', TARGET).trim(), ahead);
    // Fast-forward only — the branch we are standing on is untouched.
    assert.strictEqual(git('rev-parse', 'HEAD').trim(), base);
  });

  test('Update refuses a diverged branch instead of rewriting it', async function () {
    this.timeout(120_000);
    const base = git('rev-parse', 'HEAD').trim();
    const theirs = commitOnto(base, 'p14bm: their commit');
    const mine = commitOnto(base, 'p14bm: my commit');
    assert.notStrictEqual(theirs, mine, 'the two sides must really differ');

    git('branch', '-f', TARGET, mine);
    git('push', '--force', REMOTE, `${theirs}:refs/heads/${TARGET}`);
    git('fetch', REMOTE);
    git('branch', `--set-upstream-to=${REMOTE}/${TARGET}`, TARGET);
    // Load-bearing: an unawaited snapshot would leave `Update` inapplicable,
    // and this test — which asserts that nothing moved — would then pass
    // without the code under test ever running.
    await refreshUntil(() => targetUpstream() === `${REMOTE}/${TARGET}`);

    await vscode.commands.executeCommand('gittree.branch.update', await nodeFor(TARGET));
    assert.strictEqual(
      git('rev-parse', TARGET).trim(),
      mine,
      'a diverged branch must not be moved by Update',
    );
    // And the upstream really was ahead, so the refusal was a decision rather
    // than an absence of work.
    assert.strictEqual(git('rev-parse', `${REMOTE}/${TARGET}`).trim(), theirs);
  });

  // ---- POST-P14ad · Update on the checked-out branch does not ask -----------------

  /** Points the checked-out branch's upstream at `sha` and waits for the model to see it. */
  const trackCurrentAt = async (sha: string): Promise<void> => {
    git('push', '--force', REMOTE, `${sha}:refs/heads/${current}`);
    git('fetch', REMOTE);
    git('branch', `--set-upstream-to=${REMOTE}/${current}`, current);
    const upstream = `${REMOTE}/${current}`;
    await refreshUntil(
      () =>
        repo.model.snapshot.upstream === upstream &&
        repo.model.snapshot.refs.find((r) => r.type === 'head' && r.name === current)
          ?.upstream === upstream &&
        repo.model.snapshot.behind === (sha === git('rev-parse', 'HEAD').trim() ? 0 : 1),
    );
  };

  /**
   * Runs `body` with the question answered by `GITTREE_TEST_UPDATE_CHOICE`,
   * then puts back the branch, its tracking and the answer seam.
   *
   * `cancel` is the hang guard for tests that expect no question: a
   * regression that asked after all gets Cancel, leaves the branch where it
   * was and fails its assertions, instead of waiting forever on a modal no
   * test can click.
   */
  const withCurrentBranch = async (
    body: (base: string, reg13: Phase13Registry) => Promise<void>,
  ): Promise<void> => {
    const reg13 = core.debugRegistry.get('phase13') as Phase13Registry;
    assert.ok(reg13, 'phase13 registry missing');
    const base = git('rev-parse', 'HEAD').trim();
    const saved = process.env['GITTREE_TEST_UPDATE_CHOICE'];
    process.env['GITTREE_TEST_UPDATE_CHOICE'] = 'cancel';
    reg13.clearLastUpdatePrompt();
    try {
      await body(base, reg13);
    } finally {
      if (saved === undefined) delete process.env['GITTREE_TEST_UPDATE_CHOICE'];
      else process.env['GITTREE_TEST_UPDATE_CHOICE'] = saved;
      git('reset', '-q', '--hard', base);
      git('branch', '--unset-upstream', current);
      await refreshUntil(() => repo.model.snapshot.upstream === undefined);
    }
  };

  test('POST-P14ad: Update on the checked-out branch updates it without asking', async function () {
    this.timeout(120_000);
    await withCurrentBranch(async (base, reg13) => {
      const ahead = commitOnto(base, "p14bm: the checked-out branch's upstream moves on");
      await trackCurrentAt(ahead);
      await vscode.commands.executeCommand('gittree.branch.update', await nodeFor(current));
      // IntelliJ's branch Update runs with the saved method; only Update
      // Project asks. Before this, the row opened the question.
      assert.strictEqual(reg13.lastUpdatePrompt(), undefined, "a branch row's Update must not ask");
      assert.strictEqual(git('rev-parse', 'HEAD').trim(), ahead, 'the branch must be updated');
    });
  });

  test('POST-P14ad: Update on the checked-out branch uses the last answer to the question', async function () {
    this.timeout(150_000);
    await withCurrentBranch(async (base, reg13) => {
      // Answer the question Rebase, without ticking anything: the setting stays
      // `ask`. Nothing is incoming yet, so the answer moves nothing.
      await trackCurrentAt(base);
      process.env['GITTREE_TEST_UPDATE_CHOICE'] = 'rebase';
      const answered = await reg13.showUpdateDialog(repo);
      assert.ok(answered?.ok, answered?.message ?? 'no outcome');
      assert.strictEqual(reg13.currentUpdateStrategy(), 'ask', 'nobody chose Don\'t Ask Again');
      assert.strictEqual(reg13.rememberedUpdateStrategy(), 'rebase');

      // Now the upstream moves on while there is local work, so merge and
      // rebase would give different histories.
      process.env['GITTREE_TEST_UPDATE_CHOICE'] = 'cancel';
      reg13.clearLastUpdatePrompt();
      const ahead = commitOnto(base, "p14bm: the checked-out branch's upstream moves on");
      fs.writeFileSync(path.join(repoRoot, 'p14bm-local.txt'), 'local work\n');
      git('add', '--', 'p14bm-local.txt');
      git(
        '-c',
        'user.name=GitTree Test',
        '-c',
        'user.email=test@example.invalid',
        'commit',
        '-m',
        'p14bm: local work on the checked-out branch',
      );
      await trackCurrentAt(ahead);
      try {
        await vscode.commands.executeCommand('gittree.branch.update', await nodeFor(current));
        assert.strictEqual(reg13.lastUpdatePrompt(), undefined, "a branch row's Update must not ask");
        // Rebased, not merged: the local commit sits on the upstream's with a
        // single parent. A merge would have made HEAD^ the local commit.
        assert.strictEqual(git('rev-parse', 'HEAD^').trim(), ahead);
        assert.strictEqual(
          git('log', '-1', '--format=%s').trim(),
          'p14bm: local work on the checked-out branch',
        );
        assert.strictEqual(
          git('rev-list', '--parents', '-n', '1', 'HEAD').trim().split(' ').length,
          2,
        );
      } finally {
        // Answer Merge again — IntelliJ's default — so later suites start clean.
        // The branch is level with its upstream now, so this moves nothing.
        process.env['GITTREE_TEST_UPDATE_CHOICE'] = 'merge';
        await reg13.showUpdateDialog(repo);
        assert.strictEqual(reg13.rememberedUpdateStrategy(), 'merge');
      }
    });
  });

  test('Update on an untracked branch reports rather than guessing a remote', async function () {
    this.timeout(90_000);
    const base = git('rev-parse', 'HEAD').trim();
    git('branch', '-f', TARGET, base);
    try {
      git('branch', '--unset-upstream', TARGET);
    } catch {
      /* already unset */
    }
    // The upstream is still *reachable* — the previous test left the remote
    // branch ahead of `base` — so a stale snapshot would happily fast-forward
    // this branch and the assertion below would catch it. Wait for the model
    // to agree the branch is untracked, then prove nothing runs.
    await refreshUntil(() => targetUpstream() === undefined);
    await vscode.commands.executeCommand('gittree.branch.update', await nodeFor(TARGET));
    assert.strictEqual(git('rev-parse', TARGET).trim(), base);
  });

  // ---- the Tracked Branch submenu ------------------------------------------

  test('every Tracked Branch row is a registered command', async function () {
    this.timeout(60_000);
    const all = await vscode.commands.getCommands(true);
    for (const id of [
      'gittree.branch.update',
      'gittree.branch.pullIntoCurrentRebase',
      'gittree.branch.tracked.checkout',
      'gittree.branch.tracked.newFrom',
      'gittree.branch.tracked.compareWithCurrent',
      'gittree.branch.tracked.diffWithWorkingTree',
      'gittree.branch.tracked.pullIntoCurrent',
      'gittree.branch.tracked.pullIntoCurrentRebase',
      'gittree.branch.tracked.mergeIntoCurrent',
      'gittree.branch.tracked.rebaseCurrentOnto',
      'gittree.branch.tracked.newWorktree',
      'gittree.branch.tracked.deleteOnRemote',
    ]) {
      assert.ok(all.includes(id), `command ${id} is contributed but never registered`);
    }
  });

  test('a Tracked Branch row acts on the upstream, not on the row', async function () {
    this.timeout(120_000);
    const base = git('rev-parse', 'HEAD').trim();
    git('branch', '-f', TARGET, base);
    git('push', '--force', REMOTE, `${TARGET}:refs/heads/${TARGET}`);
    git('fetch', REMOTE);
    git('branch', `--set-upstream-to=${REMOTE}/${TARGET}`, TARGET);
    await refreshUntil(() => targetUpstream() === `${REMOTE}/${TARGET}`);

    // `Compare with Current` opens the compare view against whichever ref it
    // was given; the tracked row must hand it `<remote>/<branch>`.
    await vscode.commands.executeCommand(
      'gittree.branch.tracked.compareWithCurrent',
      await nodeFor(TARGET),
    );
    await waitFor(() => p2.compare.provider.state?.branch !== undefined, 30_000);
    assert.strictEqual(p2.compare.provider.state?.branch, `${REMOTE}/${TARGET}`);
  });
});
