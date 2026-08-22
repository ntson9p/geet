import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { Phase03Registry } from '../../../src/commit/register';
import type { RepoHandle } from '../../../src/core/core';
import { canonicalKey } from '../../../src/core/repoDiscovery';
import type { Phase01Registry } from '../../../src/scm/register';
import {
  activateGitTree,
  gitWithRetry,
  useCommitWindow,
  waitFor,
  workspaceRepoC,
} from '../setup';

/**
 * P11-T2 acceptance for the commit tool window's host half: the surface
 * switch, the message box that replaces the SCM input box, and the state the
 * webview renders. Runs last (phase11 sorts after phase10) and pins the
 * `webview` surface; phase01/03/05 pin `native` for the fallback path.
 */
suite('P11 commit tool window', () => {
  let repoRoot: string;
  let fsRoot: string;
  let repo: RepoHandle;
  let reg: Phase03Registry;
  let scmInput: vscode.SourceControlInputBox;

  const git = (...args: string[]): string => gitWithRetry(repoRoot, args);
  const write = (rel: string, content: string): void => {
    const p = path.join(repoRoot, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  };
  const refresh = async (): Promise<void> => repo.refresher.refreshNow();

  suiteSetup(async function () {
    this.timeout(60_000);
    repoRoot = workspaceRepoC();
    const core = await activateGitTree();
    repo = core.repoForPath(repoRoot)!;
    assert.ok(repo, 'repoC not discovered');
    fsRoot = repo.root;
    reg = core.debugRegistry.get('phase03') as Phase03Registry;
    assert.ok(reg, 'phase03 registry missing');
    const phase01 = core.debugRegistry.get('phase01') as Phase01Registry;
    scmInput = phase01.sourceControls.get(canonicalKey(repoRoot))!.sc.inputBox;

    await useCommitWindow('webview');
    if (reg.paradigm.paradigm !== 'changelists') {
      await reg.paradigm.switch();
      await waitFor(() => reg.paradigm.paradigm === 'changelists', 10_000);
    }
  });

  suiteTeardown(async () => {
    await useCommitWindow('native');
  });

  test('T2: webview is the default surface and hides the SCM input box', async function () {
    this.timeout(30_000);
    assert.strictEqual(reg.commitWindowMode(), 'webview');
    // The commit window owns the message now; leaving a second input box on
    // screen would give the user two places to type.
    await waitFor(() => scmInput.visible === false, 10_000);
  });

  test('T2: state carries changelist groups, counts and checked flags', async function () {
    this.timeout(60_000);
    write('p11/alpha.txt', 'alpha\n');
    write('p11/beta.txt', 'beta\n');
    git('add', 'p11/alpha.txt', 'p11/beta.txt');
    git('commit', '-m', 'p11 seed');
    write('p11/alpha.txt', 'alpha changed\n');
    write('p11/beta.txt', 'beta changed\n');
    await refresh();

    await waitFor(() => {
      const s = reg.commitWindow.buildState();
      const group = s.repos.find((r) => canonicalKey(r.root) === canonicalKey(fsRoot))?.groups[0];
      return (
        group !== undefined &&
        group.changes.some((c) => c.path === 'p11/alpha.txt') &&
        group.changes.some((c) => c.path === 'p11/beta.txt')
      );
    }, 20_000);

    const state = reg.commitWindow.buildState();
    const repoDto = state.repos.find((r) => canonicalKey(r.root) === canonicalKey(fsRoot))!;
    const group = repoDto.groups[0]!;
    assert.ok(group.checkable, 'the default changelist must be checkable');
    const alpha = group.changes.find((c) => c.path === 'p11/alpha.txt')!;
    assert.strictEqual(alpha.kind, 'modified');
    assert.ok(alpha.checked, 'newly adopted changes arrive checked, as in IntelliJ');

    // Unchecking through the service is what the webview's tri-state renders.
    reg.changelistsFor(repo).setChecked(['p11/alpha.txt'], false);
    const after = reg.commitWindow.buildState();
    const alphaAfter = after.repos
      .find((r) => canonicalKey(r.root) === canonicalKey(fsRoot))!
      .groups[0]!.changes.find((c) => c.path === 'p11/alpha.txt')!;
    assert.strictEqual(alphaAfter.checked, false);
    assert.ok(after.checkedCount < state.checkedCount, 'checkedCount must follow the service');
    reg.changelistsFor(repo).setChecked(['p11/alpha.txt'], true);
  });

  test('T2: unversioned files are reported but not yet checkable (P11-T3 fixes this)', async function () {
    this.timeout(30_000);
    write('p11/untracked.txt', 'new\n');
    await refresh();
    await waitFor(() => {
      const s = reg.commitWindow.buildState();
      return s.repos
        .find((r) => canonicalKey(r.root) === canonicalKey(fsRoot))!
        .groups.some((g) => g.id === '__unversioned__');
    }, 20_000);
    const group = reg.commitWindow
      .buildState()
      .repos.find((r) => canonicalKey(r.root) === canonicalKey(fsRoot))!
      .groups.find((g) => g.id === '__unversioned__')!;
    assert.strictEqual(group.checkable, false);
    assert.ok(group.changes.some((c) => c.path === 'p11/untracked.txt'));
    fs.rmSync(path.join(repoRoot, 'p11/untracked.txt'));
    await refresh();
  });

  test('T2: the window message box drives the shared commit flow', async function () {
    this.timeout(60_000);
    const before = git('rev-parse', 'HEAD').trim();
    // The SCM input box is deliberately left empty: if the flow still read it,
    // the commit would be refused for an empty message.
    scmInput.value = '';
    reg.commitWindow.messageBoxFor(repo).value = 'p11 commit from the tool window';
    assert.strictEqual(reg.commitWindow.getMessage(repo), 'p11 commit from the tool window');

    process.env['GITTREE_TEST_CHECKS_CHOICE'] = 'anyway';
    try {
      await vscode.commands.executeCommand('gittree.commit', repoRoot);
    } finally {
      delete process.env['GITTREE_TEST_CHECKS_CHOICE'];
    }
    await waitFor(() => git('rev-parse', 'HEAD').trim() !== before, 30_000);
    assert.strictEqual(git('log', '-1', '--format=%s').trim(), 'p11 commit from the tool window');
    // Post-commit clear goes through the same box.
    assert.strictEqual(reg.commitWindow.getMessage(repo), '');
  });

  test('T2: switching to native restores the SCM input box without a reload', async function () {
    this.timeout(30_000);
    await useCommitWindow('native');
    assert.strictEqual(reg.commitWindowMode(), 'native');
    await waitFor(() => scmInput.visible === true, 10_000);

    await useCommitWindow('webview');
    assert.strictEqual(reg.commitWindowMode(), 'webview');
    await waitFor(() => scmInput.visible === false, 10_000);
  });

  test('T2: the toggle command flips the surface', async function () {
    this.timeout(30_000);
    await vscode.commands.executeCommand('gittree.commit.window.toggle');
    await waitFor(() => reg.commitWindowMode() === 'native', 10_000);
    await vscode.commands.executeCommand('gittree.commit.window.toggle');
    await waitFor(() => reg.commitWindowMode() === 'webview', 10_000);
  });
});
