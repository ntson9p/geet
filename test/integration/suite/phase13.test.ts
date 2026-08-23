import * as assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { Core, RepoHandle } from '../../../src/core/core';
import type { Phase13Registry } from '../../../src/scm/dialogs/register';
import {
  PUSH_DIALOG_METHODS,
  REMOTES_DIALOG_METHODS as REMOTES_METHODS,
  type PushRepoSectionDto,
} from '../../../src/shared/protocol';
import { activateGitTree, gitWithRetry, waitFor, withAutoConfirm, workspaceRepoC } from '../setup';

/**
 * P13 dialogs — host half. The dialog UI is Playwright-covered (push.spec.ts);
 * these tests pin what only a real repository can answer: that the section the
 * dialog opens with is the true outgoing set, that retargeting pushes where it
 * says, and that the footer options reach argv.
 *
 * The remote is a **local bare repository** in a temp directory — file:// only,
 * never a network host (the project's standing constraint). It is added to the
 * shared fixture repo for the duration of this suite and removed in teardown.
 */
suite('P13 dialogs', () => {
  let core: Core;
  let reg: Phase13Registry;
  let repo: RepoHandle;
  let repoRoot: string;
  let tmpDir: string;
  let bareUrl: string;
  let branch: string;

  const REMOTE = 'p13origin';

  const git = (...args: string[]): string => gitWithRetry(repoRoot, args);
  const bare = (...args: string[]): string =>
    execFileSync('git', ['--git-dir', bareUrl, ...args], { encoding: 'utf8' });

  suiteSetup(async function () {
    this.timeout(90_000);
    repoRoot = workspaceRepoC();
    core = await activateGitTree();
    reg = core.debugRegistry.get('phase13') as Phase13Registry;
    repo = core.repoForPath(repoRoot)!;
    assert.ok(reg && repo, 'phase13 registry or repo missing');

    // `os.tmpdir()` hands back the 8.3 short path on Windows, and git prints
    // the resolved long form — comparing the two never matches. Canonicalize
    // once here so every path this suite builds is the one git will echo.
    tmpDir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'gittree-p13-')));
    bareUrl = path.join(tmpDir, 'remote.git').replace(/\\/g, '/');
    execFileSync('git', ['init', '--bare', bareUrl], { cwd: tmpDir, encoding: 'utf8' });
    git('remote', 'add', REMOTE, bareUrl);
    await repo.refresher.refreshNow();
    await waitFor(() => repo.model.snapshot.headRef !== undefined, 15_000);
    branch = repo.model.snapshot.headRef!;
  });

  suiteTeardown(function () {
    // Generous on purpose: two retrying git config writes (up to ~22 s each
    // under the Windows lock contention `gitWithRetry` exists for) plus a
    // recursive delete of a tree holding a bare repo, a clone and worktrees.
    this.timeout(180_000);
    // Leave the shared fixture exactly as it was found.
    try {
      git('branch', '--unset-upstream');
    } catch {
      /* no upstream to drop */
    }
    try {
      git('remote', 'remove', REMOTE);
    } catch {
      /* already gone */
    }
    try {
      // Pack files are read-only on Windows; retry rather than fail the run.
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      /* best effort — a leftover temp dir must never fail the gate */
    }
  });

  /**
   * `refreshNow()` can resolve against a refresh that started before the write
   * we just made, so reading the snapshot straight afterwards is a race that
   * only shows up under full-run contention. Wait for the fact instead.
   */
  const waitForStatus = async (
    pred: (entries: readonly { path: string }[]) => boolean,
    timeoutMs = 20_000,
  ): Promise<void> => {
    await repo.refresher.refreshNow();
    await waitFor(() => pred(repo.model.snapshot.statusEntries), timeoutMs);
  };

  const sectionNow = async (): Promise<PushRepoSectionDto> => {
    const params = await reg.buildPushParams(core, [repo]);
    assert.strictEqual(params.repos.length, 1, 'expected exactly one pushable section');
    return params.repos[0]!;
  };

  /** `git diff --name-status -z` reference, read straight from the CLI. */
  const diffPaths = (from: string, to: string): string[] =>
    git('diff', '--name-status', '-M', from, to)
      .split('\n')
      .filter((l) => l.length > 0)
      .map((l) => l.split('\t').pop()!)
      .sort();

  test('T1: every webview→host push method has a handler', () => {
    const handlers = reg.pushHandlers();
    // The P11-T3 lesson: a missing handler fails in total silence.
    for (const [name, method] of Object.entries(PUSH_DIALOG_METHODS)) {
      assert.ok(
        typeof handlers[method] === 'function',
        `no handler for PUSH_DIALOG_METHODS.${name} (${method})`,
      );
    }
  });

  test('T1: the section defaults to the only remote and lists the whole branch', async function () {
    this.timeout(60_000);
    const s = await sectionNow();
    assert.strictEqual(s.branch, branch);
    assert.strictEqual(s.remote, REMOTE, 'the sole remote is the default target');
    assert.strictEqual(s.remoteBranch, branch, 'a fresh branch publishes under its own name');
    assert.strictEqual(s.hasUpstream, false);
    assert.strictEqual(s.targetExists, false, 'no tracking ref for an unpublished branch');
    assert.ok(s.totalCommits > 0, 'the whole branch is outgoing');
    assert.ok(s.remotes.includes(REMOTE));

    // Nothing is on the remote yet, so the push's file set is the whole tree.
    const tracked = git('ls-tree', '-r', '--name-only', 'HEAD')
      .split('\n')
      .filter((l) => l.length > 0)
      .sort();
    assert.deepStrictEqual(s.files.map((f) => f.path).sort(), tracked);
  });

  test('T1: pushing publishes the branch and sets upstream', async function () {
    this.timeout(60_000);
    const head = git('rev-parse', 'HEAD').trim();
    const outcomes = await reg.applyPushResult({
      repos: [{ root: repo.root, remote: REMOTE, remoteBranch: branch }],
      tags: 'none',
      runHooks: true,
      force: false,
    });
    assert.strictEqual(outcomes.length, 1, outcomes.join(' · '));
    assert.match(outcomes[0]!, /pushed/, outcomes[0]);
    assert.strictEqual(bare('rev-parse', `refs/heads/${branch}`).trim(), head);

    // `shouldSetUpstream` fired because local and remote names match.
    assert.strictEqual(
      git('rev-parse', '--abbrev-ref', `${branch}@{upstream}`).trim(),
      `${REMOTE}/${branch}`,
    );
  });

  test('T1: the file tree matches git diff <remote>/<branch>..HEAD', async function () {
    this.timeout(60_000);
    // Freshly published: nothing outgoing at all.
    await repo.refresher.refreshNow();
    const settled = await sectionNow();
    assert.strictEqual(settled.targetExists, true);
    assert.strictEqual(settled.hasUpstream, true);
    assert.strictEqual(settled.totalCommits, 0);
    assert.deepStrictEqual(settled.files, []);

    // One new commit: the section must report exactly its diff.
    const rel = 'p13/t1-outgoing.txt';
    const abs = path.join(repoRoot, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, 'outgoing\n');
    git('add', '--', rel);
    git('-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '-m', 'P13-T1 outgoing');
    await repo.refresher.refreshNow();

    const s = await sectionNow();
    assert.strictEqual(s.totalCommits, 1);
    assert.strictEqual(s.commits[0]?.subject, 'P13-T1 outgoing');
    assert.deepStrictEqual(
      s.files.map((f) => f.path).sort(),
      diffPaths(`refs/remotes/${REMOTE}/${branch}`, 'HEAD'),
    );
    assert.deepStrictEqual(s.files.map((f) => f.path), [rel]);
  });

  test('T1: retargeting recomputes the section and pushes to the chosen ref', async function () {
    this.timeout(60_000);
    const handlers = reg.pushHandlers();
    const retarget = handlers[PUSH_DIALOG_METHODS.retarget]!;
    const s = (await retarget({
      root: repo.root,
      remote: REMOTE,
      remoteBranch: 'p13-retargeted',
    })) as PushRepoSectionDto;
    assert.strictEqual(s.remoteBranch, 'p13-retargeted');
    assert.strictEqual(s.targetExists, false, 'the retargeted branch does not exist yet');
    // With no tracking ref to diff against, "outgoing" is what this remote does
    // not have *anywhere* (`HEAD --not --remotes=<remote>`) — which is what git
    // would actually transfer. The remote already holds everything up to the
    // previous test's publish, so only the commit made since it is outgoing.
    assert.strictEqual(s.totalCommits, 1);
    assert.strictEqual(s.commits[0]?.subject, 'P13-T1 outgoing');
    assert.deepStrictEqual(s.files.map((f) => f.path), ['p13/t1-outgoing.txt']);

    const head = git('rev-parse', 'HEAD').trim();
    const outcomes = await reg.applyPushResult({
      repos: [{ root: repo.root, remote: REMOTE, remoteBranch: 'p13-retargeted' }],
      tags: 'none',
      runHooks: true,
      force: false,
    });
    assert.match(outcomes[0]!, /pushed/, outcomes.join(' · '));
    assert.strictEqual(bare('rev-parse', 'refs/heads/p13-retargeted').trim(), head);

    // Retargeting must not hijack tracking — the upstream still points at the
    // branch's own name (the `shouldSetUpstream` rule).
    assert.strictEqual(
      git('rev-parse', '--abbrev-ref', `${branch}@{upstream}`).trim(),
      `${REMOTE}/${branch}`,
    );
  });

  test('T1: Run Git hooks off adds --no-verify and skips a failing pre-push', async function () {
    this.timeout(60_000);
    const hookPath = path.join(repo.dirs.gitDir, 'hooks', 'pre-push');
    fs.mkdirSync(path.dirname(hookPath), { recursive: true });
    fs.writeFileSync(hookPath, '#!/bin/sh\nexit 1\n');
    fs.chmodSync(hookPath, 0o755);
    try {
      const push = async (runHooks: boolean): Promise<string[]> =>
        reg.applyPushResult({
          repos: [{ root: repo.root, remote: REMOTE, remoteBranch: 'p13-hooks' }],
          tags: 'none',
          runHooks,
          force: false,
        });

      // Hooks on: the rejecting pre-push blocks the push.
      const blocked = await push(true);
      assert.strictEqual(blocked.length, 1);
      assert.doesNotMatch(blocked[0]!, /pushed$/, `expected the hook to block: ${blocked[0]}`);
      assert.throws(() => bare('rev-parse', 'refs/heads/p13-hooks'));

      // Hooks off: --no-verify reaches argv and the same push lands.
      const before = core.commandLog.entries().at(-1)?.seq ?? 0;
      const ok = await push(false);
      assert.match(ok[0]!, /pushed/, ok.join(' · '));
      assert.strictEqual(
        bare('rev-parse', 'refs/heads/p13-hooks').trim(),
        git('rev-parse', 'HEAD').trim(),
      );
      const pushes = core.commandLog
        .entriesAfter(before)
        .filter((e) => e.argv[0] === 'push' || e.argv.includes('push'));
      assert.ok(
        pushes.some((e) => e.argv.includes('--no-verify')),
        `no --no-verify in ${JSON.stringify(pushes.map((e) => e.argv))}`,
      );
    } finally {
      fs.rmSync(hookPath, { force: true });
    }
  });

  test('T1: force uses --force-with-lease behind the P5 confirmation', async function () {
    this.timeout(60_000);
    const force = async (): Promise<string[]> =>
      reg.applyPushResult({
        repos: [{ root: repo.root, remote: REMOTE, remoteBranch: branch }],
        tags: 'none',
        runHooks: true,
        force: true,
      });

    // Declined: nothing runs at all. `withAutoConfirm` restores the harness's
    // own value — deleting it would disarm auto-confirm for every later suite.
    const beforeDecline = core.commandLog.entries().at(-1)?.seq ?? 0;
    assert.deepStrictEqual(await withAutoConfirm('0', force), []);
    assert.strictEqual(
      core.commandLog.entriesAfter(beforeDecline).filter((e) => e.argv[0] === 'push').length,
      0,
      'a declined force push must not reach git',
    );

    // Accepted: the lease flag is there, and never a bare --force.
    const beforeAccept = core.commandLog.entries().at(-1)?.seq ?? 0;
    const outcomes = await withAutoConfirm('1', force);
    assert.match(outcomes[0]!, /pushed/, outcomes.join(' · '));
    const forced = core.commandLog
      .entriesAfter(beforeAccept)
      .filter((e) => e.argv[0] === 'push');
    assert.ok(forced.length > 0, 'the accepted force push should have run');
    assert.ok(
      forced.every((e) => e.argv.includes('--force-with-lease') && !e.argv.includes('--force')),
      `expected --force-with-lease only: ${JSON.stringify(forced.map((e) => e.argv))}`,
    );
  });

  test('T1: tag modes reach argv', async function () {
    this.timeout(60_000);
    const before = core.commandLog.entries().at(-1)?.seq ?? 0;
    await reg.applyPushResult({
      repos: [{ root: repo.root, remote: REMOTE, remoteBranch: branch }],
      tags: 'follow',
      runHooks: true,
      force: false,
    });
    const pushes = core.commandLog.entriesAfter(before).filter((e) => e.argv[0] === 'push');
    assert.ok(
      pushes.some((e) => e.argv.includes('--follow-tags')),
      `no --follow-tags in ${JSON.stringify(pushes.map((e) => e.argv))}`,
    );
  });

  test('T1: an unknown repository root is reported, never silently pushed elsewhere', async () => {
    const outcomes = await reg.applyPushResult({
      repos: [{ root: path.join(os.tmpdir(), 'gittree-not-a-repo'), remote: REMOTE, remoteBranch: branch }],
      tags: 'none',
      runHooks: true,
      force: false,
    });
    assert.strictEqual(outcomes.length, 1);
    assert.match(outcomes[0]!, /repository not found/);
  });

  // ---- P13-T2 · Update Project ---------------------------------------------

  suite('T2 update project', () => {
    let workDir: string;

    /** Commits in a second clone of the bare repo — the "incoming" changes. */
    const incoming = (rel: string, content: string, subject: string): string => {
      const abs = path.join(workDir, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content);
      gitWithRetry(workDir, ['add', '--', rel]);
      gitWithRetry(workDir, [
        '-c', 'user.name=Remote', '-c', 'user.email=remote@example.com',
        'commit', '-m', subject,
      ]);
      gitWithRetry(workDir, ['push', 'origin', `HEAD:refs/heads/${branch}`]);
      return gitWithRetry(workDir, ['rev-parse', 'HEAD']).trim();
    };

    const localCommit = (rel: string, content: string, subject: string): string => {
      const abs = path.join(repoRoot, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content);
      git('add', '--', rel);
      git('-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '-m', subject);
      return git('rev-parse', 'HEAD').trim();
    };

    suiteSetup(function () {
      this.timeout(60_000);
      workDir = path.join(tmpDir, 'work');
      execFileSync('git', ['clone', bareUrl, workDir], { cwd: tmpDir, encoding: 'utf8' });
      gitWithRetry(workDir, ['checkout', branch]);
    });

    suiteTeardown(async function () {
      this.timeout(30_000);
      // The strategy setting is workspace-scoped and would leak into later runs.
      await reg.setUpdateStrategy('ask');
    });

    test('T2: params carry the branch, upstream and divergence, defaulting to merge', async () => {
      await repo.refresher.refreshNow();
      const params = await reg.buildUpdateParams(repo);
      assert.strictEqual(params.branch, branch);
      assert.strictEqual(params.upstream, `${REMOTE}/${branch}`);
      assert.strictEqual(params.remote, REMOTE);
      // `ask` (the default) opens the dialog on Merge, IntelliJ's default.
      assert.strictEqual(reg.currentUpdateStrategy(), 'ask');
      assert.strictEqual(params.strategy, 'merge');
    });

    test('T2: the merge strategy fetches, integrates and reports what came in', async function () {
      this.timeout(90_000);
      const remoteSha = incoming('p13/t2-incoming.txt', 'from the remote\n', 'P13-T2 incoming A');

      const outcome = await reg.applyUpdateResult(repo, {
        action: 'update',
        strategy: 'merge',
        dontShowAgain: false,
      });
      assert.ok(outcome.ok, outcome.message);
      assert.strictEqual(outcome.commitsPulled, 1, outcome.message);
      assert.strictEqual(outcome.filesChanged, 1, outcome.message);
      // The reported range is the upstream boundary, which is what "Show in Log"
      // filters on — and it really resolves.
      assert.strictEqual(outcome.to, remoteSha);
      assert.notStrictEqual(outcome.from, outcome.to);
      // Nothing local had diverged, so the merge fast-forwarded onto it.
      assert.strictEqual(git('rev-parse', 'HEAD').trim(), remoteSha);
      assert.strictEqual(
        fs.readFileSync(path.join(repoRoot, 'p13/t2-incoming.txt'), 'utf8'),
        'from the remote\n',
      );
    });

    test('T2: the rebase strategy replays local commits on top of the incoming ones', async function () {
      this.timeout(90_000);
      const mine = localCommit('p13/t2-mine.txt', 'mine\n', 'P13-T2 local work');
      const remoteSha = incoming('p13/t2-incoming2.txt', 'more remote\n', 'P13-T2 incoming B');

      const outcome = await reg.applyUpdateResult(repo, {
        action: 'update',
        strategy: 'rebase',
        dontShowAgain: false,
      });
      assert.ok(outcome.ok, outcome.message);
      assert.strictEqual(outcome.commitsPulled, 1, outcome.message);

      // My commit was replayed: same subject, new sha, parented on the remote's.
      const head = git('rev-parse', 'HEAD').trim();
      assert.notStrictEqual(head, mine, 'a rebase must rewrite the local commit');
      assert.strictEqual(git('log', '-1', '--format=%s').trim(), 'P13-T2 local work');
      assert.strictEqual(git('rev-parse', 'HEAD^').trim(), remoteSha);
      // No merge commit, and a clean tree afterwards.
      assert.strictEqual(git('status', '--porcelain').trim(), '');
    });

    test('T2: Do not show again runs Ctrl+T directly, and the gear restores the dialog', async function () {
      this.timeout(90_000);
      incoming('p13/t2-incoming3.txt', 'third\n', 'P13-T2 incoming C');
      await reg.setUpdateStrategy('rebase');
      assert.strictEqual(reg.currentUpdateStrategy(), 'rebase');

      const before = tabTitles();
      // With a remembered strategy this must NOT open a dialog — if it did, the
      // call would hang here waiting for a user that does not exist.
      const outcome = await reg.showUpdateDialog(repo);
      assert.ok(outcome?.ok, outcome?.message ?? 'no outcome');
      assert.strictEqual(outcome.commitsPulled, 1, outcome.message);
      assert.deepStrictEqual(
        tabTitles().filter((t) => !before.includes(t)),
        [],
        'the remembered strategy must bypass the dialog entirely',
      );

      // The gear puts it back.
      await reg.setUpdateStrategy('ask');
      assert.strictEqual(reg.currentUpdateStrategy(), 'ask');
    });

    test('T2: Reset to the Remote Branch snapshots first and is recoverable via P9', async function () {
      this.timeout(90_000);
      const p9 = core.debugRegistry.get('phase09') as {
        getStore(repoRoot: string): { list(): Array<{ label: string; files: Array<{ relPath: string }> }> } | undefined;
      };
      const store = p9.getStore(repo.root);
      assert.ok(store, 'phase09 store missing');

      localCommit('p13/t2-doomed.txt', 'this commit dies\n', 'P13-T2 doomed local commit');
      // An uncommitted edit is what a hard reset would otherwise destroy without
      // trace — this is exactly what the P9 snapshot has to capture.
      const dirtyRel = 'p13/t2-dirty.txt';
      fs.writeFileSync(path.join(repoRoot, dirtyRel), 'unsaved work\n');
      git('add', '--', dirtyRel);
      await waitForStatus((entries) => entries.some((e) => e.path === dirtyRel));

      // Declined: the branch and the working tree are left exactly as they are.
      const headBefore = git('rev-parse', 'HEAD').trim();
      const declined = await withAutoConfirm('0', () =>
        reg.applyUpdateResult(repo, {
          action: 'reset',
          strategy: 'merge',
          dontShowAgain: false,
        }),
      );
      assert.strictEqual(declined.ok, false);
      assert.match(declined.message, /cancelled/i);
      assert.strictEqual(git('rev-parse', 'HEAD').trim(), headBefore);
      assert.strictEqual(
        fs.readFileSync(path.join(repoRoot, dirtyRel), 'utf8'),
        'unsaved work\n',
        'a declined reset must not touch the worktree',
      );

      const before = store.list().length;
      const outcome = await withAutoConfirm('1', () =>
        reg.applyUpdateResult(repo, {
          action: 'reset',
          strategy: 'merge',
          dontShowAgain: false,
        }),
      );
      assert.ok(outcome.ok, outcome.message);

      // HEAD is the upstream exactly, and the doomed commit is gone.
      const upstreamSha = git('rev-parse', `refs/remotes/${REMOTE}/${branch}`).trim();
      assert.strictEqual(git('rev-parse', 'HEAD').trim(), upstreamSha);
      assert.doesNotMatch(git('log', '--format=%s', '-20'), /doomed local commit/);

      const snaps = store.list();
      assert.ok(snaps.length > before, 'reset must add a Local History snapshot');
      const taken = snaps.filter((s) => s.label === 'Before: reset');
      assert.ok(taken.length > 0, `no "Before: reset" snapshot in ${JSON.stringify(snaps.map((s) => s.label))}`);
      assert.ok(
        taken.some((s) => s.files.some((f) => f.relPath.replace(/\\/g, '/') === dirtyRel)),
        'the discarded uncommitted edit must be recoverable',
      );
    });

    test('T2: a branch with no upstream reports instead of running anything', async function () {
      this.timeout(60_000);
      // Built deliberately rather than borrowed from another fixture repo:
      // earlier suites leave remotes and upstreams behind on the shared repos,
      // so "some other repo has no upstream" is not a fact this can rely on.
      git('branch', '--unset-upstream');
      await repo.refresher.refreshNow();
      await waitFor(() => repo.model.snapshot.upstream === undefined, 15_000);
      try {
        const outcome = await reg.applyUpdateResult(repo, {
          action: 'update',
          strategy: 'merge',
          dontShowAgain: false,
        });
        assert.strictEqual(outcome.ok, false);
        assert.match(outcome.message, /no upstream/);
        assert.strictEqual(outcome.commitsPulled, 0);
      } finally {
        git('branch', `--set-upstream-to=${REMOTE}/${branch}`);
        await repo.refresher.refreshNow();
      }
    });
  });

  // ---- P13-T3 · Merge · Rebase · Reset · Rollback ---------------------------

  suite('T3 op dialogs', () => {
    const write = (rel: string, content: string): void => {
      const abs = path.join(repoRoot, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content);
    };
    const read = (rel: string): string => fs.readFileSync(path.join(repoRoot, rel), 'utf8');
    const commit = (subject: string): string => {
      git('-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '-m', subject);
      return git('rev-parse', 'HEAD').trim();
    };
    /** A side branch with one commit, left checked out on the original branch. */
    const sideBranch = (name: string, rel: string, content: string): string => {
      git('checkout', '-b', name);
      write(rel, content);
      git('add', '--', rel);
      const sha = commit(`side ${name}`);
      git('checkout', branch);
      return sha;
    };

    suiteTeardown(async function () {
      this.timeout(60_000);
      // Never leave the fixture mid-operation for the suites that follow.
      for (const abort of [['merge', '--abort'], ['rebase', '--abort']]) {
        try {
          git(...abort);
        } catch {
          /* not in that state */
        }
      }
      await repo.refresher.refreshNow();
    });

    test('T3: merge params offer the other refs and default sensibly', async () => {
      await repo.refresher.refreshNow();
      const params = reg.buildMergeParams(repo);
      assert.strictEqual(params.currentBranch, branch);
      assert.ok(params.refs.length > 0, 'expected at least one other ref');
      assert.ok(
        !params.refs.some((r) => r.kind === 'local' && r.name === branch),
        'the current branch must not offer to merge into itself',
      );
    });

    test('T3: --squash leaves the change staged, not committed', async function () {
      this.timeout(90_000);
      const rel = 'p13/t3-squash.txt';
      sideBranch('p13/t3-squash-src', rel, 'from the side branch\n');
      const before = git('rev-parse', 'HEAD').trim();

      const outcome = await reg.applyMergeResult(repo, {
        options: {
          ref: 'p13/t3-squash-src',
          noFf: false,
          ffOnly: false,
          squash: true,
          noCommit: false,
          allowUnrelatedHistories: false,
          strategy: '',
          strategyOption: '',
          message: '',
        },
      });
      assert.ok(outcome.ok, outcome.message);
      assert.deepStrictEqual(outcome.commands[0], ['merge', '--squash', '--', 'p13/t3-squash-src']);
      // The defining behaviour of --squash: HEAD is untouched, the index is not.
      assert.strictEqual(git('rev-parse', 'HEAD').trim(), before, '--squash must not commit');
      assert.match(git('status', '--porcelain'), new RegExp(`A\\s+${rel}`));
      assert.strictEqual(read(rel), 'from the side branch\n');

      // Put the fixture back.
      git('reset', '--hard', before);
      git('branch', '-D', 'p13/t3-squash-src');
      await repo.refresher.refreshNow();
    });

    test('T3: --no-ff creates a merge commit where a fast-forward was possible', async function () {
      this.timeout(90_000);
      const rel = 'p13/t3-noff.txt';
      const sideSha = sideBranch('p13/t3-noff-src', rel, 'no-ff\n');
      const before = git('rev-parse', 'HEAD').trim();

      const outcome = await reg.applyMergeResult(repo, {
        options: {
          ref: 'p13/t3-noff-src',
          noFf: true,
          ffOnly: false,
          squash: false,
          noCommit: false,
          allowUnrelatedHistories: false,
          strategy: '',
          strategyOption: '',
          message: 'P13-T3 forced merge commit',
        },
      });
      assert.ok(outcome.ok, outcome.message);
      const head = git('rev-parse', 'HEAD').trim();
      assert.notStrictEqual(head, sideSha, '--no-ff must not fast-forward onto the side branch');
      assert.strictEqual(git('rev-list', '--count', '--merges', `${before}..HEAD`).trim(), '1');
      assert.match(git('log', '-1', '--format=%s'), /P13-T3 forced merge commit/);

      git('reset', '--hard', before);
      git('branch', '-D', 'p13/t3-noff-src');
      await repo.refresher.refreshNow();
    });

    test('T3: a validation failure never reaches git', async () => {
      const outcome = await reg.applyMergeResult(repo, {
        options: {
          ref: 'main',
          noFf: true,
          ffOnly: true,
          squash: false,
          noCommit: false,
          allowUnrelatedHistories: false,
          strategy: '',
          strategyOption: '',
          message: '',
        },
      });
      assert.strictEqual(outcome.ok, false);
      assert.deepStrictEqual(outcome.commands, [], 'a rejected option set must run nothing');
      assert.match(outcome.message, /contradict/i);
    });

    test('T3: rebase replays the branch onto another ref', async function () {
      this.timeout(90_000);
      const before = git('rev-parse', 'HEAD').trim();
      // A base to rebase onto, then one local commit to replay.
      git('checkout', '-b', 'p13/t3-base');
      write('p13/t3-base.txt', 'base\n');
      git('add', '--', 'p13/t3-base.txt');
      const baseSha = commit('P13-T3 rebase base');
      git('checkout', branch);
      write('p13/t3-mine.txt', 'mine\n');
      git('add', '--', 'p13/t3-mine.txt');
      const mine = commit('P13-T3 rebase mine');

      const outcome = await reg.applyRebaseResult(repo, {
        options: {
          onto: 'p13/t3-base',
          from: '',
          interactive: false,
          rebaseMerges: false,
          autostash: false,
          noVerify: false,
          keepEmpty: false,
        },
      });
      assert.ok(outcome.ok, outcome.message);
      assert.deepStrictEqual(outcome.commands[0], ['rebase', 'p13/t3-base']);
      const head = git('rev-parse', 'HEAD').trim();
      assert.notStrictEqual(head, mine, 'a rebase rewrites the replayed commit');
      assert.strictEqual(git('rev-parse', 'HEAD^').trim(), baseSha);
      assert.strictEqual(git('log', '-1', '--format=%s').trim(), 'P13-T3 rebase mine');

      git('reset', '--hard', before);
      git('branch', '-D', 'p13/t3-base');
      await repo.refresher.refreshNow();
    });

    test('T3: Reset Keep refuses rather than discarding local changes', async function () {
      this.timeout(90_000);
      const before = git('rev-parse', 'HEAD').trim();
      const rel = 'p13/t3-keep.txt';
      write(rel, 'v1\n');
      git('add', '--', rel);
      commit('P13-T3 keep target');
      // Dirty the very file the reset would have to rewrite: --keep must refuse.
      write(rel, 'v2 uncommitted\n');
      await waitForStatus((entries) => entries.some((e) => e.path === rel));

      const outcome = await reg.applyResetResult(repo, { ref: before, mode: 'keep' });
      assert.strictEqual(outcome.ok, false, 'Reset --keep must refuse here');
      assert.match(outcome.message, /refused/i);
      // Nothing was lost, and HEAD did not move.
      assert.strictEqual(read(rel), 'v2 uncommitted\n');
      assert.notStrictEqual(git('rev-parse', 'HEAD').trim(), before);

      // A hard reset from the same state does move, and is snapshotted.
      const p9 = core.debugRegistry.get('phase09') as {
        getStore(root: string): { list(): Array<{ label: string }> } | undefined;
      };
      const store = p9.getStore(repo.root)!;
      const snapsBefore = store.list().length;
      const hard = await withAutoConfirm('1', () =>
        reg.applyResetResult(repo, { ref: before, mode: 'hard' }),
      );
      assert.ok(hard.ok, hard.message);
      assert.strictEqual(git('rev-parse', 'HEAD').trim(), before);
      assert.ok(store.list().length > snapsBefore, 'a hard reset must snapshot first');
      assert.ok(store.list().some((s) => s.label === 'Before: reset'));
      await repo.refresher.refreshNow();
    });

    test('T3: a soft reset moves the branch and leaves everything else alone', async function () {
      this.timeout(90_000);
      const before = git('rev-parse', 'HEAD').trim();
      write('p13/t3-soft.txt', 'soft\n');
      git('add', '--', 'p13/t3-soft.txt');
      commit('P13-T3 soft target');

      const outcome = await reg.applyResetResult(repo, { ref: before, mode: 'soft' });
      assert.ok(outcome.ok, outcome.message);
      assert.strictEqual(git('rev-parse', 'HEAD').trim(), before);
      // Soft keeps the index: the file is still staged.
      assert.match(git('status', '--porcelain'), /A\s+p13\/t3-soft\.txt/);

      git('reset', '--hard', before);
      fs.rmSync(path.join(repoRoot, 'p13/t3-soft.txt'), { force: true });
      await repo.refresher.refreshNow();
    });

    test('T3: rollback of 2 of 5 files leaves the other 3 untouched', async function () {
      this.timeout(90_000);
      const baseline = git('rev-parse', 'HEAD').trim();
      // Three tracked files committed, then all three modified.
      for (const n of [1, 2, 3]) {
        write(`p13/t3-rb${n}.txt`, `v1-${n}\n`);
        git('add', '--', `p13/t3-rb${n}.txt`);
      }
      commit('P13-T3 rollback baseline');
      for (const n of [1, 2, 3]) write(`p13/t3-rb${n}.txt`, `v2-${n}\n`);
      // Plus a staged-new file and an untracked one — five in total.
      write('p13/t3-rb-added.txt', 'added\n');
      git('add', '--', 'p13/t3-rb-added.txt');
      write('p13/t3-rb-untracked.txt', 'untracked\n');
      await waitForStatus((entries) =>
        ['p13/t3-rb1.txt', 'p13/t3-rb-added.txt', 'p13/t3-rb-untracked.txt'].every((p) =>
          entries.some((e) => e.path === p),
        ),
      );

      const params = reg.buildRollbackParams(repo);
      const byPath = new Map(params.files.map((f) => [f.path, f]));
      assert.strictEqual(byPath.get('p13/t3-rb-added.txt')?.kind, 'added');
      assert.strictEqual(byPath.get('p13/t3-rb-untracked.txt')?.kind, 'untracked');
      assert.strictEqual(byPath.get('p13/t3-rb1.txt')?.kind, 'restore');

      const outcome = await reg.applyRollbackResult(repo, {
        paths: ['p13/t3-rb1.txt', 'p13/t3-rb2.txt'],
        deleteAddedLocalCopies: true,
      });
      assert.ok(outcome.ok, outcome.message);
      assert.strictEqual(read('p13/t3-rb1.txt'), 'v1-1\n', 'rolled back');
      assert.strictEqual(read('p13/t3-rb2.txt'), 'v1-2\n', 'rolled back');
      assert.strictEqual(read('p13/t3-rb3.txt'), 'v2-3\n', 'NOT selected — must be untouched');
      assert.strictEqual(read('p13/t3-rb-added.txt'), 'added\n', 'NOT selected — must survive');
      assert.strictEqual(read('p13/t3-rb-untracked.txt'), 'untracked\n', 'NOT selected');

      git('reset', '--hard', baseline);
      for (const rel of ['p13/t3-rb-added.txt', 'p13/t3-rb-untracked.txt']) {
        fs.rmSync(path.join(repoRoot, rel), { force: true });
      }
      await repo.refresher.refreshNow();
    });

    test('T3: added-file copies are deleted only when the box is ticked', async function () {
      this.timeout(90_000);
      const baseline = git('rev-parse', 'HEAD').trim();
      const addedRel = 'p13/t3-del-added.txt';
      const untrackedRel = 'p13/t3-del-untracked.txt';
      write(addedRel, 'staged new\n');
      git('add', '--', addedRel);
      write(untrackedRel, 'never tracked\n');
      await waitForStatus(
        (entries) =>
          entries.some((e) => e.path === addedRel) && entries.some((e) => e.path === untrackedRel),
      );

      // Unticked: unstaged, but the local copies stay on disk.
      const kept = await reg.applyRollbackResult(repo, {
        paths: [addedRel, untrackedRel],
        deleteAddedLocalCopies: false,
      });
      assert.ok(kept.ok, kept.message);
      assert.ok(fs.existsSync(path.join(repoRoot, addedRel)), 'unticked must keep the local copy');
      assert.ok(fs.existsSync(path.join(repoRoot, untrackedRel)));
      assert.match(git('status', '--porcelain'), new RegExp(`\\?\\?\\s+${addedRel}`));

      // Ticked: the same files go.
      await waitForStatus(
        (entries) =>
          entries.some((e) => e.path === addedRel) && entries.some((e) => e.path === untrackedRel),
      );
      const deleted = await reg.applyRollbackResult(repo, {
        paths: [addedRel, untrackedRel],
        deleteAddedLocalCopies: true,
      });
      assert.ok(deleted.ok, deleted.message);
      assert.ok(!fs.existsSync(path.join(repoRoot, addedRel)), 'ticked must delete the local copy');
      assert.ok(!fs.existsSync(path.join(repoRoot, untrackedRel)));

      git('reset', '--hard', baseline);
      await repo.refresher.refreshNow();
    });

    test('T3: the rollback preview diffs the worktree against HEAD', async function () {
      this.timeout(60_000);
      const baseline = git('rev-parse', 'HEAD').trim();
      const rel = 'p13/t3-preview.txt';
      write(rel, 'one\ntwo\nthree\n');
      git('add', '--', rel);
      commit('P13-T3 preview baseline');
      write(rel, 'one\nTWO!\nthree\n');
      await repo.refresher.refreshNow();

      const diff = await reg.rollbackFileDiff(repo, rel);
      assert.strictEqual(diff.wholeFileOnly, false);
      assert.strictEqual(diff.originalText, 'one\ntwo\nthree\n');
      assert.strictEqual(diff.modifiedText, 'one\nTWO!\nthree\n');
      assert.ok(diff.changes.length > 0, 'expected at least one line change');

      // A file with nothing in HEAD has no line diff to show.
      write('p13/t3-preview-new.txt', 'brand new\n');
      const newDiff = await reg.rollbackFileDiff(repo, 'p13/t3-preview-new.txt');
      assert.strictEqual(newDiff.wholeFileOnly, true);

      git('reset', '--hard', baseline);
      fs.rmSync(path.join(repoRoot, 'p13/t3-preview-new.txt'), { force: true });
      await repo.refresher.refreshNow();
    });
  });

  // ---- P13-T4 · Cherry-pick · Stash · Unstash · Patch · Clone · Remotes -----

  suite('T4 more dialogs', () => {
    const write = (rel: string, content: string): void => {
      const abs = path.join(repoRoot, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content);
    };
    const read = (rel: string): string => fs.readFileSync(path.join(repoRoot, rel), 'utf8');
    const commit = (subject: string): string => {
      git('-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '-m', subject);
      return git('rev-parse', 'HEAD').trim();
    };

    suiteTeardown(async function () {
      this.timeout(60_000);
      for (const abort of [['cherry-pick', '--abort'], ['am', '--abort']]) {
        try {
          git(...abort);
        } catch {
          /* not in that state */
        }
      }
      try {
        git('stash', 'clear');
      } catch {
        /* nothing stashed */
      }
      await repo.refresher.refreshNow();
    });

    test('T4: cherry-pick -x appends the source line', async function () {
      this.timeout(90_000);
      const baseline = git('rev-parse', 'HEAD').trim();
      git('checkout', '-b', 'p13/t4-source');
      write('p13/t4-pick.txt', 'picked content\n');
      git('add', '--', 'p13/t4-pick.txt');
      const source = commit('P13-T4 pick me');
      git('checkout', branch);
      await repo.refresher.refreshNow();

      const params = await reg.buildCherryPickParams(repo, [source]);
      assert.strictEqual(params.commits.length, 1);
      assert.strictEqual(params.commits[0]?.sha, source);
      assert.strictEqual(params.commits[0]?.parentCount, 1);

      const outcome = await reg.applyCherryPickResult(repo, {
        options: { shas: [source], recordOrigin: true, noCommit: false, mainline: 0 },
      });
      assert.ok(outcome.ok, outcome.message);
      assert.deepStrictEqual(outcome.commands[0], ['cherry-pick', '-x', source]);
      const body = git('log', '-1', '--format=%B');
      assert.match(body, /cherry picked from commit/, 'the -x source line must be in the message');
      assert.match(body, new RegExp(source));
      assert.strictEqual(read('p13/t4-pick.txt'), 'picked content\n');

      git('reset', '--hard', baseline);
      git('branch', '-D', 'p13/t4-source');
      await repo.refresher.refreshNow();
    });

    test('T4: cherry-pick --no-commit stages without committing', async function () {
      this.timeout(90_000);
      const baseline = git('rev-parse', 'HEAD').trim();
      git('checkout', '-b', 'p13/t4-source2');
      write('p13/t4-nocommit.txt', 'staged only\n');
      git('add', '--', 'p13/t4-nocommit.txt');
      const source = commit('P13-T4 no-commit source');
      git('checkout', branch);
      await repo.refresher.refreshNow();

      const outcome = await reg.applyCherryPickResult(repo, {
        options: { shas: [source], recordOrigin: true, noCommit: true, mainline: 0 },
      });
      assert.ok(outcome.ok, outcome.message);
      // -x is dropped when no commit is created to carry it.
      assert.deepStrictEqual(outcome.commands[0], ['cherry-pick', '--no-commit', source]);
      assert.strictEqual(git('rev-parse', 'HEAD').trim(), baseline, 'must not commit');
      assert.match(git('status', '--porcelain'), /A\s+p13\/t4-nocommit\.txt/);

      git('reset', '--hard', baseline);
      fs.rmSync(path.join(repoRoot, 'p13/t4-nocommit.txt'), { force: true });
      git('branch', '-D', 'p13/t4-source2');
      await repo.refresher.refreshNow();
    });

    test('T4: stash --keep-index leaves the staged half applied', async function () {
      this.timeout(90_000);
      const baseline = git('rev-parse', 'HEAD').trim();
      write('p13/t4-stash.txt', 'v1\n');
      git('add', '--', 'p13/t4-stash.txt');
      commit('P13-T4 stash baseline');
      // One staged edit and one unstaged edit of the same file.
      write('p13/t4-stash.txt', 'v2 staged\n');
      git('add', '--', 'p13/t4-stash.txt');
      write('p13/t4-stash.txt', 'v3 unstaged\n');
      await waitForStatus((entries) => entries.some((e) => e.path === 'p13/t4-stash.txt'));

      const params = reg.buildStashParams(repo);
      assert.ok(params.dirtyCount > 0);

      const outcome = await reg.applyStashResult(repo, {
        options: {
          message: 'P13-T4 keep-index',
          keepIndex: true,
          includeUntracked: false,
          all: false,
          staged: false,
          paths: [],
        },
      });
      assert.ok(outcome.ok, outcome.message);
      assert.deepStrictEqual(outcome.commands[0], [
        'stash',
        'push',
        '--keep-index',
        '-m',
        'P13-T4 keep-index',
      ]);
      // --keep-index: the staged content stays on disk, the unstaged edit does not.
      assert.strictEqual(read('p13/t4-stash.txt'), 'v2 staged\n');
      assert.match(git('status', '--porcelain'), /M\s+p13\/t4-stash\.txt/);

      git('reset', '--hard', baseline);
      git('stash', 'clear');
      await repo.refresher.refreshNow();
    });

    test('T4: unstash restores the files it listed, and pop removes the entry', async function () {
      this.timeout(90_000);
      const baseline = git('rev-parse', 'HEAD').trim();
      write('p13/t4-unstash.txt', 'v1\n');
      git('add', '--', 'p13/t4-unstash.txt');
      commit('P13-T4 unstash baseline');
      write('p13/t4-unstash.txt', 'v2 stashed away\n');
      await waitForStatus((entries) => entries.some((e) => e.path === 'p13/t4-unstash.txt'));

      await reg.applyStashResult(repo, {
        options: {
          message: 'P13-T4 unstash me',
          keepIndex: false,
          includeUntracked: false,
          all: false,
          staged: false,
          paths: [],
        },
      });
      await repo.refresher.refreshNow();
      await waitFor(() => repo.model.snapshot.stashes.length > 0, 20_000);
      assert.strictEqual(read('p13/t4-unstash.txt'), 'v1\n', 'stash reverted the worktree');

      const params = reg.buildUnstashParams(repo);
      assert.ok(params.entries.length > 0, 'the stash entry must be listed');
      const files = await reg.unstashFiles(repo, 0);
      assert.deepStrictEqual(
        files.map((f) => f.path),
        ['p13/t4-unstash.txt'],
      );

      const outcome = await reg.applyUnstashResult(repo, {
        index: 0,
        pop: true,
        reinstateIndex: false,
        changelistId: '',
      });
      assert.ok(outcome.ok, outcome.message);
      assert.deepStrictEqual(outcome.commands[0], ['stash', 'pop', 'stash@{0}']);
      assert.strictEqual(read('p13/t4-unstash.txt'), 'v2 stashed away\n');
      await repo.refresher.refreshNow();
      await waitFor(() => repo.model.snapshot.stashes.length === 0, 20_000);

      git('reset', '--hard', baseline);
      await repo.refresher.refreshNow();
    });

    test('T4: apply-patch reverse undoes a previously applied patch', async function () {
      this.timeout(90_000);
      const baseline = git('rev-parse', 'HEAD').trim();
      const rel = 'p13/t4-patch.txt';
      write(rel, 'one\ntwo\nthree\n');
      git('add', '--', rel);
      commit('P13-T4 patch baseline');

      // Build a real patch from a change, then reset back to the baseline.
      write(rel, 'one\nTWO PATCHED\nthree\n');
      const patchText = git('diff', '--', rel);
      const patchPath = path.join(tmpDir, 't4.patch');
      fs.writeFileSync(patchPath, patchText);
      git('checkout', '--', rel);
      await repo.refresher.refreshNow();

      // The pre-apply summary is what the dialog shows before anything runs.
      const params = reg.buildPatchParams(repo, patchPath);
      assert.strictEqual(params.error, undefined, params.error);
      assert.strictEqual(params.summary.length, 1);
      assert.strictEqual(params.summary[0]?.relPath, rel);
      assert.ok((params.summary[0]?.hunks ?? 0) > 0);
      assert.strictEqual(params.summary[0]?.missing, false);
      assert.strictEqual(params.isMailbox, false);

      const applied = await reg.applyPatchResult(repo, {
        patchPath,
        threeWay: true,
        reverse: false,
        pDepth: 1,
        whitespaceFix: false,
        contentOnly: false,
      });
      assert.ok(applied.ok, applied.message);
      assert.strictEqual(read(rel), 'one\nTWO PATCHED\nthree\n');

      const reversed = await reg.applyPatchResult(repo, {
        patchPath,
        threeWay: true,
        reverse: true,
        pDepth: 1,
        whitespaceFix: false,
        contentOnly: false,
      });
      assert.ok(reversed.ok, reversed.message);
      assert.strictEqual(read(rel), 'one\ntwo\nthree\n', 'reverse must undo the patch');

      git('reset', '--hard', baseline);
      fs.rmSync(patchPath, { force: true });
      await repo.refresher.refreshNow();
    });

    test('T4: a patch touching a missing file is flagged before applying', function () {
      this.timeout(60_000);
      const patchPath = path.join(tmpDir, 't4-missing.patch');
      fs.writeFileSync(
        patchPath,
        [
          'diff --git a/p13/never-here.txt b/p13/never-here.txt',
          'index 1111111..2222222 100644',
          '--- a/p13/never-here.txt',
          '+++ b/p13/never-here.txt',
          '@@ -1 +1 @@',
          '-old',
          '+new',
          '',
        ].join('\n'),
      );
      const params = reg.buildPatchParams(repo, patchPath);
      assert.strictEqual(params.summary.length, 1);
      assert.strictEqual(params.summary[0]?.missing, true, 'must warn about the missing file');
      fs.rmSync(patchPath, { force: true });
    });

    test('T4: cloning into a non-empty directory is blocked with a reason', async function () {
      this.timeout(120_000);
      const busy = path.join(tmpDir, 'busy-target');
      fs.mkdirSync(busy, { recursive: true });
      fs.writeFileSync(path.join(busy, 'occupied.txt'), 'in the way\n');
      const check = reg.checkCloneDirectory(busy);
      assert.strictEqual(check.ok, false);
      assert.match(check.reason ?? '', /not empty/i);

      const blocked = await reg.applyCloneResult({
        options: {
          url: bareUrl,
          directory: busy,
          recursiveSubmodules: false,
          depth: 0,
          branch: '',
        },
        openAfter: 'none',
      });
      assert.strictEqual(blocked.ok, false);
      assert.match(blocked.message, /not empty/i);

      // A fresh directory clones for real — from the local bare repo, no network.
      const fresh = path.join(tmpDir, 'clone-target');
      assert.strictEqual(reg.checkCloneDirectory(fresh).ok, true);
      const cloned = await reg.applyCloneResult({
        options: {
          url: bareUrl,
          directory: fresh,
          recursiveSubmodules: false,
          depth: 0,
          branch: '',
        },
        openAfter: 'none',
      });
      assert.ok(cloned.ok, cloned.message);
      assert.ok(fs.existsSync(path.join(fresh, '.git')), 'the clone must exist on disk');
      try {
        // A clone's pack files are read-only on Windows; the suite teardown
        // removes the whole temp tree anyway, so a leftover must never mask a
        // real assertion failure (the same policy as P12's bare-repo cleanup).
        fs.rmSync(fresh, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      } catch {
        /* best effort */
      }
    });

    test('T4: Manage Remotes add → prune → remove round-trips', async function () {
      this.timeout(90_000);
      const handlers = reg.remotesHandlers(repo);
      const before = await reg.listRemoteRows(repo);
      assert.ok(
        before.some((r) => r.name === REMOTE),
        'the suite remote should be listed',
      );
      // An empty push URL means "same as fetch" and must not echo the fetch URL.
      assert.strictEqual(before.find((r) => r.name === REMOTE)?.pushUrl, '');

      const added = (await handlers[REMOTES_METHODS.save]!({
        after: { name: 'p13extra', fetchUrl: bareUrl, pushUrl: '' },
      })) as { ok: boolean; remotes: Array<{ name: string; fetchUrl: string }> };
      assert.ok(added.ok);
      assert.ok(added.remotes.some((r) => r.name === 'p13extra'));
      assert.strictEqual(git('remote', 'get-url', 'p13extra').trim(), bareUrl);

      // Editing the fetch URL of an existing remote.
      const edited = (await handlers[REMOTES_METHODS.save]!({
        before: { name: 'p13extra', fetchUrl: bareUrl, pushUrl: '' },
        after: { name: 'p13renamed', fetchUrl: bareUrl, pushUrl: bareUrl },
      })) as { ok: boolean; remotes: Array<{ name: string; pushUrl: string }> };
      assert.ok(edited.ok);
      assert.ok(edited.remotes.some((r) => r.name === 'p13renamed'));

      const pruned = (await handlers[REMOTES_METHODS.prune]!({ name: 'p13renamed' })) as {
        ok: boolean;
      };
      assert.ok(pruned.ok);

      const removed = (await withAutoConfirm('1', async () => {
        return await handlers[REMOTES_METHODS.remove]!({ name: 'p13renamed' });
      })) as { ok: boolean; remotes: Array<{ name: string }> };
      assert.ok(removed.ok);
      assert.ok(!removed.remotes.some((r) => r.name === 'p13renamed'));
      assert.ok(
        removed.remotes.some((r) => r.name === REMOTE),
        'removing one remote must not disturb the others',
      );
    });

    test('T4: a duplicate remote name is refused before git sees it', async () => {
      const handlers = reg.remotesHandlers(repo);
      const res = (await handlers[REMOTES_METHODS.save]!({
        after: { name: REMOTE, fetchUrl: bareUrl, pushUrl: '' },
      })) as { ok: boolean; message?: string };
      assert.strictEqual(res.ok, false);
      assert.match(res.message ?? '', /already exists/);
    });
  });

  // ---- P13-T6 · Worktree management ----------------------------------------

  suite('T6 worktrees', () => {
    let wtPath: string;
    let wtBranch: string;

    suiteSetup(function () {
      this.timeout(30_000);
      wtBranch = 'p13/t6-wt';
      wtPath = path.join(tmpDir, 'wt-linked').replace(/\\/g, '/');
    });

    suiteTeardown(function () {
      this.timeout(60_000);
      // Never leave a linked worktree registered against the shared fixture.
      try {
        git('worktree', 'remove', '--force', wtPath);
      } catch {
        /* already gone */
      }
      try {
        git('worktree', 'prune');
      } catch {
        /* nothing to prune */
      }
      try {
        git('branch', '-D', wtBranch);
      } catch {
        /* already gone */
      }
    });

    test('T6: the main worktree is listed first and marked as main', async function () {
      this.timeout(60_000);
      const service = reg.worktrees.serviceFor(repo);
      const list = await service.list();
      assert.ok(list.length >= 1);
      assert.strictEqual(list[0]?.isMain, true);
      assert.strictEqual(
        list[0]?.path.replace(/\\/g, '/').toLowerCase(),
        repo.root.replace(/\\/g, '/').toLowerCase(),
      );
      assert.strictEqual(list[0]?.branch, branch);
    });

    test('T6: create a worktree from a new branch, see it listed, then remove it', async function () {
      this.timeout(120_000);
      const service = reg.worktrees.serviceFor(repo);

      const created = await reg.worktrees.applyNewWorktreeResult(repo, {
        options: {
          path: wtPath,
          mode: 'new',
          ref: branch,
          newBranch: wtBranch,
          noCheckout: false,
          force: false,
        },
        // Never actually open a window from a test.
        openInNewWindow: false,
      });
      assert.ok(created.ok, created.message);
      assert.ok(fs.existsSync(path.join(wtPath, '.git')), 'the worktree must exist on disk');

      const listed = await service.list();
      const mine = listed.find((w) => w.path.replace(/\\/g, '/').toLowerCase() === wtPath.toLowerCase());
      assert.ok(mine, `worktree not listed: ${JSON.stringify(listed.map((w) => w.path))}`);
      assert.strictEqual(mine.branch, wtBranch);
      assert.strictEqual(mine.isMain, false);
      assert.strictEqual(mine.locked, false);
      assert.strictEqual(mine.detached, false);

      // Lock / unlock round-trips through the porcelain flags.
      assert.ok((await service.lock(wtPath, 'p13 test lock')).ok);
      const locked = (await service.list()).find(
        (w) => w.path.replace(/\\/g, '/').toLowerCase() === wtPath.toLowerCase(),
      );
      assert.strictEqual(locked?.locked, true);
      assert.strictEqual(locked?.lockReason, 'p13 test lock');

      assert.ok((await service.unlock(wtPath)).ok);
      const unlocked = (await service.list()).find(
        (w) => w.path.replace(/\\/g, '/').toLowerCase() === wtPath.toLowerCase(),
      );
      assert.strictEqual(unlocked?.locked, false);

      const removed = await service.remove(wtPath);
      assert.ok(removed.ok, removed.message);
      assert.ok(!fs.existsSync(wtPath), 'the directory must be gone');
      const after = await service.list();
      assert.ok(
        !after.some((w) => w.path.replace(/\\/g, '/').toLowerCase() === wtPath.toLowerCase()),
        'the worktree must no longer be listed',
      );
    });

    test('T6: removing a dirty worktree is refused with git’s own reason', async function () {
      this.timeout(120_000);
      const service = reg.worktrees.serviceFor(repo);
      const dirtyPath = path.join(tmpDir, 'wt-dirty').replace(/\\/g, '/');
      const created = await service.add({
        path: dirtyPath,
        mode: 'new',
        ref: branch,
        newBranch: 'p13/t6-dirty',
        noCheckout: false,
        force: false,
      });
      assert.ok(created.ok, created.message);
      try {
        fs.writeFileSync(path.join(dirtyPath, 'uncommitted.txt'), 'not committed\n');

        const refused = await service.remove(dirtyPath);
        assert.strictEqual(refused.ok, false, 'a dirty worktree must not be removed silently');
        assert.match(
          refused.message,
          /contains modified or untracked files|use --force/i,
          `expected git's reason, got: ${refused.message}`,
        );
        assert.ok(fs.existsSync(dirtyPath), 'the refused removal must leave it in place');

        // --force is the escape hatch, and it is explicit.
        const forced = await service.remove(dirtyPath, true);
        assert.ok(forced.ok, forced.message);
        assert.ok(!fs.existsSync(dirtyPath));
      } finally {
        try {
          git('worktree', 'remove', '--force', dirtyPath);
        } catch {
          /* already removed */
        }
        try {
          git('branch', '-D', 'p13/t6-dirty');
        } catch {
          /* already gone */
        }
      }
    });

    test('T6: prune clears a worktree whose directory vanished', async function () {
      this.timeout(120_000);
      const service = reg.worktrees.serviceFor(repo);
      const gonePath = path.join(tmpDir, 'wt-gone').replace(/\\/g, '/');
      assert.ok(
        (
          await service.add({
            path: gonePath,
            mode: 'new',
            ref: branch,
            newBranch: 'p13/t6-gone',
            noCheckout: false,
            force: false,
          })
        ).ok,
      );
      // Delete the directory behind git's back — the record becomes prunable.
      fs.rmSync(gonePath, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });

      const stale = (await service.list()).find(
        (w) => w.path.replace(/\\/g, '/').toLowerCase() === gonePath.toLowerCase(),
      );
      assert.ok(stale, 'the stale record should still be listed before pruning');
      assert.strictEqual(stale.prunable, true);

      assert.ok((await service.prune()).ok);
      const after = await service.list();
      assert.ok(
        !after.some((w) => w.path.replace(/\\/g, '/').toLowerCase() === gonePath.toLowerCase()),
        'prune must drop the stale record',
      );
      try {
        git('branch', '-D', 'p13/t6-gone');
      } catch {
        /* already gone */
      }
    });

    test('T6: the dialog params seed the branch and a sibling path', function () {
      const params = reg.worktrees.buildNewWorktreeParams(repo, branch);
      assert.strictEqual(params.seedBranch, branch);
      assert.ok(params.branches.includes(branch));
      assert.match(params.defaultPath.replace(/\\/g, '/'), new RegExp(`-${branch}$`));
    });

    test('T6: the tree view lists a row per worktree', async function () {
      this.timeout(60_000);
      const nodes = await reg.worktrees.provider.getChildren();
      assert.ok(nodes.length >= 1);
      const mainNode = nodes.find((n) => n.info.isMain && n.repo.root === repo.root);
      assert.ok(mainNode, 'the main worktree should have a row');
      const item = reg.worktrees.provider.getTreeItem(mainNode);
      assert.strictEqual(item.label, branch);
      assert.ok(String(item.contextValue).includes('main'));
      // Leaf rows only — worktrees do not nest.
      assert.deepStrictEqual(await reg.worktrees.provider.getChildren(mainNode), []);
    });
  });
});

/** Open editor tabs, by label — used to assert a dialog panel did NOT appear. */
function tabTitles(): string[] {
  return vscode.window.tabGroups.all.flatMap((g) => g.tabs.map((t) => t.label));
}
