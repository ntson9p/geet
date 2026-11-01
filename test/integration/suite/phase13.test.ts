import * as assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Phase03Registry } from '../../../src/commit/register';
import type { Core, RepoHandle } from '../../../src/core/core';
import { isStaged } from '../../../src/core/model/statusEntry';
import type { Phase13Registry } from '../../../src/scm/dialogs/register';
import type { NotificationsRegistry } from '../../../src/ui/notify';
import {
  PUSH_DIALOG_METHODS,
  REMOTES_DIALOG_METHODS as REMOTES_METHODS,
  type CommitFileDto,
  type PushDefineRemoteResultDto,
  type PushDialogResultDto,
  type PushRepoDto,
  type PushRetargetDto,
} from '../../../src/shared/protocol';
import * as vscode from 'vscode';
import { repoLabels } from '../../../src/core/util/repoLabels';
import {
  activateGitTree,
  gitWithRetry,
  waitFor,
  withAutoConfirm,
  workspaceRepoC,
  workspaceRepoD,
  workspaceRepoE,
} from '../setup';
import type { LogWorktreeActionParamsDto, LogWorktreesDto } from '../../../src/shared/protocol';

/** POST-P14k: the bridge as this suite uses it (module identity differs across the test/dist boundary). */
interface WorktreesBridgeShape {
  buildState(): Promise<LogWorktreesDto>;
  dispatch(params: LogWorktreeActionParamsDto): Promise<void>;
}

