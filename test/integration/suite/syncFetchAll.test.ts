import * as assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { Core, RepoHandle } from '../../../src/core/core';
import { activateGitTree, gitWithRetry, waitFor, workspaceRepoD, workspaceRepoE } from '../setup';

/**
 * POST-P14o — Fetch is project-wide, as IntelliJ's is.
 *
 * `gittree.fetch` with no argument fetches **every** root (the branches-popup
 * header button and the palette entry both take that path); with an explicit
 * root it still fetches only that one, which is how every in-product caller
 * that knows what it means keeps its narrow behaviour.
 *
 * Remotes are local bare repositories in the temp dir — no network, no
 * accounts, nothing outside this machine.
 */
suite('POST-P14o fetch across roots', () => {
  let core: Core;
  const scratch: string[] = [];

  interface Wired {
    root: string;
    repo: RepoHandle;
    remote: string;
    clone: string;
    branch: string;
  }
  let d: Wired;
  let e: Wired;

  const cli = (cwd: string, ...args: string[]): string => gitWithRetry(cwd, args);

  /** A root with a local bare remote and a clone to push new commits from. */
  function wire(root: string, tag: string): Wired {
    const remote = fs.mkdtempSync(path.join(os.tmpdir(), `gittree-${tag}-remote-`));
    scratch.push(remote);
    execFileSync('git', ['init', '--bare'], { cwd: remote });
    const branch = cli(root, 'rev-parse', '--abbrev-ref', 'HEAD').trim();
    execFileSync('git', ['symbolic-ref', 'HEAD', `refs/heads/${branch}`], { cwd: remote });
    cli(root, 'remote', 'add', 'origin', remote);
    cli(root, 'push', '-u', 'origin', branch);

    const cloneDir = fs.mkdtempSync(path.join(os.tmpdir(), `gittree-${tag}-clone-`));
    scratch.push(cloneDir);
    execFileSync('git', ['clone', remote, 'c'], { cwd: cloneDir });
    const clone = path.join(cloneDir, 'c');
    cli(clone, 'config', 'user.email', 't@t.dev');
    cli(clone, 'config', 'user.name', 'T');
    return { root, repo: core.repoForPath(root)!, remote, clone, branch };
  }

  /** Advances the remote by one commit; returns the sha a fetch should bring. */
  function advance(w: Wired, message: string): string {
    fs.writeFileSync(path.join(w.clone, `${message.replace(/\W/gu, '')}.txt`), `${message}\n`);
    cli(w.clone, 'add', '.');
    cli(w.clone, 'commit', '-m', message);
    cli(w.clone, 'push');
    return cli(w.clone, 'rev-parse', 'HEAD').trim();
  }

  /** What the root's remote-tracking ref actually points at right now. */
  function trackedSha(w: Wired): string {
    try {
      return cli(w.root, 'rev-parse', `origin/${w.branch}`).trim();
    } catch {
      return '';
    }
  }

  suiteSetup(async function () {
    this.timeout(120_000);
    core = await activateGitTree();
    d = wire(workspaceRepoD(), 'p14m-d');
    e = wire(workspaceRepoE(), 'p14m-e');
    assert.ok(d.repo && e.repo, 'repoD/repoE not discovered');
    await d.repo.refresher.refreshNow();
    await e.repo.refresher.refreshNow();
  });

  suiteTeardown(function () {
    this.timeout(60_000);
    // Leave repoD/repoE as the other suites expect to find them.
    for (const w of [d, e]) {
      if (!w) continue;
      try {
        cli(w.root, 'remote', 'remove', 'origin');
      } catch {
        /* already gone */
      }
      try {
        cli(w.root, 'branch', '--unset-upstream');
      } catch {
        /* no upstream left to unset */
      }
    }
    for (const dir of scratch) {
      try {
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
      } catch {
        /* Windows file locks — temp dir, safe to leave behind */
      }
    }
  });

  test('no argument fetches EVERY root, not the one the editor happens to be in', async function () {
    this.timeout(120_000);
    const wantD = advance(d, 'incoming d one');
    const wantE = advance(e, 'incoming e one');
    assert.notStrictEqual(trackedSha(d), wantD, 'repoD already had the commit before fetching');
    assert.notStrictEqual(trackedSha(e), wantE, 'repoE already had the commit before fetching');

    await vscode.commands.executeCommand('gittree.fetch');

    await waitFor(() => trackedSha(d) === wantD && trackedSha(e) === wantE, 60_000);
    assert.strictEqual(trackedSha(d), wantD);
    assert.strictEqual(trackedSha(e), wantE);
  });

  test('an explicit root still fetches only that root', async function () {
    this.timeout(120_000);
    const wantD = advance(d, 'incoming d two');
    const wantE = advance(e, 'incoming e two');
    const beforeE = trackedSha(e);

    await vscode.commands.executeCommand('gittree.fetch', d.root);

    await waitFor(() => trackedSha(d) === wantD, 60_000);
    assert.strictEqual(trackedSha(d), wantD, 'the named root was not fetched');
    assert.strictEqual(trackedSha(e), beforeE, 'a root nobody named was fetched anyway');
    assert.notStrictEqual(trackedSha(e), wantE);

    // Put repoE back in step so the next test starts from a known place.
    await vscode.commands.executeCommand('gittree.fetch', e.root);
    await waitFor(() => trackedSha(e) === wantE, 60_000);
  });

  test('gittree.fetch.all is the same fan-out under its own id', async function () {
    this.timeout(120_000);
    const wantD = advance(d, 'incoming d three');
    const wantE = advance(e, 'incoming e three');

    await vscode.commands.executeCommand('gittree.fetch.all');

    await waitFor(() => trackedSha(d) === wantD && trackedSha(e) === wantE, 60_000);
    assert.strictEqual(trackedSha(d), wantD);
    assert.strictEqual(trackedSha(e), wantE);
  });

  test('roots with no remote are skipped, not failed', async function () {
    this.timeout(120_000);
    // repoB and repoC carry no remote: a fetch there could only ever say
    // "No remote repository specified", which is noise in a mixed workspace.
    const remoteless = core.repos.filter((r) => {
      try {
        return cli(r.root, 'remote').trim().length === 0;
      } catch {
        return false;
      }
    });
    assert.ok(remoteless.length > 0, 'expected at least one remote-less root in the workspace');
    const before = remoteless.map((r) => r.model.snapshot.lastFetchAt);

    const wantD = advance(d, 'incoming d four');
    await vscode.commands.executeCommand('gittree.fetch');
    await waitFor(() => trackedSha(d) === wantD, 60_000);

    remoteless.forEach((r, i) => {
      assert.strictEqual(
        r.model.snapshot.lastFetchAt,
        before[i],
        `${path.basename(r.root)} has no remote and must not have been fetched`,
      );
    });
  });

  test('an explicit root with no remote says so instead of failing, and fetches nothing', async function () {
    this.timeout(60_000);
    // The Branches section offers every repository its own Fetch, remote or not.
    // git's "No remote repository specified" would arrive as an error dialog
    // that waits on a button; this has to return, untouched and unblocked.
    const remoteless = core.repos.find((r) => {
      try {
        return cli(r.root, 'remote').trim().length === 0;
      } catch {
        return false;
      }
    });
    assert.ok(remoteless, 'expected a remote-less root in the workspace');
    const before = remoteless.model.snapshot.lastFetchAt;

    await vscode.commands.executeCommand('gittree.fetch', remoteless.root);

    assert.strictEqual(remoteless.model.snapshot.lastFetchAt, before, 'a root with no remote was fetched');
  });

  test('the fan-out records a fetch time on every root it touched', async function () {
    this.timeout(120_000);
    advance(d, 'incoming d five');
    advance(e, 'incoming e five');
    const beforeD = d.repo.model.snapshot.lastFetchAt ?? 0;
    const beforeE = e.repo.model.snapshot.lastFetchAt ?? 0;

    await vscode.commands.executeCommand('gittree.fetch');

    await waitFor(
      () =>
        (d.repo.model.snapshot.lastFetchAt ?? 0) > beforeD &&
        (e.repo.model.snapshot.lastFetchAt ?? 0) > beforeE,
      60_000,
    );
  });
});
