import * as assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { canonicalKey } from '../../../src/core/repoDiscovery';
import { activateGitTree, gitWithRetry, useCommitWindow, waitFor, workspaceRepoA } from '../setup';

/**
 * Phase 1 acceptance: SCM groups, rev provider, file ops, commit MVP,
 * status-bar widget + sync against a local bare remote.
 * Runs against workspace repoA (safe: the discovery suite runs earlier).
 * Each test seeds and cleans up its own repo state.
 */
suite('P1 core SCM', () => {
  let repoRoot: string;

  const git = (...args: string[]): string => gitWithRetry(repoRoot, args);

  const write = (rel: string, content: string): void =>
    fs.writeFileSync(path.join(repoRoot, rel), content);

  interface Phase01RegistryShape {
    sourceControls: Map<
      string,
      {
        sc: vscode.SourceControl;
        mergeGroup: vscode.SourceControlResourceGroup;
        stagedGroup: vscode.SourceControlResourceGroup;
        changesGroup: vscode.SourceControlResourceGroup;
        untrackedGroup: vscode.SourceControlResourceGroup;
      }
    >;
    statusBars: Map<string, { update(): void }>;
  }

  async function scOf(root: string) {
    const core = await activateGitTree();
    const reg = core.debugRegistry.get('phase01') as Phase01RegistryShape | undefined;
    assert.ok(reg, 'phase01 registry missing — registerPhase01 not run?');
    const sc = reg.sourceControls.get(canonicalKey(root));
    assert.ok(sc, `no SourceControl for ${root}`);
    return sc;
  }

  async function refresh(): Promise<void> {
    const core = await activateGitTree();
    await core.repoForPath(repoRoot)!.refresher.refreshNow();
  }

  let coreCache: Awaited<ReturnType<typeof activateGitTree>> | undefined;
  const paradigmOf = (): string | undefined =>
    (coreCache?.debugRegistry.get('phase03') as { paradigm: { paradigm: string } } | undefined)
      ?.paradigm.paradigm;

  suiteSetup(async function () {
    this.timeout(60_000);
    repoRoot = workspaceRepoA();
    coreCache = await activateGitTree();
    // P11-T2: this suite asserts against the native SCM input box, so pin the
    // native commit surface. The webview surface has its own suite (phase11).
    await useCommitWindow('native');

    // Phase 3's changelists paradigm (the default) hides the staging groups
    // this suite asserts on — run it in staging mode.
    await vscode.workspace
      .getConfiguration('gittree')
      .update('commit.paradigm', 'staging', vscode.ConfigurationTarget.Workspace);
    await waitFor(() => paradigmOf() === 'staging', 10_000);
  });

  suiteTeardown(async function () {
    this.timeout(30_000);
    // Restore the default paradigm for the Phase 3 suite.
    await vscode.workspace
      .getConfiguration('gittree')
      .update('commit.paradigm', undefined, vscode.ConfigurationTarget.Workspace);
    await waitFor(() => paradigmOf() === 'changelists', 10_000);
  });

  test('T1: four groups populate with correct membership', async function () {
    this.timeout(60_000);

    // Conflict first (merge requires a clean index)…
    write('conflict.txt', 'base\n');
    git('add', 'conflict.txt');
    git('commit', '-m', 'conflict base');
    git('checkout', '-b', 'p1-side');
    write('conflict.txt', 'side\n');
    git('commit', '-am', 'side');
    git('checkout', '-');
    write('conflict.txt', 'main\n');
    git('commit', '-am', 'main');
    try {
      git('merge', 'p1-side');
    } catch {
      // expected conflict
    }
    // …then seed the other groups mid-merge (git add works during merges).
    write('staged.txt', 'staged content\n');
    git('add', 'staged.txt');
    fs.appendFileSync(path.join(repoRoot, 'README.md'), 'unstaged edit\n');
    write('untracked.txt', 'new\n');

    await refresh();
    const sc = await scOf(repoRoot);
    await waitFor(
      () =>
        sc.mergeGroup.resourceStates.length === 1 &&
        sc.stagedGroup.resourceStates.length === 1 &&
        sc.changesGroup.resourceStates.length === 1 &&
        sc.untrackedGroup.resourceStates.length === 1,
      15_000,
    );
    assert.strictEqual(sc.sc.count, 4);

    const mergeState = sc.mergeGroup.resourceStates[0]!;
    assert.match(mergeState.resourceUri.fsPath, /conflict\.txt$/);
    assert.ok(mergeState.contextValue?.startsWith('file:merge:'));
    const stagedState = sc.stagedGroup.resourceStates[0]!;
    assert.match(stagedState.resourceUri.fsPath, /staged\.txt$/);
    assert.strictEqual(stagedState.decorations?.strikeThrough, false);

    // Cleanup: resolve the merge (commits staged.txt too), restore the rest.
    git('add', 'conflict.txt');
    git('commit', '-m', 'resolve p1 conflict');
    git('branch', '-D', 'p1-side');
    git('restore', 'README.md');
    fs.rmSync(path.join(repoRoot, 'untracked.txt'));
    await refresh();
  });

  test('T2: gittree-rev provider serves index and HEAD content', async function () {
    this.timeout(30_000);
    await activateGitTree();
    write('t2-index.txt', 'index only\n');
    git('add', 't2-index.txt');

    const q = (rel: string, ref: string) =>
      vscode.Uri.from({
        scheme: 'gittree-rev',
        path: '/' + rel,
        query: JSON.stringify({ repo: repoRoot, rel, ref }),
      });
    const indexDoc = await vscode.workspace.openTextDocument(q('t2-index.txt', ':0'));
    assert.strictEqual(indexDoc.getText(), 'index only\n');
    const headDoc = await vscode.workspace.openTextDocument(q('t2-index.txt', 'HEAD'));
    assert.strictEqual(headDoc.getText(), ''); // not committed → empty original
    const readmeHead = await vscode.workspace.openTextDocument(q('README.md', 'HEAD'));
    assert.ok(readmeHead.getText().startsWith('# repoA'));

    git('rm', '--cached', '-q', 't2-index.txt');
    fs.rmSync(path.join(repoRoot, 't2-index.txt'));
    await refresh();
  });

  test('T4: stage / unstage / rollback via commands', async function () {
    this.timeout(60_000);
    const sc = await scOf(repoRoot);

    fs.appendFileSync(path.join(repoRoot, 'README.md'), 'unstaged edit\n');
    write('t4-untracked.txt', 'x\n');
    await refresh();
    await waitFor(
      () => sc.changesGroup.resourceStates.some((s) => s.resourceUri.fsPath.endsWith('README.md')),
      15_000,
    );

    // Stage via command.
    const changeState = sc.changesGroup.resourceStates.find((s) =>
      s.resourceUri.fsPath.endsWith('README.md'),
    )!;
    await vscode.commands.executeCommand('gittree.add', changeState);
    await refresh();
    await waitFor(
      () => sc.stagedGroup.resourceStates.some((s) => s.resourceUri.fsPath.endsWith('README.md')),
      15_000,
    );

    // Unstage via command.
    const stagedState = sc.stagedGroup.resourceStates.find((s) =>
      s.resourceUri.fsPath.endsWith('README.md'),
    )!;
    await vscode.commands.executeCommand('gittree.unstage', stagedState);
    await refresh();
    await waitFor(
      () => sc.changesGroup.resourceStates.some((s) => s.resourceUri.fsPath.endsWith('README.md')),
      15_000,
    );

    // Rollback (modal auto-confirmed in the test env) → file restored.
    const rollbackTarget = sc.changesGroup.resourceStates.find((s) =>
      s.resourceUri.fsPath.endsWith('README.md'),
    )!;
    await vscode.commands.executeCommand('gittree.rollbackFile', rollbackTarget);
    await waitFor(
      () => !fs.readFileSync(path.join(repoRoot, 'README.md'), 'utf8').includes('unstaged edit'),
      15_000,
    );

    // Rollback of an untracked file deletes it.
    await refresh();
    await waitFor(
      () => sc.untrackedGroup.resourceStates.some((s) => s.resourceUri.fsPath.endsWith('t4-untracked.txt')),
      15_000,
    );
    const untrackedState = sc.untrackedGroup.resourceStates.find((s) =>
      s.resourceUri.fsPath.endsWith('t4-untracked.txt'),
    )!;
    await vscode.commands.executeCommand('gittree.rollbackFile', untrackedState);
    await waitFor(() => !fs.existsSync(path.join(repoRoot, 't4-untracked.txt')), 15_000);
    await refresh();
  });

  test('T7: commit from the SCM input (staged + amend)', async function () {
    this.timeout(60_000);
    const sc = await scOf(repoRoot);
    write('t7.txt', 'commit me\n');
    git('add', 't7.txt');
    await refresh();
    const before = git('rev-parse', 'HEAD').trim();

    sc.sc.inputBox.value = 'p1 commit from scm input';
    await vscode.commands.executeCommand('gittree.commit', repoRoot);
    await waitFor(() => git('rev-parse', 'HEAD').trim() !== before, 15_000);
    assert.strictEqual(git('log', '-1', '--format=%s').trim(), 'p1 commit from scm input');
    assert.strictEqual(sc.sc.inputBox.value, '');

    sc.sc.inputBox.value = 'p1 amended message';
    await vscode.commands.executeCommand('gittree.commitAmend', repoRoot);
    await waitFor(() => git('log', '-1', '--format=%s').trim() === 'p1 amended message', 15_000);
    await refresh();
  });

  test('T5: status bar reflects divergence and sync round-trips', async function () {
    this.timeout(120_000);
    const core = await activateGitTree();
    const repo = core.repoForPath(repoRoot)!;
    const sc = await scOf(repoRoot);

    // Local bare remote + upstream.
    const remote = fs.mkdtempSync(path.join(os.tmpdir(), 'gittree-p1-remote-'));
    execFileSync('git', ['init', '--bare'], { cwd: remote });
    const branch = git('rev-parse', '--abbrev-ref', 'HEAD').trim();
    execFileSync('git', ['symbolic-ref', 'HEAD', `refs/heads/${branch}`], { cwd: remote });
    git('remote', 'add', 'origin', remote);
    git('push', '-u', 'origin', branch);

    // Diverge: 1 ahead (local), 2 behind (remote commits via clone).
    write('ahead.txt', 'ahead\n');
    git('add', 'ahead.txt');
    git('commit', '-m', 'local ahead');
    const cloneDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gittree-p1-clone-'));
    execFileSync('git', ['clone', remote, 'c'], { cwd: cloneDir });
    const clone = path.join(cloneDir, 'c');
    const cgit = (...args: string[]) => execFileSync('git', args, { cwd: clone, encoding: 'utf8' });
    cgit('config', 'user.email', 't@t.dev');
    cgit('config', 'user.name', 'T');
    for (const n of [1, 2]) {
      fs.writeFileSync(path.join(clone, `remote${n}.txt`), `${n}\n`);
      cgit('add', '.');
      cgit('commit', '-m', `remote ${n}`);
    }
    cgit('push');

    git('fetch');
    await refresh();
    await waitFor(
      () => (repo.model.snapshot.behind ?? 0) === 2 && (repo.model.snapshot.ahead ?? 0) === 1,
      15_000,
    );

    const syncTitle = sc.sc.statusBarCommands?.[1]?.title ?? '';
    assert.ok(syncTitle.includes('$(arrow-down) 2'), `sync title: ${syncTitle}`);
    assert.ok(syncTitle.includes('$(arrow-up) 1'), `sync title: ${syncTitle}`);
    const checkoutTitle = sc.sc.statusBarCommands?.[0]?.title ?? '';
    assert.ok(checkoutTitle.includes(branch), `checkout title: ${checkoutTitle}`);

    await vscode.commands.executeCommand('gittree.sync', repoRoot);
    await refresh();
    await waitFor(
      () => (repo.model.snapshot.ahead ?? 0) === 0 && (repo.model.snapshot.behind ?? 0) === 0,
      20_000,
    );
    const remoteLog = execFileSync('git', ['log', '--format=%s', branch], {
      cwd: remote,
      encoding: 'utf8',
    });
    assert.ok(remoteLog.includes('local ahead'));
  });

  test('T5: detached HEAD renders short sha in the widget', async function () {
    this.timeout(30_000);
    const core = await activateGitTree();
    const repo = core.repoForPath(repoRoot)!;
    const sc = await scOf(repoRoot);
    const branch = git('rev-parse', '--abbrev-ref', 'HEAD').trim();
    git('checkout', '--detach', 'HEAD');
    await refresh();
    await waitFor(() => repo.model.snapshot.detached, 15_000);
    const title = sc.sc.statusBarCommands?.[0]?.title ?? '';
    assert.ok(title.includes('$(git-commit)'), `widget: ${title}`);
    git('checkout', branch);
    await refresh();
  });
});