/**
 * P13 dialogs — host half. The dialog UI is Playwright-covered (push.spec.ts);
 * these tests pin what only a real repository can answer: that the row the
 * dialog opens with is IntelliJ's default target with the true outgoing
 * commits, that retargeting pushes where it says, and that the footer options
 * reach argv.
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

  /** The row the Push dialog opens with for repoC on its own. */
  const rowNow = async (): Promise<PushRepoDto> => {
    const params = await reg.buildPushParams({ repos: [repo], preselected: [repo] });
    assert.strictEqual(params.repos.length, 1, 'expected exactly one row');
    return params.repos[0]!;
  };

  /** Exactly what the dialog posts for repoC's branch pushed to `target` on the suite's remote. */
  const fromDialog = (
    target: string,
    over: Partial<PushDialogResultDto> = {},
    setUpstream = false,
  ): PushDialogResultDto => ({
    repos: [
      {
        root: repo.root,
        source: { kind: 'branch', presentation: branch, revision: `refs/heads/${branch}`, branch },
        target: { remote: REMOTE, branch: target },
        setUpstream,
      },
    ],
    tags: 'none',
    runHooks: true,
    force: false,
    ...over,
  });

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

  test('T1: Push… lists every repository and checks the one asked for', async function () {
    this.timeout(60_000);
    const saved = process.env['GITTREE_TEST_PUSH_DIALOG'];
    process.env['GITTREE_TEST_PUSH_DIALOG'] = 'cancel';
    reg.clearLastPushDialogRequest();
    try {
      await vscode.commands.executeCommand('gittree.push.dialog', repo.root);
    } finally {
      if (saved === undefined) delete process.env['GITTREE_TEST_PUSH_DIALOG'];
      else process.env['GITTREE_TEST_PUSH_DIALOG'] = saved;
    }
    const opened = reg.lastPushDialogOpened();
    assert.deepStrictEqual([...(opened?.repos ?? [])].sort(), core.repos.map((r) => r.root).sort());
    assert.deepStrictEqual(opened?.preselected, [repo.root]);
    assert.strictEqual(opened?.source, undefined, 'each row pushes its own checked-out branch');

    const params = await reg.buildPushParams({ repos: core.repos, preselected: [repo] });
    const checked = params.repos.filter((r) => r.checked).map((r) => r.root);
    assert.deepStrictEqual(checked, [repo.root]);
    if (params.repos.length > 1) {
      assert.strictEqual(params.title, 'Push Commits');
      assert.strictEqual(params.single, false);
    }
  });

  test('T1: the row defaults to the only remote, a New branch of its own name', async function () {
    this.timeout(60_000);
    const r = await rowNow();
    assert.deepStrictEqual(r.source, {
      kind: 'branch',
      presentation: branch,
      revision: `refs/heads/${branch}`,
      branch,
    });
    assert.deepStrictEqual(r.target, { remote: REMOTE, branch, isNew: true, type: 'tracking' });
    assert.strictEqual(r.sourceTracks, false);
    assert.ok(r.remotes.includes(REMOTE));
    // Nothing is on the remote yet: every commit of the branch is outgoing.
    const all = git('rev-list', '--count', `--max-count=1000`, 'HEAD').trim();
    assert.strictEqual(String(r.commits.length), all);
    assert.strictEqual(r.commits[0]?.sha, git('rev-parse', 'HEAD').trim(), 'newest first');
    assert.strictEqual(r.checked, true);
  });

  test('T1: pushing publishes the branch and sets upstream', async function () {
    this.timeout(60_000);
    const head = git('rev-parse', 'HEAD').trim();
    const outcomes = await reg.applyPushResult(fromDialog(branch));
    assert.strictEqual(outcomes.length, 1, outcomes.join(' · '));
    assert.match(outcomes[0]!, /pushed/, outcomes[0]);
    assert.strictEqual(bare('rev-parse', `refs/heads/${branch}`).trim(), head);

    // IntelliJ's rule: a branch pushed to a new branch, tracking nothing, tracks it now.
    assert.strictEqual(
      git('rev-parse', '--abbrev-ref', `${branch}@{upstream}`).trim(),
      `${REMOTE}/${branch}`,
    );
  });

  test('T1: the commits are <remote>/<branch>..HEAD, and their changes are theirs', async function () {
    this.timeout(60_000);
    // Freshly published: the upstream, and nothing outgoing at all.
    await repo.refresher.refreshNow();
    const settled = await rowNow();
    assert.deepStrictEqual(settled.target, { remote: REMOTE, branch, isNew: false, type: 'tracking' });
    assert.strictEqual(settled.sourceTracks, true);
    assert.deepStrictEqual(settled.commits, []);

    // One new commit: the row lists exactly it, and its changes are its file.
    const rel = 'p13/t1-outgoing.txt';
    const abs = path.join(repoRoot, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, 'outgoing\n');
    git('add', '--', rel);
    git('-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '-m', 'P13-T1 outgoing');
    await repo.refresher.refreshNow();

    const r = await rowNow();
    assert.deepStrictEqual(
      r.commits.map((c) => c.subject),
      ['P13-T1 outgoing'],
    );
    const sha = r.commits[0]!.sha;
    const changes = (await reg.pushHandlers()[PUSH_DIALOG_METHODS.changes]!({
      root: repo.root,
      shas: [sha],
    })) as { files: CommitFileDto[] };
    assert.deepStrictEqual(changes.files, [{ status: 'A', path: rel, after: sha }]);
    const details = (await reg.pushHandlers()[PUSH_DIALOG_METHODS.details]!({
      root: repo.root,
      sha,
    })) as { sha: string; body: string } | undefined;
    assert.strictEqual(details?.sha, sha);
    assert.strictEqual(details?.body, 'P13-T1 outgoing');
  });

  test('T1: retargeting lists what that remote has nowhere, and pushes to the chosen ref', async function () {
    this.timeout(60_000);
    const handlers = reg.pushHandlers();
    const retarget = handlers[PUSH_DIALOG_METHODS.retarget]!;
    const t = (await retarget({
      root: repo.root,
      remote: REMOTE,
      branch: 'p13-retargeted',
    })) as PushRetargetDto;
    assert.deepStrictEqual(t.target, { remote: REMOTE, branch: 'p13-retargeted', isNew: true, type: 'custom' });
    // A new branch: what this remote does not have *anywhere*
    // (`HEAD --not --remotes=<remote>`) — what git will actually transfer. The
    // remote holds everything up to the publish, so only the commit since is.
    assert.deepStrictEqual(
      t.commits.map((c) => c.subject),
      ['P13-T1 outgoing'],
    );

    const head = git('rev-parse', 'HEAD').trim();
    const outcomes = await reg.applyPushResult(fromDialog('p13-retargeted'));
    assert.match(outcomes[0]!, /pushed/, outcomes.join(' · '));
    assert.strictEqual(bare('rev-parse', 'refs/heads/p13-retargeted').trim(), head);

    // A branch that tracks something keeps tracking it.
    assert.strictEqual(
      git('rev-parse', '--abbrev-ref', `${branch}@{upstream}`).trim(),
      `${REMOTE}/${branch}`,
    );
  });

  test('T1: Set upstream makes the target the upstream', async function () {
    this.timeout(60_000);
    try {
      const outcomes = await reg.applyPushResult(fromDialog('p13-upstream', {}, true));
      assert.match(outcomes[0]!, /pushed/, outcomes.join(' · '));
      assert.strictEqual(
        git('rev-parse', '--abbrev-ref', `${branch}@{upstream}`).trim(),
        `${REMOTE}/p13-upstream`,
      );
    } finally {
      git('branch', `--set-upstream-to=${REMOTE}/${branch}`);
      await repo.refresher.refreshNow();
    }
  });

  test('T1: Run Git hooks is offered with a pre-push hook, and off adds --no-verify', async function () {
    this.timeout(60_000);
    const hookPath = path.join(repo.dirs.gitDir, 'hooks', 'pre-push');
    fs.mkdirSync(path.dirname(hookPath), { recursive: true });
    fs.writeFileSync(hookPath, '#!/bin/sh\nexit 1\n');
    fs.chmodSync(hookPath, 0o755);
    try {
      const shown = await reg.buildPushParams({ repos: [repo], preselected: [repo] });
      assert.strictEqual(shown.showRunHooks, true, 'IntelliJ shows Run Git hooks only for a pre-push hook');
      const push = async (runHooks: boolean): Promise<string[]> =>
        reg.applyPushResult(fromDialog('p13-hooks', { runHooks }));

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
    const hidden = await reg.buildPushParams({ repos: [repo], preselected: [repo] });
    assert.strictEqual(hidden.showRunHooks, false);
  });

  test('T1: force uses --force-with-lease, never --force', async function () {
    this.timeout(60_000);
    // Confirmed in the dialog already: the host pushes.
    const before = core.commandLog.entries().at(-1)?.seq ?? 0;
    const outcomes = await reg.applyPushResult(fromDialog(branch, { force: true }));
    assert.match(outcomes[0]!, /pushed/, outcomes.join(' · '));
    const forced = core.commandLog
      .entriesAfter(before)
      .filter((e) => e.argv[0] === 'push');
    assert.ok(forced.length > 0, 'the force push should have run');
    assert.ok(
      forced.every((e) => e.argv.includes('--force-with-lease') && !e.argv.includes('--force')),
      `expected --force-with-lease only: ${JSON.stringify(forced.map((e) => e.argv))}`,
    );
  });

  test('T1: tag modes reach argv', async function () {
    this.timeout(60_000);
    const before = core.commandLog.entries().at(-1)?.seq ?? 0;
    await reg.applyPushResult(fromDialog(branch, { tags: 'follow' }));
    const pushes = core.commandLog.entriesAfter(before).filter((e) => e.argv[0] === 'push');
    assert.ok(
      pushes.some((e) => e.argv.includes('--follow-tags')),
      `no --follow-tags in ${JSON.stringify(pushes.map((e) => e.argv))}`,
    );
  });

  test('T1: Define Remote checks the name and the URL, then adds the remote', async function () {
    this.timeout(60_000);
    const define = reg.pushHandlers()[PUSH_DIALOG_METHODS.defineRemote]!;
    const ask = async (name: string, url: string): Promise<PushDefineRemoteResultDto> =>
      (await define({ root: repo.root, name, url, fetch: true })) as PushDefineRemoteResultDto;

    assert.deepStrictEqual(await ask('', bareUrl), {
      ok: false,
      field: 'name',
      message: 'Remote name cannot be empty',
    });
    assert.deepStrictEqual(await ask(REMOTE, bareUrl), {
      ok: false,
      field: 'name',
      message: `Remote name '${REMOTE}' is already used`,
    });
    assert.deepStrictEqual(await ask('p13second', ''), {
      ok: false,
      field: 'url',
      message: 'Remote URL cannot be empty',
    });
    const unreachable = await ask('p13second', path.join(tmpDir, 'no-such.git').replace(/\\/g, '/'));
    assert.strictEqual(unreachable.ok, false);
    assert.ok(!git('remote').split('\n').includes('p13second'), 'nothing added for a URL that does not answer');

    try {
      const added = await ask('p13second', bareUrl);
      assert.ok(added.ok, JSON.stringify(added));
      if (added.ok) assert.ok(added.repo.remotes.includes('p13second'));
      assert.ok(git('remote').split('\n').includes('p13second'));
    } finally {
      try {
        git('remote', 'remove', 'p13second');
      } catch {
        /* never added */
      }
      await repo.refresher.refreshNow();
    }
  });

  test('POST-P14ap: Fetch says Fetch successful, naming what the prune removed', async function () {
    this.timeout(60_000);
    const notes = core.debugRegistry.get('notifications') as NotificationsRegistry;
    // A branch on the remote, known locally, then deleted on the remote.
    bare('branch', '-f', 'p13-prune', `refs/heads/${branch}`);
    git('fetch', REMOTE);
    assert.ok(git('branch', '-r').includes(`${REMOTE}/p13-prune`));
    bare('branch', '-D', 'p13-prune');

    notes.clear();
    await vscode.commands.executeCommand('gittree.fetch', repo.root);
    assert.ok(!git('branch', '-r').includes(`${REMOTE}/p13-prune`), 'the fetch prunes');
    assert.deepStrictEqual(
      notes.recent().map((n) => n.message),
      [`Fetch successful. Pruned obsolete remote reference: ${REMOTE}/p13-prune`],
    );

    // Nothing to prune: just Fetch successful.
    notes.clear();
    await vscode.commands.executeCommand('gittree.fetch', repo.root);
    assert.deepStrictEqual(
      notes.recent().map((n) => n.message),
      ['Fetch successful'],
    );
  });

  test('T1: an unknown repository root is reported, never silently pushed elsewhere', async () => {
    const result = fromDialog(branch);
    const outcomes = await reg.applyPushResult({
      ...result,
      repos: [{ ...result.repos[0]!, root: path.join(os.tmpdir(), 'gittree-not-a-repo') }],
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

    /**
     * POST-P14af: the Push Rejected question is a native modal, which no test
     * can click: `GITTREE_TEST_PUSH_REJECTED_CHOICE` answers it. `cancel` is
     * the safe answer for a test that expects no question at all — asked
     * anyway, the push stays rejected and the test fails instead of hanging.
     */
    const withPushChoice = async <T>(
      choice: 'merge' | 'rebase' | 'cancel',
      fn: () => Promise<T>,
    ): Promise<T> => {
      const saved = process.env['GITTREE_TEST_PUSH_REJECTED_CHOICE'];
      process.env['GITTREE_TEST_PUSH_REJECTED_CHOICE'] = choice;
      try {
        return await fn();
      } finally {
        if (saved === undefined) delete process.env['GITTREE_TEST_PUSH_REJECTED_CHOICE'];
        else process.env['GITTREE_TEST_PUSH_REJECTED_CHOICE'] = saved;
      }
    };
    /** Brings the second clone level with the remote, which repoC pushes to from POST-P14af on. */
    const catchUpTeammate = (): void => {
      gitWithRetry(workDir, ['fetch', 'origin']);
      gitWithRetry(workDir, ['reset', '-q', '--hard', `origin/${branch}`]);
    };
    /** A teammate's push: a commit on the remote that repoC does not have. */
    const teammate = (rel: string, content: string, subject: string): string => {
      catchUpTeammate();
      return incoming(rel, content, subject);
    };
    const remoteHead = (ref = branch): string => bare('rev-parse', `refs/heads/${ref}`).trim();

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

    /**
     * POST-P14ab: the question is a native modal, which no test can click.
     * `GITTREE_TEST_UPDATE_CHOICE` answers it — and `cancel` is the safe
     * answer for a test that expects no question at all: a modal asked for
     * real would hang the run instead of failing it.
     */
    const withUpdateChoice = async <T>(
      choice: 'merge' | 'rebase' | 'reset' | 'cancel',
      fn: () => Promise<T>,
    ): Promise<T> => {
      const saved = process.env['GITTREE_TEST_UPDATE_CHOICE'];
      process.env['GITTREE_TEST_UPDATE_CHOICE'] = choice;
      try {
        return await fn();
      } finally {
        if (saved === undefined) delete process.env['GITTREE_TEST_UPDATE_CHOICE'];
        else process.env['GITTREE_TEST_UPDATE_CHOICE'] = saved;
      }
    };

    test('T2: the question names the branch and its upstream, and offers Merge first', async () => {
      await repo.refresher.refreshNow();
      const prompt = await reg.buildUpdatePrompt(repo);
      assert.ok(prompt, 'a tracked branch must get a question');
      assert.strictEqual(prompt.message, 'Update Project');
      // What the buttons act on — the thing a bare dialog title never said.
      assert.ok(
        prompt.detail.includes(`${branch} ← ${REMOTE}/${branch}`),
        `detail does not name the branch and upstream:\n${prompt.detail}`,
      );
      // `ask` (the default) with nothing remembered opens on Merge, IntelliJ's default.
      assert.strictEqual(reg.currentUpdateStrategy(), 'ask');
      assert.deepStrictEqual(prompt.choices, ['merge', 'rebase', 'reset']);
      assert.deepStrictEqual(prompt.buttons, ['Merge', 'Rebase', 'Reset to the Remote Branch']);
      // Each button's exact commands, from the same argv the host runs.
      // POST-P14ac: with nothing staged, the rebase sets local changes aside.
      assert.ok(
        prompt.detail.includes(
          `Rebase: git fetch --prune ${REMOTE} && git rebase --autostash ${REMOTE}/${branch}`,
        ),
        prompt.detail,
      );
    });

    test('T2: the merge strategy fetches, integrates and reports what came in', async function () {
      this.timeout(90_000);
      const remoteSha = incoming('p13/t2-incoming.txt', 'from the remote\n', 'P13-T2 incoming A');

      const outcome = await reg.applyUpdateResult(repo, {
        action: 'update',
        strategy: 'merge',
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

    test('POST-P14ab: the answer runs, and is the first button next time', async function () {
      this.timeout(90_000);
      incoming('p13/t2-answer.txt', 'answered\n', 'P13-T2 incoming by answer');
      reg.clearLastUpdatePrompt();

      const outcome = await withUpdateChoice('rebase', () => reg.showUpdateDialog(repo));
      assert.ok(outcome?.ok, outcome?.message ?? 'no outcome');
      assert.strictEqual(outcome.commitsPulled, 1, outcome.message);
      // It really asked, and asked with Merge first — nothing was remembered yet.
      assert.deepStrictEqual(reg.lastUpdatePrompt()?.choices, ['merge', 'rebase', 'reset']);

      // The answer is kept even though the question is still asked: IntelliJ
      // saves the radio on every OK, independently of `Don't show again`.
      assert.strictEqual(reg.currentUpdateStrategy(), 'ask');
      assert.strictEqual(reg.rememberedUpdateStrategy(), 'rebase');
      const next = await reg.buildUpdatePrompt(repo);
      assert.deepStrictEqual(next?.choices, ['rebase', 'merge', 'reset']);
      assert.strictEqual(next?.buttons[0], 'Rebase', 'Enter must repeat the last answer');

      // Put Merge back the way a user would — by answering — so later suites
      // start from IntelliJ's default. Nothing is incoming, so nothing moves.
      const restore = await withUpdateChoice('merge', () => reg.showUpdateDialog(repo));
      assert.ok(restore?.ok, restore?.message ?? 'no outcome');
      assert.strictEqual(reg.rememberedUpdateStrategy(), 'merge');
    });

    test('POST-P14ab: Cancel runs nothing and remembers nothing', async function () {
      this.timeout(60_000);
      incoming('p13/t2-cancelled.txt', 'never pulled\n', 'P13-T2 incoming, cancelled');
      const head = git('rev-parse', 'HEAD').trim();
      const upstreamBefore = git('rev-parse', `refs/remotes/${REMOTE}/${branch}`).trim();

      const outcome = await withUpdateChoice('cancel', () => reg.showUpdateDialog(repo));
      assert.strictEqual(outcome, undefined);
      assert.strictEqual(git('rev-parse', 'HEAD').trim(), head);
      // Not even the fetch: a cancelled question is no update at all.
      assert.strictEqual(
        git('rev-parse', `refs/remotes/${REMOTE}/${branch}`).trim(),
        upstreamBefore,
      );
      assert.strictEqual(reg.rememberedUpdateStrategy(), 'merge');
    });

    test("T2: Don't Ask Again runs Ctrl+T directly, and the gear restores the question", async function () {
      this.timeout(90_000);
      incoming('p13/t2-incoming3.txt', 'third\n', 'P13-T2 incoming C');
      await reg.setUpdateStrategy('rebase');
      assert.strictEqual(reg.currentUpdateStrategy(), 'rebase');

      reg.clearLastUpdatePrompt();
      // With a remembered strategy this must NOT ask. `cancel` guards the
      // regression: asked anyway, the update is cancelled and fails below
      // rather than hanging on a modal nobody can answer.
      const outcome = await withUpdateChoice('cancel', () => reg.showUpdateDialog(repo));
      assert.ok(outcome?.ok, outcome?.message ?? 'no outcome');
      // Two commits: this test's, and the one the Cancel test left incoming.
      assert.strictEqual(outcome.commitsPulled, 2, outcome.message);
      assert.strictEqual(reg.lastUpdatePrompt(), undefined, 'the setting must bypass the question');

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
      // Driven through the question's own `Reset to the Remote Branch` button,
      // which must land on the confirmation, not on the reset itself.
      const headBefore = git('rev-parse', 'HEAD').trim();
      const declined = await withUpdateChoice('reset', () =>
        withAutoConfirm('0', () => reg.showUpdateDialog(repo)),
      );
      assert.ok(declined, 'the reset button produced no outcome');
      assert.strictEqual(declined.ok, false);
      assert.match(declined.message, /cancelled/i);
      // A destructive answer is never kept as "what you chose last time".
      assert.strictEqual(reg.rememberedUpdateStrategy(), 'merge');
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
        });
        assert.strictEqual(outcome.ok, false);
        assert.match(outcome.message, /no upstream/);
        assert.strictEqual(outcome.commitsPulled, 0);
      } finally {
        git('branch', `--set-upstream-to=${REMOTE}/${branch}`);
        await repo.refresher.refreshNow();
      }
    });

    // ---- POST-P14ac · local changes are set aside, never refused over ----------

    /** A tracked file both sides already have — the earlier merge test pulled it. */
    const SHARED = 'p13/t2-incoming.txt';
    const abs = (rel: string): string => path.join(repoRoot, rel);
    const read = (rel: string): string => fs.readFileSync(abs(rel), 'utf8');
    const stashes = (): string => git('stash', 'list').trim();
    const lifecycle = (): { get(root: string): { source: string } | undefined } =>
      (core.debugRegistry.get('phase06') as {
        lifecycle: { get(root: string): { source: string } | undefined };
      }).lifecycle;

    /**
     * A conflict session holds the repository's mutation lane until it ends,
     * so a test that makes one must end it — or every later suite on repoC
     * queues behind it forever.
     *
     * Polled until the model has been back to normal for several reads in a
     * row, not until the first one: `refreshNow()` coalesces into a refresh
     * already in flight and can resolve before any read that post-dates the
     * call, so a refresh that began while the rebase was still stopped can
     * land *after* the cleanup and repaint the detached, conflicted state.
     * Measured: T3, the next suite, then read `currentBranch === 'HEAD'`.
     */
    const endConflicts = async (): Promise<void> => {
      const deadline = Date.now() + 20_000;
      let settledReads = 0;
      while (settledReads < 3) {
        await repo.refresher.refreshNow();
        const snap = repo.model.snapshot;
        const settled =
          snap.headRef === branch &&
          snap.inProgressOp === undefined &&
          !snap.statusEntries.some((e) => e.kind === 'unmerged') &&
          lifecycle().get(repo.root) === undefined;
        settledReads = settled ? settledReads + 1 : 0;
        if (settledReads < 3 && Date.now() > deadline) {
          throw new Error(`repoC never settled: head=${String(snap.headRef)}`);
        }
        await new Promise((r) => setTimeout(r, 250));
      }
    };

    suiteSetup(async function () {
      this.timeout(30_000);
      await repo.refresher.refreshNow();
      await waitFor(() => repo.model.snapshot.upstream !== undefined, 15_000);
    });

    test('POST-P14ac: a rebase over uncommitted edits sets them aside and puts them back', async function () {
      this.timeout(90_000);
      const mine = 'from the remote\nmy uncommitted edit\n';
      fs.writeFileSync(abs(SHARED), mine);
      incoming('p13/t2-aside-a.txt', 'a\n', 'P13-T2 incoming, aside A');
      try {
        // The defect: a bare `git rebase` refuses on any uncommitted change —
        // "cannot rebase: You have unstaged changes" — before doing anything.
        const outcome = await reg.applyUpdateResult(repo, { action: 'update', strategy: 'rebase' });
        assert.ok(outcome.ok, outcome.message);
        assert.strictEqual(outcome.commitsPulled, 1, outcome.message);
        assert.strictEqual(read(SHARED), mine, 'the edit must come back exactly');
        assert.strictEqual(stashes(), '', 'a clean restore leaves nothing in the stash');
        assert.strictEqual(outcome.restoreConflicts, undefined);
      } finally {
        git('checkout', '--', SHARED);
      }
    });

    test('POST-P14ac: a file added to VCS survives an update, still added', async function () {
      this.timeout(90_000);
      const added = 'p13/t2-added.txt';
      fs.writeFileSync(abs(added), 'brand new\n');
      git('add', '-N', '--', added);
      // A tracked edit too, so the autostash has something to carry: with only
      // the intent-to-add entry, the defect never reaches `git stash`.
      const mine = 'from the remote\nalongside a new file\n';
      fs.writeFileSync(abs(SHARED), mine);
      incoming('p13/t2-aside-b.txt', 'b\n', 'P13-T2 incoming, aside B');
      try {
        // The defect this guards: `git stash` cannot save an intent-to-add
        // entry ("Cannot autostash"), which would have made --autostash break
        // an update that a plain merge handles.
        const outcome = await reg.applyUpdateResult(repo, { action: 'update', strategy: 'merge' });
        assert.ok(outcome.ok, outcome.message);
        assert.strictEqual(outcome.commitsPulled, 1, outcome.message);
        // Intent-to-add again — `1 .A` — exactly what Add to VCS made it.
        assert.match(git('status', '--porcelain=v2', '--', added), /^1 \.A /mu);
        assert.strictEqual(read(added), 'brand new\n');
        assert.strictEqual(read(SHARED), mine);
        assert.strictEqual(stashes(), '');
      } finally {
        git('rm', '--cached', '-q', '--', added);
        fs.rmSync(abs(added), { force: true });
        git('checkout', '--', SHARED);
      }
    });

    test('POST-P14ac: staged content is never unstaged by an update', async function () {
      this.timeout(90_000);
      // `--autostash` restores content but not the index — measured, `MM`
      // comes back as ` M`. Staged work must therefore never ride it.
      fs.writeFileSync(abs(SHARED), 'from the remote\nstaged on purpose\n');
      git('add', '--', SHARED);
      incoming('p13/t2-aside-c.txt', 'c\n', 'P13-T2 incoming, aside C');
      try {
        const outcome = await reg.applyUpdateResult(repo, { action: 'update', strategy: 'merge' });
        assert.ok(outcome.ok, outcome.message);
        assert.strictEqual(outcome.commitsPulled, 1, outcome.message);
        assert.deepStrictEqual(
          git('diff', '--cached', '--name-only').trim().split(/\r?\n/u),
          [SHARED],
          'the staged change must still be staged',
        );
      } finally {
        git('reset', '-q', '--', SHARED);
        git('checkout', '--', SHARED);
      }
    });

    test('POST-P14ac: a conflicting restore is reported, and filed as a stash pop', async function () {
      this.timeout(90_000);
      fs.writeFileSync(abs(SHARED), 'from the remote\nMINE\n');
      incoming(SHARED, 'from the remote\nTHEIRS\n', 'P13-T2 incoming, conflicts with my edit');
      try {
        const outcome = await reg.applyUpdateResult(repo, { action: 'update', strategy: 'merge' });
        // The update itself landed; only putting my edit back collided. git
        // exits 0 here, so a result that trusted the exit code said "Merged".
        assert.ok(outcome.ok, outcome.message);
        assert.strictEqual(outcome.restoreConflicts, 1, outcome.message);
        assert.match(outcome.message, /conflict/iu);
        assert.match(stashes(), /autostash/u, 'git keeps a copy of the changes in the stash');
        // No merge or rebase is in progress, so only the hint names it.
        await waitFor(() => lifecycle().get(repo.root) !== undefined, 20_000);
        assert.strictEqual(lifecycle().get(repo.root)?.source, 'stash-pop');
      } finally {
        git('reset', '-q', '--hard');
        git('stash', 'drop');
        await endConflicts();
      }
    });

    test('POST-P14ac: a rebase stopped on a conflict leaves added files untracked, and says so', async function () {
      this.timeout(90_000);
      const upstreamRef = `refs/remotes/${REMOTE}/${branch}`;
      localCommit(SHARED, 'from the remote\nTHEIRS\nLOCAL COMMIT\n', 'P13-T2 local, will conflict');
      git('fetch', REMOTE);
      incoming(SHARED, 'from the remote\nTHEIRS\nREMOTE COMMIT\n', 'P13-T2 remote, will conflict');
      const added = 'p13/t2-added-e.txt';
      fs.writeFileSync(abs(added), 'mid-rebase\n');
      git('add', '-N', '--', added);
      try {
        const outcome = await reg.applyUpdateResult(repo, { action: 'update', strategy: 'rebase' });
        assert.strictEqual(outcome.ok, false, 'the rebase stops on its own conflict');
        // Not put back mid-rebase: the autostash still has to be re-applied
        // when it finishes, and git stash cannot stand intent-to-add entries.
        assert.match(outcome.message, /unversioned until the rebase is finished/u);
        assert.match(git('status', '--porcelain', '--', added), /^\?\? /mu);
        assert.strictEqual(read(added), 'mid-rebase\n', 'the file itself is untouched');
      } finally {
        git('rebase', '--abort');
        git('reset', '-q', '--hard', upstreamRef);
        fs.rmSync(abs(added), { force: true });
        await endConflicts();
      }
    });

    // ---- POST-P14ae · Update Project updates the project ----------------------------

    suite('POST-P14ae update project across repositories', () => {
      let repoD: RepoHandle;
      let repoE: RepoHandle;
      const D_REMOTE = 'p13dremote';
      const cli = (cwd: string, ...args: string[]): string => gitWithRetry(cwd, args);
      const label = (r: RepoHandle): string =>
        repoLabels(core.repos.map((x) => x.root)).get(r.root) ?? path.basename(r.root);
      const withChoice = async <T>(choice: string, fn: () => Promise<T>): Promise<T> => {
        const saved = process.env['GITTREE_TEST_UPDATE_CHOICE'];
        process.env['GITTREE_TEST_UPDATE_CHOICE'] = choice;
        try {
          return await fn();
        } finally {
          if (saved === undefined) delete process.env['GITTREE_TEST_UPDATE_CHOICE'];
          else process.env['GITTREE_TEST_UPDATE_CHOICE'] = saved;
        }
      };
      /** Refreshes until `cond` holds — `refreshNow()` alone can resolve early. */
      const settle = async (r: RepoHandle, cond: () => boolean): Promise<void> => {
        await r.refresher.refreshNow();
        await waitFor(cond, 20_000);
      };

      /**
       * repoD gets a remote of its own with one commit it does not have, for the
       * length of `body`; repoE is made sure to track nothing, so it is the
       * repository the update has to skip. Both are put back exactly: other
       * suites own them.
       */
      let projects = 0;
      /** Runs every restore step, so one failure cannot strand the others. */
      const bestEffort = (step: () => void): void => {
        try {
          step();
        } catch {
          /* the rest of the cleanup still has to run */
        }
      };
      const withProject = async (
        body: (dAhead: string, dBase: string) => Promise<void>,
      ): Promise<void> => {
        const dRoot = repoD.root;
        const dBranch = cli(dRoot, 'rev-parse', '--abbrev-ref', 'HEAD').trim();
        const dBase = cli(dRoot, 'rev-parse', 'HEAD').trim();
        // A fresh remote per call: the last one's branch is ahead of this
        // one's base, so reusing it would make the push a non-fast-forward.
        // Both directories stay under tmpDir, which the suite teardown deletes
        // — pack files are read-only on Windows, and a delete here fails EPERM.
        projects++;
        const bare = path.join(tmpDir, `remote-d-${projects}.git`).replace(/\\/g, '/');
        execFileSync('git', ['init', '--bare', bare], { cwd: tmpDir, encoding: 'utf8' });
        cli(dRoot, 'remote', 'add', D_REMOTE, bare);
        cli(dRoot, 'push', D_REMOTE, `HEAD:refs/heads/${dBranch}`);
        const work = path.join(tmpDir, `work-d-${projects}`);
        execFileSync('git', ['clone', '-b', dBranch, bare, work], { cwd: tmpDir, encoding: 'utf8' });
        fs.writeFileSync(path.join(work, 'p13-project.txt'), 'from the remote\n');
        cli(work, 'add', '--', 'p13-project.txt');
        cli(work, '-c', 'user.name=Remote', '-c', 'user.email=remote@example.com', 'commit', '-m', 'P13 project: incoming for repoD');
        cli(work, 'push', 'origin', `HEAD:refs/heads/${dBranch}`);
        const dAhead = cli(work, 'rev-parse', 'HEAD').trim();
        cli(dRoot, 'fetch', D_REMOTE);
        cli(dRoot, 'branch', `--set-upstream-to=${D_REMOTE}/${dBranch}`, dBranch);

        const eBranch = repoE.model.snapshot.headRef;
        const eUpstream = repoE.model.snapshot.upstream;
        if (eUpstream !== undefined && eBranch !== undefined) {
          cli(repoE.root, 'branch', '--unset-upstream', eBranch);
        }
        await settle(repoD, () => repoD.model.snapshot.upstream === `${D_REMOTE}/${dBranch}`);
        await settle(repoE, () => repoE.model.snapshot.upstream === undefined);
        try {
          await body(dAhead, dBase);
        } finally {
          bestEffort(() => cli(dRoot, 'reset', '-q', '--hard', dBase));
          bestEffort(() => cli(dRoot, 'branch', '--unset-upstream', dBranch));
          bestEffort(() => cli(dRoot, 'remote', 'remove', D_REMOTE));
          if (eUpstream !== undefined && eBranch !== undefined) {
            bestEffort(() => cli(repoE.root, 'branch', `--set-upstream-to=${eUpstream}`, eBranch));
          }
          await settle(repoD, () => repoD.model.snapshot.upstream === undefined);
        }
      };

      suiteSetup(async function () {
        this.timeout(30_000);
        repoD = core.repoForPath(workspaceRepoD())!;
        repoE = core.repoForPath(workspaceRepoE())!;
        assert.ok(repoD && repoE, 'repoD/repoE missing');
        await settle(repo, () => repo.model.snapshot.upstream !== undefined);
      });

      test('POST-P14ae: Update Project with nothing named asks once, about every repository', async function () {
        this.timeout(60_000);
        reg.clearLastUpdatePrompt();
        const headsBefore = core.repos.map((r) => cli(r.root, 'rev-parse', 'HEAD').trim());
        // Cancelled, so nothing runs anywhere: this reads the question only.
        await withChoice('cancel', async () => {
          await vscode.commands.executeCommand('gittree.update.dialog');
        });
        const prompt = reg.lastUpdatePrompt();
        assert.ok(prompt, 'the project must be asked about, once');
        // Every repository is on it — as one to update or as one skipped, and
        // why. Before this, the command picked the active editor's repository,
        // or gave up with several repositories and no editor open.
        for (const r of core.repos) {
          assert.ok(prompt.detail.includes(label(r)), `${label(r)} is missing from:\n${prompt.detail}`);
        }
        assert.deepStrictEqual(
          core.repos.map((r) => cli(r.root, 'rev-parse', 'HEAD').trim()),
          headsBefore,
          'a cancelled question updates nothing',
        );
      });

      test('POST-P14ae: one answer updates every repository, and skips the one it cannot', async function () {
        this.timeout(120_000);
        const cAhead = incoming('p13/project-c.txt', 'c\n', 'P13 project: incoming for repoC');
        await withProject(async (dAhead) => {
          reg.clearLastUpdatePrompt();
          const result = await withChoice('merge', () => reg.showProjectUpdate([repo, repoD, repoE]));
          assert.ok(result, 'no result');

          const prompt = reg.lastUpdatePrompt();
          assert.ok(prompt, 'one question for the lot');
          // No Reset across several repositories, and the skipped one is named.
          assert.deepStrictEqual(prompt.choices, ['merge', 'rebase']);
          assert.ok(prompt.detail.includes(`${label(repoE)}: skipped — no upstream branch`), prompt.detail);

          assert.strictEqual(result.stoppedAt, undefined);
          assert.deepStrictEqual(
            result.results.map((r) => [r.repo.root, r.outcome.ok]),
            [
              [repo.root, true],
              [repoD.root, true],
            ],
          );
          assert.deepStrictEqual(result.skipped.map((s) => s.repo.root), [repoE.root]);
          assert.strictEqual(git('rev-parse', 'HEAD').trim(), cAhead);
          assert.strictEqual(cli(repoD.root, 'rev-parse', 'HEAD').trim(), dAhead);
        });
      });

      test('POST-P14ae: the run stops at the first repository that fails', async function () {
        this.timeout(120_000);
        await withProject(async (_dAhead, dBase) => {
          // repoC runs first and cannot fetch; repoD, behind by one, must then
          // be left exactly where it was rather than merged after a failure.
          const url = git('remote', 'get-url', REMOTE).trim();
          git('remote', 'set-url', REMOTE, path.join(tmpDir, 'no-such-remote.git'));
          try {
            const result = await withChoice('merge', () => reg.showProjectUpdate([repo, repoD]));
            assert.ok(result, 'no result');
            assert.strictEqual(result.stoppedAt?.root, repo.root);
            assert.strictEqual(result.results.length, 1, 'nothing may run after the failure');
            assert.strictEqual(result.results[0]?.outcome.ok, false);
            assert.strictEqual(cli(repoD.root, 'rev-parse', 'HEAD').trim(), dBase);
          } finally {
            git('remote', 'set-url', REMOTE, url);
          }
        });
      });

      // ---- POST-P14ag · Update all repositories -----------------------------------

      /** repoC rejected: a teammate pushed first, and repoC has a commit of its own. */
      const rejectRepoC = async (tag: string): Promise<string> => {
        const theirs = teammate(`p13/push-all-theirs-${tag}.txt`, 'theirs\n', `P14ag teammate ${tag}`);
        localCommit(`p13/push-all-mine-${tag}.txt`, 'mine\n', `P14ag mine ${tag}`);
        await settle(repo, () => (repo.model.snapshot.ahead ?? 0) > 0);
        reg.clearLastPushRejectedPrompt();
        return theirs;
      };

      test('POST-P14ag: a rejected push updates the other repositories too, then pushes again', async function () {
        this.timeout(180_000);
        await withProject(async (dAhead) => {
          await rejectRepoC('a');
          const results = await withPushChoice('merge', () =>
            reg.pushTracked(repo, [repo, repoD, repoE]),
          );
          assert.deepStrictEqual(results?.map((r) => r.kind), ['pushed']);
          // One question, naming the repository it updates as well — IntelliJ's
          // ticked checkbox, spelled out — and not the one it cannot update.
          const prompt = reg.lastPushRejectedPrompt();
          assert.ok(prompt, 'a rejected push must ask');
          assert.ok(prompt.detail.includes(`Also updates ${label(repoD)} `), prompt.detail);
          assert.ok(!prompt.detail.includes(label(repoE)), prompt.detail);
          // repoD, which nobody pushed, was brought up to date…
          assert.strictEqual(cli(repoD.root, 'rev-parse', 'HEAD').trim(), dAhead);
          // …and repoC merged theirs and went through.
          assert.strictEqual(remoteHead(), git('rev-parse', 'HEAD').trim());
          assert.strictEqual(git('rev-list', '--parents', '-n', '1', 'HEAD').trim().split(' ').length, 3);
        });
      });

      test('POST-P14ag: with the setting off, only the rejected repository is updated', async function () {
        this.timeout(180_000);
        await withProject(async (_dAhead, dBase) => {
          await reg.setUpdateAllRepositoriesIfRejected(false);
          try {
            await rejectRepoC('b');
            const results = await withPushChoice('merge', () =>
              reg.pushTracked(repo, [repo, repoD, repoE]),
            );
            assert.deepStrictEqual(results?.map((r) => r.kind), ['pushed']);
            assert.ok(!reg.lastPushRejectedPrompt()?.detail.includes('Also updates'));
            assert.strictEqual(cli(repoD.root, 'rev-parse', 'HEAD').trim(), dBase, 'repoD is left alone');
          } finally {
            await reg.setUpdateAllRepositoriesIfRejected(undefined);
          }
        });
      });

      test('POST-P14ag: nothing is pushed again unless every update went through', async function () {
        this.timeout(180_000);
        try {
          await withProject(async (_dAhead, dBase) => {
            // repoD cannot fetch, so its update fails — after repoC's, which runs first.
            cli(repoD.root, 'remote', 'set-url', D_REMOTE, path.join(tmpDir, 'no-such-remote.git'));
            const theirs = await rejectRepoC('c');
            const results = await withPushChoice('merge', () =>
              reg.pushTracked(repo, [repo, repoD, repoE]),
            );
            assert.ok(results?.length === 1, JSON.stringify(results?.map((r) => r.kind)));
            const only = results[0] as { kind: string; stoppedAt?: { root: string } };
            assert.strictEqual(only.kind, 'rejected');
            assert.strictEqual(only.stoppedAt?.root, repoD.root, 'the result names where it stopped');
            assert.strictEqual(remoteHead(), theirs, "repoC's push must not run again");
            assert.strictEqual(cli(repoD.root, 'rev-parse', 'HEAD').trim(), dBase);
          });
        } finally {
          // repoC merged theirs but was not pushed; level it for the suites after.
          git('reset', '-q', '--hard', `${REMOTE}/${branch}`);
        }
      });
    });

    // ---- POST-P14af · a rejected push asks Merge or Rebase, then pushes again --------

    suite('POST-P14af push rejected', () => {
      /** Exactly what the Push dialog posts for repoC's branch to its upstream. */
      const pushFromDialog = (remoteBranch = branch): Promise<string[]> =>
        reg.applyPushResult(fromDialog(remoteBranch));

      setup(async function () {
        this.timeout(60_000);
        // Level with the remote and clean, whatever the last test left.
        git('fetch', REMOTE);
        git('reset', '-q', '--hard', `${REMOTE}/${branch}`);
        await repo.refresher.refreshNow();
        await waitFor(
          () =>
            repo.model.snapshot.headRef === branch &&
            repo.model.snapshot.upstream === `${REMOTE}/${branch}`,
          20_000,
        );
        reg.clearLastPushRejectedPrompt();
      });

      suiteSetup(async function () {
        this.timeout(30_000);
        // One repository's question is what these tests are about. Update all
        // repositories has its own tests (POST-P14ag), with the project
        // narrowed; here it would update the rest of the shared workspace,
        // whose repositories other suites leave tracking remotes they deleted.
        await reg.setUpdateAllRepositoriesIfRejected(false);
      });

      suiteTeardown(async function () {
        this.timeout(30_000);
        await reg.setAutoUpdateIfRejected(false);
        await reg.setUpdateAllRepositoriesIfRejected(undefined);
      });

      test('POST-P14af: a rejected push asks Merge or Rebase, merges, and pushes again', async function () {
        this.timeout(120_000);
        const theirs = teammate('p13/push-theirs-a.txt', 'theirs\n', 'P14af teammate A');
        const mine = localCommit('p13/push-mine-a.txt', 'mine\n', 'P14af mine A');
        await repo.refresher.refreshNow();

        const outcomes = await withPushChoice('merge', () => pushFromDialog());
        assert.deepStrictEqual(outcomes, [`${branch} → ${REMOTE}/${branch}: pushed after merge`]);

        // It asked, in IntelliJ's words, with the default answer first.
        const prompt = reg.lastPushRejectedPrompt();
        assert.ok(prompt, 'a rejected push must ask Merge or Rebase');
        assert.strictEqual(prompt.message, 'Push Rejected');
        assert.ok(prompt.detail.includes(`Push of the current branch "${branch}"`), prompt.detail);
        assert.ok(
          prompt.detail.includes('was rejected. Remote changes need to be merged before pushing.'),
          prompt.detail,
        );
        assert.deepStrictEqual(prompt.buttons, ['Merge', 'Rebase']);
        // What Merge runs: Update Project's commands, then the same push again.
        assert.ok(
          prompt.detail.includes(
            `Merge: git fetch --prune ${REMOTE} && git merge --autostash ${REMOTE}/${branch} && git push ${REMOTE} ${branch}:refs/heads/${branch}`,
          ),
          prompt.detail,
        );

        // A merge of both, and it reached the remote.
        const head = git('rev-parse', 'HEAD').trim();
        assert.strictEqual(remoteHead(), head, 'the second push must land');
        const parents = git('rev-list', '--parents', '-n', '1', 'HEAD').trim().split(' ').slice(1);
        assert.deepStrictEqual(parents.sort(), [mine, theirs].sort());
      });

      test('POST-P14af: Rebase replays the local commit on top of theirs, then pushes', async function () {
        this.timeout(120_000);
        const theirs = teammate('p13/push-theirs-b.txt', 'theirs\n', 'P14af teammate B');
        localCommit('p13/push-mine-b.txt', 'mine\n', 'P14af mine B');
        await repo.refresher.refreshNow();

        const outcomes = await withPushChoice('rebase', () => pushFromDialog());
        assert.deepStrictEqual(outcomes, [`${branch} → ${REMOTE}/${branch}: pushed after rebase`]);
        assert.strictEqual(git('rev-parse', 'HEAD^').trim(), theirs, 'mine now sits on top of theirs');
        assert.strictEqual(git('log', '-1', '--format=%s').trim(), 'P14af mine B');
        assert.strictEqual(remoteHead(), git('rev-parse', 'HEAD').trim());
        // IntelliJ keeps one update method for both questions: the answer here
        // is Update Project's default from now on too.
        assert.strictEqual(reg.rememberedUpdateStrategy(), 'rebase');
      });

      test('POST-P14af: Cancel pushes nothing, updates nothing, and asked with the last answer first', async function () {
        this.timeout(90_000);
        const theirs = teammate('p13/push-theirs-c.txt', 'theirs\n', 'P14af teammate C');
        const mine = localCommit('p13/push-mine-c.txt', 'mine\n', 'P14af mine C');
        const tracking = git('rev-parse', `refs/remotes/${REMOTE}/${branch}`).trim();
        await repo.refresher.refreshNow();

        const outcomes = await withPushChoice('cancel', () => pushFromDialog());
        assert.deepStrictEqual(outcomes, [`${branch} → ${REMOTE}/${branch}: rejected (fetch first)`]);
        assert.deepStrictEqual(reg.lastPushRejectedPrompt()?.buttons, ['Rebase', 'Merge']);
        assert.strictEqual(git('rev-parse', 'HEAD').trim(), mine);
        assert.strictEqual(remoteHead(), theirs);
        assert.strictEqual(
          git('rev-parse', `refs/remotes/${REMOTE}/${branch}`).trim(),
          tracking,
          'a declined question runs not even the fetch',
        );
        assert.strictEqual(reg.rememberedUpdateStrategy(), 'rebase', 'Cancel remembers nothing');
      });

      test('POST-P14af: with auto-update on, gittree.push updates and pushes without asking', async function () {
        this.timeout(120_000);
        const theirs = teammate('p13/push-theirs-d.txt', 'theirs\n', 'P14af teammate D');
        localCommit('p13/push-mine-d.txt', 'mine\n', 'P14af mine D');
        await repo.refresher.refreshNow();
        await reg.setAutoUpdateIfRejected(true);
        try {
          // `gittree.push` is what Commit and Push and Sync run.
          await withPushChoice('cancel', async () => {
            await vscode.commands.executeCommand('gittree.push', repo.root);
          });
        } finally {
          await reg.setAutoUpdateIfRejected(false);
        }
        assert.strictEqual(reg.lastPushRejectedPrompt(), undefined, 'auto-update must not ask');
        // The remembered strategy — Rebase, from two tests ago — ran.
        assert.strictEqual(git('rev-parse', 'HEAD^').trim(), theirs);
        assert.strictEqual(remoteHead(), git('rev-parse', 'HEAD').trim());
      });

      test('POST-P14af: over unpushed merge commits it recommends Merge, and asks even with auto-update on', async function () {
        this.timeout(120_000);
        assert.strictEqual(reg.rememberedUpdateStrategy(), 'rebase', 'precondition: Rebase remembered');
        const theirs = teammate('p13/push-theirs-e.txt', 'theirs\n', 'P14af teammate E');
        // A side branch merged locally and not pushed — what a rebase flattens.
        git('checkout', '-q', '-b', 'p14af-side');
        localCommit('p13/push-side-e.txt', 'side\n', 'P14af side E');
        git('checkout', '-q', branch);
        localCommit('p13/push-mine-e.txt', 'mine\n', 'P14af mine E');
        git('-c', 'user.name=T', '-c', 'user.email=t@example.com', 'merge', '--no-ff', '-m', 'P14af local merge', 'p14af-side');
        const head = git('rev-parse', 'HEAD').trim();
        await repo.refresher.refreshNow();
        await reg.setAutoUpdateIfRejected(true);
        try {
          const outcomes = await withPushChoice('cancel', () => pushFromDialog());
          const prompt = reg.lastPushRejectedPrompt();
          assert.ok(prompt, 'a remembered Rebase over merge commits must not run silently');
          assert.deepStrictEqual(prompt.buttons, ['Merge', 'Rebase Anyway']);
          assert.ok(prompt.detail.includes('Merge is highly recommended'), prompt.detail);
          assert.deepStrictEqual(outcomes, [`${branch} → ${REMOTE}/${branch}: rejected (fetch first)`]);
          assert.strictEqual(git('rev-parse', 'HEAD').trim(), head);
          assert.strictEqual(remoteHead(), theirs);
        } finally {
          await reg.setAutoUpdateIfRejected(false);
          git('branch', '-D', 'p14af-side');
        }
      });

      test('POST-P14af: an update that stops on conflicts cancels the push and leaves the merge to finish', async function () {
        this.timeout(120_000);
        const theirs = teammate(SHARED, 'push: theirs\n', 'P14af teammate, conflicting');
        localCommit(SHARED, 'push: mine\n', 'P14af mine, conflicting');
        await repo.refresher.refreshNow();
        try {
          const outcomes = await withPushChoice('merge', () => pushFromDialog());
          assert.strictEqual(outcomes.length, 1);
          assert.match(outcomes[0]!, /not pushed, the update stopped on conflicts/u, outcomes[0]);
          assert.strictEqual(remoteHead(), theirs, 'nothing is pushed over an unfinished merge');
          assert.ok(
            fs.existsSync(path.join(repo.dirs.gitDir, 'MERGE_HEAD')),
            'the merge is left in progress for the user to resolve',
          );
          // Answered Merge, so Merge is the default again from here on.
          assert.strictEqual(reg.rememberedUpdateStrategy(), 'merge');
        } finally {
          git('merge', '--abort');
          git('reset', '-q', '--hard', `${REMOTE}/${branch}`);
          await endConflicts();
        }
      });

      test('POST-P14af: a push anywhere but the upstream is only reported, never updated', async function () {
        this.timeout(90_000);
        // The remote's `p14af-elsewhere` holds a commit repoC has never seen.
        catchUpTeammate();
        fs.writeFileSync(path.join(workDir, 'p13-elsewhere.txt'), 'elsewhere\n');
        gitWithRetry(workDir, ['add', '--', 'p13-elsewhere.txt']);
        gitWithRetry(workDir, [
          '-c', 'user.name=Remote', '-c', 'user.email=remote@example.com',
          'commit', '-m', 'P14af elsewhere',
        ]);
        gitWithRetry(workDir, ['push', 'origin', 'HEAD:refs/heads/p14af-elsewhere']);
        const elsewhere = gitWithRetry(workDir, ['rev-parse', 'HEAD']).trim();
        catchUpTeammate();
        const mine = localCommit('p13/push-mine-f.txt', 'mine\n', 'P14af mine F');
        await repo.refresher.refreshNow();

        const outcomes = await withPushChoice('cancel', () => pushFromDialog('p14af-elsewhere'));
        assert.deepStrictEqual(outcomes, [
          `${branch} → ${REMOTE}/p14af-elsewhere: rejected (fetch first)`,
        ]);
        // IntelliJ updates only a branch pushed to the branch it tracks.
        assert.strictEqual(reg.lastPushRejectedPrompt(), undefined);
        assert.strictEqual(git('rev-parse', 'HEAD').trim(), mine);
        assert.strictEqual(remoteHead('p14af-elsewhere'), elsewhere);
      });

      // ---- POST-P14ah · Commit and Push opens the Push dialog first ---------------

      /**
       * One change committed in repoC through `gittree.commitAndPush` with the
       * repository named — a context menu's form — in whichever commit
       * paradigm an earlier suite left behind: ticked in changelists, staged
       * in staging. The Push dialog, if opened, is closed unanswered.
       */
      const commitAndPushRepoC = async (subject: string): Promise<void> => {
        const p3 = core.debugRegistry.get('phase03') as Phase03Registry;
        assert.ok(p3, 'phase03 registry missing');
        fs.writeFileSync(path.join(repoRoot, SHARED), `${subject}\n`);
        if (p3.paradigm.paradigm === 'staging') {
          git('add', '--', SHARED);
          await repo.refresher.refreshNow();
          await waitFor(
            () => repo.model.snapshot.statusEntries.some((e) => e.path === SHARED && isStaged(e)),
            20_000,
          );
        } else {
          await repo.refresher.refreshNow();
          const lists = p3.changelistsFor(repo);
          await waitFor(() => lists.getLists().some((l) => l.files.includes(SHARED)), 20_000);
          const list = lists.getLists().find((l) => l.files.includes(SHARED))!;
          lists.setListChecked(list.id, true);
        }
        p3.commitWindow.messageBoxFor(repo).value = subject;
        reg.clearLastPushDialogRequest();
        const saved = {
          checks: process.env['GITTREE_TEST_CHECKS_CHOICE'],
          dialog: process.env['GITTREE_TEST_PUSH_DIALOG'],
        };
        process.env['GITTREE_TEST_CHECKS_CHOICE'] = 'anyway';
        process.env['GITTREE_TEST_PUSH_DIALOG'] = 'cancel';
        try {
          await vscode.commands.executeCommand('gittree.commitAndPush', repo.root);
        } finally {
          if (saved.checks === undefined) delete process.env['GITTREE_TEST_CHECKS_CHOICE'];
          else process.env['GITTREE_TEST_CHECKS_CHOICE'] = saved.checks;
          if (saved.dialog === undefined) delete process.env['GITTREE_TEST_PUSH_DIALOG'];
          else process.env['GITTREE_TEST_PUSH_DIALOG'] = saved.dialog;
        }
        await waitFor(() => git('log', '-1', '--format=%s').trim() === subject, 30_000);
      };

      test('POST-P14ah: Commit and Push opens the Push dialog for what it committed, and pushes nothing itself', async function () {
        this.timeout(90_000);
        const before = remoteHead();
        await commitAndPushRepoC('P14ah commit and push, dialog');
        // IntelliJ's default, *Show Push dialog for Commit and Push*: the
        // dialog decides, so the commit is local until the user pushes it.
        assert.deepStrictEqual(reg.lastPushDialogRequest(), [repo.root]);
        assert.strictEqual(remoteHead(), before, 'nothing is pushed before the dialog says so');
      });

      test('POST-P14ah: with the setting off, Commit and Push pushes straight away', async function () {
        this.timeout(90_000);
        await reg.setShowPushDialogForCommitAndPush(false);
        try {
          await commitAndPushRepoC('P14ah commit and push, direct');
        } finally {
          await reg.setShowPushDialogForCommitAndPush(undefined);
        }
        assert.strictEqual(reg.lastPushDialogRequest(), undefined, 'no dialog with the setting off');
        assert.strictEqual(remoteHead(), git('rev-parse', 'HEAD').trim(), 'the commit reached the remote');
      });
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

    test('POST-P14k: the Git tool window pane lists the same worktrees, per repository', async function () {
      this.timeout(120_000);
      // JetBrains keeps this list in the Git tool window, so the pane bridge
      // is what the user actually sees now. It must agree with the service the
      // (hidden) tree view used, and it must group by repository.
      const logView = (
        core.debugRegistry.get('phase04') as { logView: { worktreesBridge: WorktreesBridgeShape } }
      ).logView;
      const panePath = path.join(tmpDir, 'wt-pane').replace(/\\/g, '/');
      const paneBranch = 'p14k/pane-wt';
      const service = reg.worktrees.serviceFor(repo);
      const created = await service.add({
        path: panePath,
        mode: 'new',
        ref: branch,
        newBranch: paneBranch,
        noCheckout: false,
        force: false,
      });
      assert.ok(created.ok, created.message);
      try {
        const state = await logView.worktreesBridge.buildState();
        const group = state.repos.find(
          (r) => r.root.replace(/\\/g, '/').toLowerCase() === repo.root.replace(/\\/g, '/').toLowerCase(),
        );
        assert.ok(group, `no group for ${repo.root}: ${JSON.stringify(state.repos.map((r) => r.root))}`);
        const mine = group.worktrees.find(
          (w) => w.path.replace(/\\/g, '/').toLowerCase() === panePath.toLowerCase(),
        );
        assert.ok(mine, `pane did not list the worktree: ${JSON.stringify(group.worktrees.map((w) => w.path))}`);
        assert.strictEqual(mine.branch, paneBranch);
        assert.strictEqual(mine.isMain, false);
        // The main worktree is always row one, which is what the pane relies on
        // to disable Remove on it.
        assert.strictEqual(group.worktrees[0]?.isMain, true);

        // A row acted on after the list moved is dropped, not misapplied — the
        // pane holds paths, never live handles.
        await logView.worktreesBridge.dispatch({
          action: 'remove',
          repoRoot: repo.root,
          path: path.join(tmpDir, 'wt-never-existed').replace(/\\/g, '/'),
        });
        assert.ok(fs.existsSync(panePath), 'a stale row must not remove a live worktree');
      } finally {
        await service.remove(panePath, true);
        try {
          git('branch', '-D', paneBranch);
        } catch {
          /* already gone */
        }
      }
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
