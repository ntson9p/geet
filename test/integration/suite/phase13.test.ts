import * as assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Core, RepoHandle } from '../../../src/core/core';
import type { Phase13Registry } from '../../../src/scm/dialogs/register';
import { PUSH_DIALOG_METHODS, type PushRepoSectionDto } from '../../../src/shared/protocol';
import { activateGitTree, gitWithRetry, waitFor, workspaceRepoC } from '../setup';

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

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gittree-p13-'));
    bareUrl = path.join(tmpDir, 'remote.git').replace(/\\/g, '/');
    execFileSync('git', ['init', '--bare', bareUrl], { cwd: tmpDir, encoding: 'utf8' });
    git('remote', 'add', REMOTE, bareUrl);
    await repo.refresher.refreshNow();
    await waitFor(() => repo.model.snapshot.headRef !== undefined, 15_000);
    branch = repo.model.snapshot.headRef!;
  });

  suiteTeardown(function () {
    this.timeout(30_000);
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
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });

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

    // The runner sets AUTOCONFIRM=1 for the whole harness: restore it exactly,
    // never `delete` it, or every later suite loses its auto-accept.
    const savedConfirm = process.env['GITTREE_TEST_AUTOCONFIRM'];
    const restoreConfirm = (): void => {
      if (savedConfirm === undefined) delete process.env['GITTREE_TEST_AUTOCONFIRM'];
      else process.env['GITTREE_TEST_AUTOCONFIRM'] = savedConfirm;
    };

    // Declined: nothing runs at all.
    const beforeDecline = core.commandLog.entries().at(-1)?.seq ?? 0;
    process.env['GITTREE_TEST_AUTOCONFIRM'] = '0';
    try {
      assert.deepStrictEqual(await force(), []);
    } finally {
      restoreConfirm();
    }
    assert.strictEqual(
      core.commandLog.entriesAfter(beforeDecline).filter((e) => e.argv[0] === 'push').length,
      0,
      'a declined force push must not reach git',
    );

    // Accepted: the lease flag is there, and never a bare --force.
    const beforeAccept = core.commandLog.entries().at(-1)?.seq ?? 0;
    process.env['GITTREE_TEST_AUTOCONFIRM'] = '1';
    let outcomes: string[];
    try {
      outcomes = await force();
    } finally {
      restoreConfirm();
    }
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
});
