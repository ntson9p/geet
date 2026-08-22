import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { Phase03Registry } from '../../../src/commit/register';
import { recentCommitMessages } from '../../../src/commit/messageHistory';
import { computeFileDiff } from '../../../src/commit/window/fileDiff';
import { applyOption, readOptions } from '../../../src/commit/window/options';
import type { ShelfBridge } from '../../../src/commit/window/shelfBridge';
import { signChanges } from '../../../src/commit/window/inclusion';
import type { Core } from '../../../src/core/core';
import { applyShelveResult, type ShelveDialogDeps } from '../../../src/shelf/shelveDialog';
import type { ShelfStore } from '../../../src/shelf/shelfStore';
import { UnshelveEngine } from '../../../src/shelf/unshelve';
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
  let shelfStore: ShelfStore;
  let shelfBridge: ShelfBridge;
  let coreRef: Core;

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
    coreRef = core;
    repo = core.repoForPath(repoRoot)!;
    assert.ok(repo, 'repoC not discovered');
    fsRoot = repo.root;
    reg = core.debugRegistry.get('phase03') as Phase03Registry;
    assert.ok(reg, 'phase03 registry missing');
    const phase01 = core.debugRegistry.get('phase01') as Phase01Registry;
    scmInput = phase01.sourceControls.get(canonicalKey(repoRoot))!.sc.inputBox;
    const phase07 = core.debugRegistry.get('phase07') as {
      getShelfStore: (root: string) => ShelfStore | undefined;
      shelfBridge: ShelfBridge;
    };
    shelfStore = phase07.getShelfStore(repoRoot)!;
    shelfBridge = phase07.shelfBridge;
    assert.ok(shelfStore && shelfBridge, 'phase07 shelf pieces missing');

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
      if (name.startsWith('evt')) continue; // host → webview
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

  test('T4: recent commits are served for the amend dropdown, body intact', async function () {
    this.timeout(60_000);
    // A commit with a real body — the thing worth reusing from the ▾ menu.
    write('p11/t4-body.txt', 'body\n');
    git('add', 'p11/t4-body.txt');
    git('commit', '-m', 't4 subject', '-m', 'body line two');

    const commits = await recentCommitMessages(repo, 5);
    assert.ok(commits.length >= 2, 'this suite has committed more than once by now');
    const head = commits[0]!;
    assert.match(head.sha, /^[0-9a-f]{40}$/);
    assert.strictEqual(head.shortSha, head.sha.slice(0, 8));
    assert.strictEqual(head.subject, 't4 subject');
    assert.strictEqual(
      head.message,
      't4 subject\n\nbody line two',
      'the multi-line body must survive the NUL/RS parse intact',
    );
    assert.strictEqual(commits[1]!.subject, git('log', '-1', '--skip=1', '--format=%s').trim());
  });

  test('T4: the message ring feeds the in-webview history dropdown', async function () {
    this.timeout(30_000);
    // Earlier commits in this suite went through the shared flow, which pushes
    // into the ring — the same data `commit/messageHistory` serves.
    const entries = await reg.history.entries(repo);
    assert.ok(entries.length > 0, 'the ring must hold this suite\'s earlier commit messages');
    assert.ok(
      entries.some((e) => e.message === 'p11 commit from the tool window'),
      `ring: ${entries.map((e) => JSON.stringify(e.message)).join(', ')}`,
    );
    assert.ok(
      entries.every((e) => typeof e.message === 'string' && typeof e.ts === 'number'),
      'each entry carries the full message and a timestamp for the relative-time label',
    );
  });

  test('T4: a programmatic message write reaches workspaceState immediately', function () {
    this.timeout(30_000);
    // The messageBox setter is the path history picks, amend prefill and the
    // post-commit clear all share; the webview editor hears it via evtMessage.
    reg.commitWindow.messageBoxFor(repo).value = 'programmatic write';
    assert.strictEqual(reg.commitWindow.getMessage(repo), 'programmatic write');
    reg.commitWindow.messageBoxFor(repo).value = '';
    assert.strictEqual(reg.commitWindow.getMessage(repo), '');
  });

  test('T5: gear options round-trip to settings and workspaceState', async function () {
    this.timeout(30_000);
    const store = reg.optionsStore;
    try {
      await applyOption(store, repo, { kind: 'author', value: 'Test Author <t@example.com>' });
      assert.strictEqual(store.getAuthor(repo), 'Test Author <t@example.com>');
      await applyOption(store, repo, { kind: 'signoff', value: true });
      assert.strictEqual(
        vscode.workspace.getConfiguration('gittree.commit').get('signoff'),
        true,
      );
      await applyOption(store, repo, { kind: 'deferAdvanced', value: false });
      const dto = await readOptions(store, repo);
      assert.strictEqual(dto.author, 'Test Author <t@example.com>');
      assert.strictEqual(dto.signoff, true);
      assert.strictEqual(dto.deferAdvanced, false);
      assert.ok(dto.authorSuggestions.length > 0, 'history-derived completion list');
      assert.ok(
        dto.authorSuggestions.every((a) => /<.+@.+>$/.test(a)),
        `suggestions: ${dto.authorSuggestions.slice(0, 3).join(' | ')}`,
      );
      await assert.rejects(
        applyOption(store, repo, { kind: 'author', value: 'nonsense' }),
        /Name <email/,
        'an invalid author must be refused, not stored',
      );
    } finally {
      await applyOption(store, repo, { kind: 'author', value: '' });
      await applyOption(store, repo, { kind: 'signoff', value: false });
      await vscode.workspace
        .getConfiguration('gittree.commit.checks')
        .update('deferAdvanced', undefined, vscode.ConfigurationTarget.Workspace);
    }
  });

  test('T5: author override and sign-off land on the commit itself', async function () {
    this.timeout(90_000);
    const store = reg.optionsStore;
    try {
      await applyOption(store, repo, { kind: 'author', value: 'Doe, John <doe@example.com>' });
      await applyOption(store, repo, { kind: 'signoff', value: true });
      write('p11/t5-author.txt', 'authored\n');
      git('add', 'p11/t5-author.txt');
      write('p11/t5-author.txt', 'authored more\n');
      await refresh();
      await waitFor(() => reg.changelistsFor(repo).isChecked('p11/t5-author.txt'), 20_000);

      await commitNow('t5 authored commit');

      assert.strictEqual(
        git('log', '-1', '--format=%an <%ae>').trim(),
        'Doe, John <doe@example.com>',
        'the --author override must reach the commit, comma intact',
      );
      assert.ok(
        git('log', '-1', '--format=%B').includes('Signed-off-by:'),
        'sign-off must append the DCO trailer',
      );
    } finally {
      await applyOption(store, repo, { kind: 'author', value: '' });
      await applyOption(store, repo, { kind: 'signoff', value: false });
      restoreChecked();
    }
  });

  test('T5: deferred advanced checks run after the commit and never gate it', async function () {
    this.timeout(90_000);
    const store = reg.optionsStore;
    const checks = vscode.workspace.getConfiguration('gittree.commit.checks');
    process.env['GITTREE_TEST_DEFERRED_CHECKS'] = '1';
    try {
      // Default assertion first: deferred-after is the IntelliJ-parity default.
      assert.strictEqual((await readOptions(store, repo)).deferAdvanced, true);
      // TODO check only — Analyze would sit in a diagnostics quiesce for seconds.
      await checks.update('analyze', false, vscode.ConfigurationTarget.Workspace);

      const rel = 'p11/t5-todo.txt';
      write(rel, 'plain line\n');
      git('add', rel);
      git('commit', '-m', 't5 todo base');
      write(rel, 'plain line\n// TODO deferred marker\n');
      await refresh();
      await waitFor(() => reg.changelistsFor(repo).isChecked(rel), 20_000);

      const before = git('rev-parse', 'HEAD').trim();
      reg.commitWindow.messageBoxFor(repo).value = 't5 deferred checks commit';
      // Deliberately NO GITTREE_TEST_CHECKS_CHOICE: a gating modal would hang
      // this test. Deferred mode must commit without asking anything.
      await vscode.commands.executeCommand('gittree.commit', repoRoot);
      await waitFor(() => git('rev-parse', 'HEAD').trim() !== before, 30_000);
      const newHead = git('rev-parse', 'HEAD').trim();

      assert.ok(reg.lastDeferredChecks !== undefined, 'the deferred run must be handed out');
      const outcome = await reg.lastDeferredChecks;
      assert.ok(outcome, 'deferred checks must actually run under the opt-in env');
      assert.strictEqual(
        outcome.headSha,
        newHead,
        'the checks must have run AFTER the commit landed',
      );
      assert.ok(
        outcome.failures.some((f) => f.message.includes('TODO')),
        `expected the TODO finding, got: ${JSON.stringify(outcome.failures)}`,
      );
    } finally {
      delete process.env['GITTREE_TEST_DEFERRED_CHECKS'];
      await checks.update('analyze', undefined, vscode.ConfigurationTarget.Workspace);
      restoreChecked();
    }
  });

  /** Shelve exactly one modified file through the real store. */
  async function seedShelf(name: string, rel: string): Promise<string> {
    write(rel, 'shelf base\n');
    git('add', rel);
    git('commit', '-m', `seed ${rel}`);
    write(rel, 'shelf changed\n');
    await refresh();
    const res = await shelfStore.shelve({ name, paths: [rel], removeFromWorktree: true });
    assert.ok(res.removed, 'the shelve must have reverted the worktree');
    assert.strictEqual(fs.readFileSync(path.join(repoRoot, rel), 'utf8'), 'shelf base\n');
    await refresh();
    return res.meta.id;
  }

  const dropChangelist = (name: string): void => {
    const service = reg.changelistsFor(repo);
    const list = service.getLists().find((l) => l.name === name);
    if (list) service.remove(list.id);
  };

  test('T6: every tree-view shelf action has a command the tab can dispatch', async function () {
    this.timeout(30_000);
    const commands = await vscode.commands.getCommands(true);
    for (const id of [
      'gittree.shelf.shelve',
      'gittree.shelf.unshelve',
      'gittree.shelf.unshelveSilently',
      'gittree.shelf.unshelvePartial',
      'gittree.shelf.compareWithLocal',
      'gittree.shelf.openShelvedDiff',
      'gittree.shelf.showPatch',
      'gittree.shelf.export',
      'gittree.shelf.rename',
      'gittree.shelf.delete',
      'gittree.shelf.import',
      'gittree.shelf.showUnshelved',
    ]) {
      assert.ok(commands.includes(id), `missing command ${id}`);
    }
  });

  test('T6: the tab bridge mirrors the store and its unshelve is the tree unshelve', async function () {
    this.timeout(120_000);
    const rel = 'p11/shelf-tab.txt';
    const id = await seedShelf('p11 tab entry', rel);

    const state = shelfBridge.buildState();
    const repoState = state.repos.find((r) => canonicalKey(r.root) === canonicalKey(fsRoot))!;
    const entry = repoState.entries.find((e) => e.id === id)!;
    assert.ok(entry, 'the bridge must list the freshly shelved entry');
    assert.strictEqual(entry.name, 'p11 tab entry');
    assert.strictEqual(entry.valid, true);
    assert.strictEqual(entry.unshelved, false);
    assert.deepStrictEqual(
      entry.files.map((f) => f.relPath),
      [rel],
    );

    // The tab's Unshelve Silently — dispatched through the same command the
    // tree runs, so this IS the acceptance that both produce one store state.
    await shelfBridge.dispatch({ action: 'unshelveSilently', repoRoot: fsRoot, id });
    await waitFor(
      () => fs.readFileSync(path.join(repoRoot, rel), 'utf8') === 'shelf changed\n',
      30_000,
    );
    assert.strictEqual(shelfStore.get(id), undefined, 'silent unshelve removes the entry');

    git('checkout', '--', rel);
    await refresh();
    dropChangelist('p11 tab entry');
    restoreChecked();
  });

  test('T6: a tampered changes.patch reads damaged and refuses to unshelve', async function () {
    this.timeout(120_000);
    const rel = 'p11/shelf-tamper.txt';
    const id = await seedShelf('p11 tampered', rel);
    fs.appendFileSync(shelfStore.patchPath(id), 'GARBAGE-NOT-A-PATCH\n');

    const entry = shelfBridge
      .buildState()
      .repos.find((r) => canonicalKey(r.root) === canonicalKey(fsRoot))!
      .entries.find((e) => e.id === id)!;
    assert.strictEqual(entry.valid, false, 'the row must read damaged, not fail modally');

    // The engine's integrity gate throws; the command surfaces it as an error
    // message and must leave both the worktree and the entry untouched.
    await shelfBridge.dispatch({ action: 'unshelveSilently', repoRoot: fsRoot, id });
    assert.strictEqual(
      fs.readFileSync(path.join(repoRoot, rel), 'utf8'),
      'shelf base\n',
      'a damaged patch must never reach the worktree',
    );
    assert.ok(shelfStore.get(id) !== undefined, 'the damaged entry must be kept for inspection');

    shelfStore.delete(id);
    restoreChecked();
  });

  test('T6: unshelve-keeping marks the entry; the eye toggle governs visibility', async function () {
    this.timeout(120_000);
    const rel = 'p11/shelf-keep.txt';
    const id = await seedShelf('p11 kept', rel);

    process.env['GITTREE_TEST_UNSHELVE'] = JSON.stringify({ deleteAfter: false });
    try {
      await shelfBridge.dispatch({ action: 'unshelve', repoRoot: fsRoot, id });
    } finally {
      delete process.env['GITTREE_TEST_UNSHELVE'];
    }
    await waitFor(
      () => fs.readFileSync(path.join(repoRoot, rel), 'utf8') === 'shelf changed\n',
      30_000,
    );
    assert.ok(
      shelfStore.get(id)?.unshelvedAt !== undefined,
      'a kept entry must be marked already-unshelved',
    );

    const hidden = shelfBridge.buildState();
    assert.ok(
      !hidden.repos.some((r) => r.entries.some((e) => e.id === id)),
      'applied-but-kept entries hide by default',
    );
    await vscode.commands.executeCommand('gittree.shelf.showUnshelved');
    try {
      const shown = shelfBridge.buildState();
      assert.strictEqual(shown.showUnshelved, true);
      const entry = shown.repos
        .find((r) => canonicalKey(r.root) === canonicalKey(fsRoot))!
        .entries.find((e) => e.id === id);
      assert.ok(entry, 'the toggle must reveal the applied entry');
      assert.strictEqual(entry.unshelved, true);
    } finally {
      await vscode.commands.executeCommand('gittree.shelf.showUnshelved');
    }

    shelfStore.delete(id);
    git('checkout', '--', rel);
    await refresh();
    dropChangelist('p11 kept');
    restoreChecked();
  });

  test('T6: Compare with Local opens the shelved↔worktree diff', async function () {
    this.timeout(120_000);
    const rel = 'p11/shelf-compare.txt';
    const id = await seedShelf('p11 compare', rel);

    await shelfBridge.dispatch({
      action: 'compareWithLocal',
      repoRoot: fsRoot,
      id,
      relPath: rel,
    });
    const diffTab = vscode.window.tabGroups.all
      .flatMap((g) => g.tabs)
      .find((t) => t.label.includes('Shelved: p11 compare'));
    assert.ok(diffTab, 'the diff tab must be open with the shelved-vs-local title');
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');

    shelfStore.delete(id);
    restoreChecked();
  });

  /** Deps for driving the dialog's accept path with a synthetic result. */
  const shelveDeps = (): ShelveDialogDeps => ({
    core: coreRef,
    extensionUri: vscode.Uri.file(repoRoot),
    changelistsFor: (r) => reg.changelistsFor(r),
    storeFor: (root) =>
      canonicalKey(root) === canonicalKey(fsRoot) ? shelfStore : undefined,
    draftMessage: () => '',
  });

  test('T7: shelving one ticked change stores exactly it; unshelve restores it onto the residue', async function () {
    this.timeout(120_000);
    const rel = 'p11/shelve-partial.txt';
    const { modified, changes } = await seedThreeChanges(rel, '\n');

    const ok = await applyShelveResult(shelveDeps(), repo, {
      listId: 'default',
      message: 'p11 partial shelf\nbody line',
      paths: [],
      partials: [{ relPath: rel, included: [1], signature: signChanges(changes) }],
      removeFromWorktree: true,
    });
    assert.ok(ok, 'the shelve must report success');

    // The worktree keeps the two unticked changes, byte-identically.
    assert.strictEqual(
      fs.readFileSync(path.join(repoRoot, rel), 'utf8'),
      ['l1', 'X2', 'l3', 'l4', 'l5', 'X6', 'l7'].join('\n') + '\n',
      'removal must take only the shelved change out of the worktree',
    );

    const meta = shelfStore.list().find((m) => m.name === 'p11 partial shelf');
    assert.ok(meta, 'the entry must exist under the message subject');
    assert.strictEqual(meta.comment, 'body line');
    assert.deepStrictEqual(
      meta.files.map((f) => f.relPath),
      [rel],
    );

    // Unshelving onto the residue: apply --index fails on context (the file
    // moved around the hunk) and the --3way ladder must merge it back — this
    // is exactly the adjacent-changes case the whole capability exists for.
    const engine = new UnshelveEngine(repo, shelfStore, () => undefined, () => undefined);
    const res = await engine.unshelve(meta, { deleteAfter: true, unstageAfterApply: true });
    assert.strictEqual(res.status, 'clean', JSON.stringify(res));
    assert.strictEqual(
      fs.readFileSync(path.join(repoRoot, rel), 'utf8'),
      modified,
      'residue + unshelved change must reassemble the full modified content',
    );
    assert.strictEqual(shelfStore.get(meta.id), undefined, 'deleteAfter removes the entry');

    git('checkout', '--', rel);
    await refresh();
    restoreChecked();
  });

  test('T7: a CRLF partial shelve round-trips with no EOL damage', async function () {
    this.timeout(120_000);
    git('config', 'core.autocrlf', 'false');
    const rel = 'p11/shelve-crlf.txt';
    const { modified, changes } = await seedThreeChanges(rel, '\r\n');

    const ok = await applyShelveResult(shelveDeps(), repo, {
      listId: 'default',
      message: 'p11 crlf shelf',
      paths: [],
      partials: [{ relPath: rel, included: [1], signature: signChanges(changes) }],
      removeFromWorktree: true,
    });
    assert.ok(ok);
    assert.strictEqual(
      fs.readFileSync(path.join(repoRoot, rel), 'utf8'),
      ['l1', 'X2', 'l3', 'l4', 'l5', 'X6', 'l7'].join('\r\n') + '\r\n',
      'the residue must keep CRLF byte-exactly',
    );

    const meta = shelfStore.list().find((m) => m.name === 'p11 crlf shelf')!;
    const engine = new UnshelveEngine(repo, shelfStore, () => undefined, () => undefined);
    const res = await engine.unshelve(meta, { deleteAfter: true, unstageAfterApply: true });
    assert.strictEqual(res.status, 'clean', JSON.stringify(res));
    assert.strictEqual(
      fs.readFileSync(path.join(repoRoot, rel), 'utf8'),
      modified,
      'CRLF must survive shelve + unshelve untouched',
    );

    git('checkout', '--', rel);
    await refresh();
    restoreChecked();
  });

  test('T7: a stale selection shelves the whole file instead of renumbered hunks', async function () {
    this.timeout(120_000);
    const rel = 'p11/shelve-stale.txt';
    const { changes } = await seedThreeChanges(rel, '\n');
    const staleSignature = signChanges(changes);

    // External edit above the hunks renumbers every change.
    write(rel, ['inserted', 'l1', 'X2', 'l3', 'X4', 'l5', 'X6', 'l7'].join('\n') + '\n');
    await refresh();

    const ok = await applyShelveResult(shelveDeps(), repo, {
      listId: 'default',
      message: 'p11 stale shelf',
      paths: [],
      partials: [{ relPath: rel, included: [1], signature: staleSignature }],
      removeFromWorktree: true,
    });
    assert.ok(ok);
    // Whole-file fallback: the worktree reverts to HEAD entirely.
    assert.strictEqual(
      fs.readFileSync(path.join(repoRoot, rel), 'utf8'),
      ['l1', 'l2', 'l3', 'l4', 'l5', 'l6', 'l7'].join('\n') + '\n',
    );
    const meta = shelfStore.list().find((m) => m.name === 'p11 stale shelf')!;
    shelfStore.delete(meta.id);
    await refresh();
    restoreChecked();
  });

  test('T7: an empty result is a no-op — worktree and shelf untouched', async function () {
    this.timeout(30_000);
    const before = shelfStore.list().length;
    const ok = await applyShelveResult(shelveDeps(), repo, {
      listId: 'default',
      message: 'never used',
      paths: [],
      partials: [],
      removeFromWorktree: true,
    });
    assert.strictEqual(ok, false);
    assert.strictEqual(shelfStore.list().length, before);
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
