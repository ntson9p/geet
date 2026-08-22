import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { Phase03Registry } from '../../../src/commit/register';
import { computeFileDiff } from '../../../src/commit/window/fileDiff';
import type { RepoHandle } from '../../../src/core/core';
import type { LineChange } from '../../../src/core/patch/patchBuilder';
import { canonicalKey } from '../../../src/core/repoDiscovery';
import type { Phase01Registry } from '../../../src/scm/register';
import { COMMIT_METHODS } from '../../../src/shared/protocol';
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
  const groupOf = (id: string) =>
    reg.commitWindow
      .buildState()
      .repos.find((r) => canonicalKey(r.root) === canonicalKey(fsRoot))!
      .groups.find((g) => g.id === id)!;
  const changeOf = (groupId: string, relPath: string) =>
    groupOf(groupId).changes.find((c) => c.path === relPath);
  /**
   * Tests that narrow the commit to one file have to hand the default state
   * back, or the next test commits nothing and fails for the wrong reason.
   */
  const restoreChecked = (): void => reg.changelistsFor(repo).setListChecked('default', true);

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

  test('T2: the view actually resolves in the SCM container', async function () {
    this.timeout(30_000);
    // Registration alone proves nothing — a WebviewViewProvider only resolves
    // when its view becomes visible, and that is the one seam the mocked
    // Playwright suite cannot cover.
    await vscode.commands.executeCommand('gittree.commit.focus');
    await waitFor(() => reg.commitWindow.isResolved, 15_000);
    // A push with a live view must reach the webview instead of no-opping.
    reg.commitWindow.push();
    assert.ok(
      reg.commitWindow.debugTrail.some((l) => l.startsWith('push ')),
      `expected a push to reach the webview, trail: ${reg.commitWindow.debugTrail.join(' | ')}`,
    );
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

  test('T3: every intent the webview posts has a host handler', async function () {
    this.timeout(30_000);
    await vscode.commands.executeCommand('gittree.commit.focus');
    await waitFor(() => reg.commitWindow.isResolved, 15_000);
    // `on()` and `onEvent()` feed different routers. P11-T2 registered these
    // with `on()` while the webview posted them as events, so every intent but
    // `init` was answered by nobody — silently. Both halves are asserted now:
    // here that a handler exists, and in commit.spec.ts that the webview posts
    // requests.
    for (const [name, method] of Object.entries(COMMIT_METHODS)) {
      if (name === 'evtState') continue; // host → webview
      assert.ok(reg.commitWindow.hasHandler(method), `no host handler for ${method}`);
    }
  });

  test('T3: ticking an untracked file commits it and leaves the rest unversioned', async function () {
    this.timeout(60_000);
    write('p11/take-me.txt', 'take\n');
    write('p11/leave-me.txt', 'leave\n');
    await refresh();
    const service = reg.changelistsFor(repo);
    await waitFor(
      () =>
        service.unversioned().includes('p11/take-me.txt') &&
        service.unversioned().includes('p11/leave-me.txt'),
      20_000,
    );

    const group = groupOf('__unversioned__');
    assert.strictEqual(group.checkable, true, 'Unversioned Files must be tickable now');
    assert.ok(
      group.changes.every((c) => !c.checked),
      'untracked files start unticked, as in IntelliJ',
    );

    // Only the one untracked file goes in.
    service.setListChecked('default', false);
    service.setChecked(['p11/take-me.txt'], true);
    const before = git('rev-parse', 'HEAD').trim();
    reg.commitWindow.messageBoxFor(repo).value = 'p11 add one untracked file';
    process.env['GITTREE_TEST_CHECKS_CHOICE'] = 'anyway';
    try {
      await vscode.commands.executeCommand('gittree.commit', repoRoot);
    } finally {
      delete process.env['GITTREE_TEST_CHECKS_CHOICE'];
    }
    await waitFor(() => git('rev-parse', 'HEAD').trim() !== before, 30_000);

    const tree = git('ls-tree', '-r', '--name-only', 'HEAD');
    assert.ok(tree.includes('p11/take-me.txt'), 'the ticked untracked file must be committed');
    assert.ok(!tree.includes('p11/leave-me.txt'), 'an unticked untracked file must stay out');
    assert.ok(
      git('status', '--porcelain').includes('?? p11/leave-me.txt'),
      'the unticked file must still be sitting in the worktree, untracked',
    );

    fs.rmSync(path.join(repoRoot, 'p11/leave-me.txt'));
    await refresh();
    restoreChecked();
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

  /**
   * Seeds a committed base file, rewrites it with three separate changes, and
   * returns the change list the inclusion model keys on.
   */
  async function seedThreeChanges(
    rel: string,
    eol: '\n' | '\r\n',
  ): Promise<{ modified: string; changes: LineChange[] }> {
    const base = ['l1', 'l2', 'l3', 'l4', 'l5', 'l6', 'l7'].join(eol) + eol;
    const modified = ['l1', 'X2', 'l3', 'X4', 'l5', 'X6', 'l7'].join(eol) + eol;
    write(rel, base);
    git('add', rel);
    git('commit', '-m', `seed ${rel}`);
    write(rel, modified);
    await refresh();
    await waitFor(() => reg.changelistsFor(repo).isChecked(rel), 20_000);
    const diff = await computeFileDiff(repo, rel);
    assert.strictEqual(diff.changes.length, 3, `expected 3 changes in ${rel}`);
    return { modified, changes: diff.changes };
  }

  async function commitNow(message: string): Promise<string> {
    const before = git('rev-parse', 'HEAD').trim();
    reg.commitWindow.messageBoxFor(repo).value = message;
    process.env['GITTREE_TEST_CHECKS_CHOICE'] = 'anyway';
    try {
      await vscode.commands.executeCommand('gittree.commit', repoRoot);
    } finally {
      delete process.env['GITTREE_TEST_CHECKS_CHOICE'];
    }
    await waitFor(() => git('rev-parse', 'HEAD').trim() !== before, 30_000);
    return git('rev-parse', 'HEAD').trim();
  }

  test('T3: only the ticked change is committed; the rest stay byte-identical', async function () {
    this.timeout(90_000);
    const rel = 'p11/three.txt';
    const { modified, changes } = await seedThreeChanges(rel, '\n');

    const service = reg.changelistsFor(repo);
    service.setListChecked('default', false);
    service.setChecked([rel], true);
    // Middle change only.
    reg.inclusion.set(canonicalKey(fsRoot), rel, changes, [1]);
    assert.deepStrictEqual(changeOf('default', rel)?.partial, { total: 3, included: 1 });

    await commitNow('p11 commit the middle change only');

    // `git commit --only` would have taken the whole worktree file; the
    // temp-index path is what makes this assertion possible at all.
    assert.strictEqual(
      git('show', `HEAD:${rel}`),
      ['l1', 'l2', 'l3', 'X4', 'l5', 'l6', 'l7'].join('\n') + '\n',
      'HEAD must hold exactly the ticked change',
    );
    // The worktree keeps everything, down to the byte.
    assert.strictEqual(
      fs.readFileSync(path.join(repoRoot, rel), 'utf8'),
      modified,
      'the two unticked changes must still be in the worktree, untouched',
    );
    // And the residue is exactly those two changes, still pending.
    const residue = git('diff', '--', rel);
    assert.ok(residue.includes('+X2') && residue.includes('+X6'), residue);
    assert.ok(!residue.includes('+X4'), 'the committed change must not still be pending');
    restoreChecked();
  });

  test('T3: a CRLF file round-trips with no EOL damage', async function () {
    this.timeout(90_000);
    // autocrlf off so "byte-identical" means bytes, not git's normalisation.
    git('config', 'core.autocrlf', 'false');
    const rel = 'p11/crlf.txt';
    const { changes } = await seedThreeChanges(rel, '\r\n');
    const worktreeBefore = fs.readFileSync(path.join(repoRoot, rel));

    const service = reg.changelistsFor(repo);
    service.setListChecked('default', false);
    service.setChecked([rel], true);
    reg.inclusion.set(canonicalKey(fsRoot), rel, changes, [1]);

    await commitNow('p11 commit one CRLF change');

    assert.strictEqual(
      git('show', `HEAD:${rel}`),
      ['l1', 'l2', 'l3', 'X4', 'l5', 'l6', 'l7'].join('\r\n') + '\r\n',
      'CRLF must survive the patch round trip',
    );
    assert.ok(
      fs.readFileSync(path.join(repoRoot, rel)).equals(worktreeBefore),
      'the worktree file must be byte-identical, CR included',
    );
    restoreChecked();
  });

  test('T3: a selection that no longer lines up commits the whole file instead', async function () {
    this.timeout(90_000);
    const rel = 'p11/stale.txt';
    const { changes } = await seedThreeChanges(rel, '\n');

    const service = reg.changelistsFor(repo);
    service.setListChecked('default', false);
    service.setChecked([rel], true);
    reg.inclusion.set(canonicalKey(fsRoot), rel, changes, [1]);

    // An external edit above the hunks renumbers every change.
    write(rel, ['inserted', 'l1', 'X2', 'l3', 'X4', 'l5', 'X6', 'l7'].join('\n') + '\n');
    await refresh();
    const fresh = await computeFileDiff(repo, rel);
    assert.ok(
      reg.inclusion.isStale(canonicalKey(fsRoot), rel, fresh.changes),
      'the selection must be recognised as stale',
    );

    await commitNow('p11 stale selection falls back to whole file');

    // Applying the old indices would have committed the wrong lines. Falling
    // back to the whole file is the safe answer, and it is what happens.
    assert.strictEqual(
      git('show', `HEAD:${rel}`),
      ['inserted', 'l1', 'X2', 'l3', 'X4', 'l5', 'X6', 'l7'].join('\n') + '\n',
    );
    assert.strictEqual(git('diff', '--', rel), '', 'nothing should be left pending');
    restoreChecked();
  });

  test('T3: a whole-file selection is stored as no selection at all', async function () {
    this.timeout(60_000);
    const rel = 'p11/whole.txt';
    const { changes } = await seedThreeChanges(rel, '\n');
    const key = canonicalKey(fsRoot);

    reg.inclusion.set(key, rel, changes, [0, 2]);
    assert.deepStrictEqual(changeOf('default', rel)?.partial, { total: 3, included: 2 });

    reg.inclusion.set(key, rel, changes, [0, 1, 2]);
    assert.strictEqual(
      changeOf('default', rel)?.partial,
      undefined,
      '"all of it" and "the whole file" must be one state',
    );

    // Unticking the file discards the selection, so re-ticking means everything.
    reg.inclusion.set(key, rel, changes, [1]);
    reg.changelistsFor(repo).setChecked([rel], false);
    reg.inclusion.clear(key, rel);
    assert.strictEqual(changeOf('default', rel)?.partial, undefined);

    git('checkout', '--', rel);
    await refresh();
    restoreChecked();
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
