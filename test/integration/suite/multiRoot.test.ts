import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { NotificationsRegistry } from '../../../src/ui/notify';
import type { Phase03Registry } from '../../../src/commit/register';
import type { ReposInView } from '../../../src/branches/reposInView';
import type { Core, RepoHandle } from '../../../src/core/core';
import type { Phase13Registry } from '../../../src/scm/dialogs/register';
import { rootColorIndices } from '../../../src/log/graphLayout/colors';
import type { BranchPanelStateDto } from '../../../src/shared/protocol';
import {
  activateGitTree,
  gitWithRetry,
  waitFor,
  withAutoConfirm,
  workspaceRepoD,
  workspaceRepoE,
} from '../setup';

/**
 * Multi-root commit acceptance.
 *
 * The commit window renders every repository's changes in one tree, so
 * `Commit` has to mean "commit what is ticked" — across repositories — rather
 * than silently committing whichever repo the active editor happened to point
 * at while the counter claimed to describe them all.
 *
 * Runs on repoD/repoE (see runTests.ts): this suite needs two repos dirty at
 * once and commits in both, which would leave debris in the repos three other
 * suites assert against.
 */
suite('Multi-root commit', () => {
  let core: Core;
  let repoD: RepoHandle;
  let repoE: RepoHandle;
  let others: RepoHandle[];
  let reg: Phase03Registry;

  const headOf = (repo: RepoHandle): string => gitWithRetry(repo.root, ['rev-parse', 'HEAD']).trim();
  const subjectOf = (repo: RepoHandle): string =>
    gitWithRetry(repo.root, ['log', '-1', '--format=%s']).trim();
  const countOf = (repo: RepoHandle): number =>
    Number(gitWithRetry(repo.root, ['rev-list', '--count', 'HEAD']).trim());
  const labelOf = (repo: RepoHandle): string => path.basename(repo.root);
  /**
   * Targets narrowed to this suite's own repos. Comparing the whole list would
   * tie these assertions to whether some other suite happens to have left a
   * repository dirty, which is not what any of them are about.
   */
  const ourTargets = (): string[] =>
    reg.commitWindow
      .buildState()
      .targets.filter((t) => t === labelOf(repoD) || t === labelOf(repoE))
      .sort();

  /**
   * Dirties a tracked file and waits for the changelist service to see it —
   * ticking before the status refresh lands leaves the file out of the commit
   * and fails the test for the wrong reason.
   */
  async function tick(repo: RepoHandle, text: string): Promise<void> {
    fs.writeFileSync(path.join(repo.root, 'README.md'), text);
    await repo.refresher.refreshNow();
    const service = reg.changelistsFor(repo);
    await waitFor(() => service.getLists().some((l) => l.files.includes('README.md')), 20_000);
    service.setListChecked('default', true);
  }

  /** The check pipeline gates every commit; nothing here is testing checks. */
  async function commitWith<T>(fn: () => Thenable<T>): Promise<T> {
    const saved = process.env['GITTREE_TEST_CHECKS_CHOICE'];
    process.env['GITTREE_TEST_CHECKS_CHOICE'] = 'anyway';
    try {
      return await fn();
    } finally {
      if (saved === undefined) delete process.env['GITTREE_TEST_CHECKS_CHOICE'];
      else process.env['GITTREE_TEST_CHECKS_CHOICE'] = saved;
    }
  }

  /**
   * POST-P14ah: the Push dialog is a webview no test can answer. `cancel`
   * records what it was opened for and closes it unanswered, as Escape would.
   */
  async function withPushDialogCancelled<T>(fn: () => Thenable<T>): Promise<T> {
    const saved = process.env['GITTREE_TEST_PUSH_DIALOG'];
    process.env['GITTREE_TEST_PUSH_DIALOG'] = 'cancel';
    try {
      return await fn();
    } finally {
      if (saved === undefined) delete process.env['GITTREE_TEST_PUSH_DIALOG'];
      else process.env['GITTREE_TEST_PUSH_DIALOG'] = saved;
    }
  }

  /** Binds the message box and the amend flag to `repo`, as a real edit would. */
  async function focus(repo: RepoHandle): Promise<void> {
    const doc = await vscode.workspace.openTextDocument(
      vscode.Uri.file(path.join(repo.root, 'README.md')),
    );
    await vscode.window.showTextDocument(doc, { preview: false });
  }

  suiteSetup(async function () {
    this.timeout(60_000);
    core = await activateGitTree();
    reg = core.debugRegistry.get('phase03') as Phase03Registry;
    assert.ok(reg, 'phase03 registry missing');
    repoD = core.repoForPath(workspaceRepoD())!;
    repoE = core.repoForPath(workspaceRepoE())!;
    assert.ok(repoD, 'repoD not discovered');
    assert.ok(repoE, 'repoE not discovered');
    others = core.repos.filter((r) => r !== repoD && r !== repoE);
    assert.strictEqual(
      reg.paradigm.paradigm,
      'changelists',
      'this suite runs before P1 switches paradigms; changelists is the default',
    );
  });

  suiteTeardown(async () => {
    // `focus()` leaves a real editor open in one of this suite's repositories,
    // and later suites still resolve "the repository to act on" from the active
    // editor (`pickRepo`). Leaving one open points them at repoD/repoE, where
    // the shas they were given do not exist. The log no longer resolves that
    // way — it holds the root it was given — but the rest still does.
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });

  test('the button names only the repositories a commit would touch', async function () {
    this.timeout(60_000);
    assert.deepStrictEqual(
      ourTargets(),
      [],
      'a clean workspace commits nothing, so the button stays a plain "Commit"',
    );

    await tick(repoD, '# repoD targets\n');
    assert.deepStrictEqual(
      ourTargets(),
      [labelOf(repoD)],
      'one ticked repo names itself',
    );

    await tick(repoE, '# repoE targets\n');
    assert.deepStrictEqual(
      ourTargets(),
      [labelOf(repoD), labelOf(repoE)].sort(),
      'both ticked repos are named, and no clean one is',
    );
  });

  test('each repository wears the colour it has in the Repositories panel', async () => {
    const state = reg.commitWindow.buildState();
    const colors = rootColorIndices(core.repos.map((r) => r.root));
    for (const repo of state.repos) {
      assert.strictEqual(repo.colorIdx, colors.get(repo.root), `${repo.label}: the log's root colour`);
    }
    const panel = (core.debugRegistry.get('phase02') as { panel: { buildState(): Promise<BranchPanelStateDto> } })
      .panel;
    const panelState = await panel.buildState();
    for (const repo of state.repos) {
      const there = panelState.repos.find((r) => r.root === repo.root);
      assert.ok(there, `${repo.label} is in the Repositories panel too`);
      assert.strictEqual(repo.colorIdx, there.colorIdx, `${repo.label}: one colour in both panels`);
    }
    const colorOf = (handle: RepoHandle) => state.repos.find((r) => r.root === handle.root)?.colorIdx;
    assert.notStrictEqual(colorOf(repoD), colorOf(repoE), 'two repositories, two colours');
    assert.strictEqual(state.palette, panelState.palette, 'both follow gittree.log.graphPalette');
  });

  test('repositories come named and ordered as the Repositories panel lists them, with what they have checked out', async () => {
    const state = reg.commitWindow.buildState();
    const panel = (core.debugRegistry.get('phase02') as { panel: { buildState(): Promise<BranchPanelStateDto> } })
      .panel;
    const panelState = await panel.buildState();
    assert.deepStrictEqual(
      state.repos.map((r) => [r.root, r.label]),
      panelState.repos.map((r) => [r.root, r.label]),
      'one order and one name for a repository in both panels',
    );
    const d = state.repos.find((r) => r.root === repoD.root);
    assert.strictEqual(d?.head?.branch, 'main', 'repoD is on main, which its row says');
    assert.ok(d?.head?.sha, 'with the commit it is at');
    assert.strictEqual(d?.head?.unborn, undefined, 'and it has commits');
  });

  test('View Options › Group By lives in gittree.commit.groupBy and groupByDirectory', async function () {
    this.timeout(30_000);
    const config = (): vscode.WorkspaceConfiguration => vscode.workspace.getConfiguration('gittree');
    const saved = config().inspect('commit.groupBy')?.workspaceValue;
    const savedFolders = config().inspect('commit.groupByDirectory');
    try {
      // POST-P14cb: no changelist rows and no folder rows by default.
      assert.strictEqual(reg.commitWindow.buildState().groupBy, 'none', 'no changelist rows by default');
      assert.strictEqual(reg.commitWindow.buildState().groupByDirectory, false, 'no folder rows by default');
      await vscode.commands.executeCommand('gittree.commit.groupByRepository');
      assert.strictEqual(config().inspect('commit.groupBy')?.workspaceValue, 'repository', 'saved for the workspace');
      assert.strictEqual(reg.commitWindow.buildState().groupBy, 'repository', 'the window reads it on its next push');
      await vscode.commands.executeCommand('gittree.commit.groupByChangelist');
      assert.strictEqual(config().inspect('commit.groupBy')?.workspaceValue, 'changelist');
      assert.strictEqual(reg.commitWindow.buildState().groupBy, 'changelist');
      await vscode.commands.executeCommand('gittree.commit.groupByNone');
      assert.strictEqual(config().inspect('commit.groupBy')?.workspaceValue, 'none');
      assert.strictEqual(reg.commitWindow.buildState().groupBy, 'none');
      await vscode.commands.executeCommand('gittree.commit.toggleGroupByDirectory');
      assert.strictEqual(reg.commitWindow.buildState().groupByDirectory, true, 'the folder rows, from the palette');
      await vscode.commands.executeCommand('gittree.commit.toggleGroupByDirectory');
      assert.strictEqual(reg.commitWindow.buildState().groupByDirectory, false, 'and off again');
    } finally {
      await config().update('commit.groupBy', saved, vscode.ConfigurationTarget.Workspace);
      // Kept nowhere before, so written to the user's settings (`writeSetting`).
      await config().update('commit.groupByDirectory', savedFolders?.workspaceValue, vscode.ConfigurationTarget.Workspace);
      await config().update('commit.groupByDirectory', savedFolders?.globalValue, vscode.ConfigurationTarget.Global);
    }
  });

  test('one gesture commits every repository that has something ticked', async function () {
    this.timeout(90_000);
    // Left ticked by the previous test; re-tick so this one stands alone.
    await tick(repoD, '# repoD spanning\n');
    await tick(repoE, '# repoE spanning\n');
    await focus(repoD);

    const beforeD = headOf(repoD);
    const beforeE = headOf(repoE);
    const untouched = others.map((r) => [r, headOf(r)] as const);

    // This test is about to commit *everything* ticked. If another suite left
    // ticks in its own repo, that repo would be swept into this commit and the
    // failure would surface over there, later, as something else entirely.
    assert.deepStrictEqual(
      reg.commitWindow.buildState().targets.sort(),
      [labelOf(repoD), labelOf(repoE)].sort(),
      'another suite left changes ticked; a spanning commit would swallow them',
    );

    const message = 'multi-root: one message, two repositories';
    reg.commitWindow.messageBoxFor(repoD).value = message;
    const notes = core.debugRegistry.get('notifications') as NotificationsRegistry;
    notes.clear();

    // No repo argument: the palette / Ctrl+K / commit-button path.
    await commitWith(() => vscode.commands.executeCommand('gittree.commit'));

    await waitFor(() => headOf(repoD) !== beforeD && headOf(repoE) !== beforeE, 60_000);
    assert.strictEqual(subjectOf(repoD), message, 'repoD committed with the typed message');
    assert.strictEqual(subjectOf(repoE), message, 'repoE committed with the same message');
    // POST-P14ap: one commit, one notification — the files of both
    // repositories counted together, as IntelliJ counts them.
    await waitFor(() => notes.recent().some((n) => n.message.endsWith(`committed: ${message}`)), 30_000);
    const said = notes.recent().filter((n) => n.message.endsWith(`committed: ${message}`));
    assert.strictEqual(said.length, 1, JSON.stringify(said));
    assert.match(said[0]!.message, /^\d+ files committed: /);

    // The message was typed into repoD's box; repoE has its own, and reading it
    // instead of the one handed down would have rejected repoE as empty.
    for (const [repo, head] of untouched) {
      assert.strictEqual(
        headOf(repo),
        head,
        `${labelOf(repo)} had nothing ticked and must not have been committed`,
      );
    }
    // `headOf` polls git directly, so the waitFor above returns as soon as the
    // COMMIT lands — the window's own state is one refresh behind it. Reading
    // targets straight after was relying on that refresh winning a race it has
    // no reason to win; POST-P14n changed how many views render at startup and
    // the timing shifted enough to lose it. Synchronize on the model observing
    // the commit, the way phase01's T7 does for the same gap.
    await waitFor(() => ourTargets().length === 0, 30_000);
    assert.deepStrictEqual(
      ourTargets(),
      [],
      'both repos are clean again, so nothing is targeted',
    );
  });

  test('POST-P14ah: Commit and Push opens one Push dialog for every repository it committed', async function () {
    this.timeout(90_000);
    const p13 = core.debugRegistry.get('phase13') as Phase13Registry;
    assert.ok(p13, 'phase13 registry missing');
    await tick(repoD, '# repoD commit and push\n');
    await tick(repoE, '# repoE commit and push\n');
    await focus(repoD);
    assert.deepStrictEqual(
      reg.commitWindow.buildState().targets.sort(),
      [labelOf(repoD), labelOf(repoE)].sort(),
      'another suite left changes ticked; a spanning commit would swallow them',
    );
    const beforeD = headOf(repoD);
    const beforeE = headOf(repoE);
    const since = core.commandLog.entries().at(-1)?.seq ?? 0;
    p13.clearLastPushDialogRequest();
    reg.commitWindow.messageBoxFor(repoD).value = 'multi-root: commit and push';

    // No repo argument: the commit window's `Commit and Push…` (in the ▾ beside Commit).
    await withPushDialogCancelled(() =>
      commitWith(() => vscode.commands.executeCommand('gittree.commitAndPush')),
    );

    await waitFor(() => headOf(repoD) !== beforeD && headOf(repoE) !== beforeE, 60_000);
    // IntelliJ's push-after-commit: one dialog, for exactly what was committed
    // — not a push, or a dialog, per repository as each commit landed.
    const asked = p13.lastPushDialogRequest();
    assert.ok(asked, 'Commit and Push must open the Push dialog');
    assert.deepStrictEqual([...asked].sort(), [repoD.root, repoE.root].sort());
    assert.strictEqual(
      core.commandLog.entriesAfter(since).filter((e) => e.argv[0] === 'push').length,
      0,
      'nothing is pushed before the dialog says so',
    );
    await waitFor(() => ourTargets().length === 0, 30_000);
  });

  test('the message follows the box the user typed in, not the repo being committed', async function () {
    this.timeout(90_000);
    // Only repoE has work, but the editor — and therefore the visible message
    // box — is bound to repoD. Reading repoE's own box would reject the commit
    // for an empty message that is not empty anywhere the user can see.
    await tick(repoE, '# repoE borrowed message\n');
    await focus(repoD);
    assert.deepStrictEqual(ourTargets(), [labelOf(repoE)]);

    const beforeD = headOf(repoD);
    const beforeE = headOf(repoE);
    const message = 'typed against repoD, committed to repoE';
    reg.commitWindow.messageBoxFor(repoD).value = message;

    await commitWith(() => vscode.commands.executeCommand('gittree.commit'));

    await waitFor(() => headOf(repoE) !== beforeE, 60_000);
    assert.strictEqual(subjectOf(repoE), message, 'repoE used the message the user could see');
    assert.strictEqual(headOf(repoD), beforeD, 'repoD had nothing ticked and must not commit');
    assert.strictEqual(
      reg.commitWindow.messageBoxFor(repoD).value,
      '',
      'the box that held the committed message must not keep it',
    );
  });

  test('an explicit repository argument stays scoped to it', async function () {
    this.timeout(90_000);
    await tick(repoD, '# repoD scoped\n');
    await tick(repoE, '# repoE scoped\n');
    await focus(repoD);

    const beforeD = headOf(repoD);
    const beforeE = headOf(repoE);
    reg.commitWindow.messageBoxFor(repoD).value = 'scoped to repoD only';

    // Context menus and every existing suite call it this way; spanning here
    // would silently widen what those callers asked for.
    await commitWith(() => vscode.commands.executeCommand('gittree.commit', repoD.root));

    await waitFor(() => headOf(repoD) !== beforeD, 60_000);
    assert.strictEqual(headOf(repoE), beforeE, 'repoE was named by nobody and must be untouched');
    assert.deepStrictEqual(
      ourTargets(),
      [labelOf(repoE)],
      'repoE keeps its ticks',
    );

    // Hand repoE back clean for the next test.
    reg.commitWindow.messageBoxFor(repoE).value = 'scoped cleanup of repoE';
    await focus(repoE);
    await commitWith(() => vscode.commands.executeCommand('gittree.commit', repoE.root));
    await waitFor(() => headOf(repoE) !== beforeE, 60_000);
  });

  test('amend rewrites only its own repository, and says so before it does', async function () {
    this.timeout(90_000);
    await tick(repoD, '# repoD amend\n');
    await tick(repoE, '# repoE amend\n');
    await focus(repoD);

    const beforeD = headOf(repoD);
    const beforeE = headOf(repoE);
    const depthBefore = countOf(repoD);
    await reg.commitService.toggleAmend(repoD);
    assert.ok(reg.commitService.isAmend(repoD), 'amend must be armed for this test to mean anything');

    // Declining the warning must abort everything — no repo is committed.
    await withAutoConfirm('0', () =>
      commitWith(() => vscode.commands.executeCommand('gittree.commit')),
    );
    assert.strictEqual(headOf(repoD), beforeD, 'declining the amend warning commits nothing');
    assert.strictEqual(headOf(repoE), beforeE, 'declining the amend warning commits nothing');

    // Accepting it amends the message repo alone and leaves the rest ticked.
    reg.commitWindow.messageBoxFor(repoD).value = 'amended repoD alone';
    await withAutoConfirm('1', () =>
      commitWith(() => vscode.commands.executeCommand('gittree.commit')),
    );
    await waitFor(() => subjectOf(repoD) === 'amended repoD alone', 60_000);
    assert.notStrictEqual(headOf(repoD), beforeD, 'the amended commit is a new object');
    assert.strictEqual(
      countOf(repoD),
      depthBefore,
      'amend rewrites the tip; a new commit on top would deepen the history',
    );
    assert.strictEqual(headOf(repoE), beforeE, 'amend must never reach a second repository');
    assert.deepStrictEqual(
      ourTargets(),
      [labelOf(repoE)],
      'repoE still holds the ticks the amend deliberately skipped',
    );

    // Clean up: commit repoE so the suite leaves both repos as it found them.
    await focus(repoE);
    reg.commitWindow.messageBoxFor(repoE).value = 'amend cleanup of repoE';
    await commitWith(() => vscode.commands.executeCommand('gittree.commit', repoE.root));
    await waitFor(() => headOf(repoE) !== beforeE, 60_000);
    assert.deepStrictEqual(ourTargets(), [], 'suite leaves nothing ticked');
  });

  test("POST-P14by: a list, the Repositories panel's ⋯, commits what is ticked in those alone, with the message typed", async function () {
    this.timeout(90_000);
    await tick(repoD, '# repoD out of view\n');
    await tick(repoE, '# repoE in view\n');
    // The message box is bound to repoD, which is not in the list: what the
    // user typed there is still the message, as the Commit window shows it.
    await focus(repoD);
    const beforeD = headOf(repoD);
    const beforeE = headOf(repoE);
    const message = 'committed in view: repoE alone';
    reg.commitWindow.messageBoxFor(repoD).value = message;

    await commitWith(() => vscode.commands.executeCommand('gittree.commit', [repoE.root]));

    await waitFor(() => headOf(repoE) !== beforeE, 60_000);
    assert.strictEqual(subjectOf(repoE), message, 'repoE used the message the user could see');
    assert.strictEqual(headOf(repoD), beforeD, 'repoD is out of the list and must not commit');
    await waitFor(() => ourTargets().length === 1, 30_000);
    assert.deepStrictEqual(ourTargets(), [labelOf(repoD)], 'repoD keeps its ticks');

    // A list naming no repository still open commits nothing, rather than all that is ticked.
    reg.commitWindow.messageBoxFor(repoD).value = 'must not be committed';
    await commitWith(() =>
      vscode.commands.executeCommand('gittree.commit', [path.join(path.dirname(repoD.root), 'no-such-repo')]),
    );
    assert.strictEqual(headOf(repoD), beforeD, 'nothing open was named: nothing is committed');

    // Hand repoD back clean.
    reg.commitWindow.messageBoxFor(repoD).value = 'in-view cleanup of repoD';
    await commitWith(() => vscode.commands.executeCommand('gittree.commit', repoD.root));
    await waitFor(() => headOf(repoD) !== beforeD, 60_000);
    await waitFor(() => ourTargets().length === 0, 30_000);
  });

  test("POST-P14by: a list, the Repositories panel's ⋯, opens Push… with every repository listed and those checked", async function () {
    this.timeout(60_000);
    const p13 = core.debugRegistry.get('phase13') as Phase13Registry;
    assert.ok(p13, 'phase13 registry missing');
    p13.clearLastPushDialogRequest();
    await withPushDialogCancelled(() =>
      vscode.commands.executeCommand('gittree.push.dialog', [repoD.root, repoE.root]),
    );
    const opened = p13.lastPushDialogOpened();
    assert.ok(opened, 'the Push dialog opens');
    // Every repository listed, as IntelliJ's dialog lists them; those two checked.
    assert.deepStrictEqual([...opened.repos].sort(), core.repos.map((r) => r.root).sort());
    assert.deepStrictEqual([...opened.preselected].sort(), [repoD.root, repoE.root].sort());

    // A list naming no repository still open opens nothing.
    p13.clearLastPushDialogRequest();
    await withPushDialogCancelled(() =>
      vscode.commands.executeCommand('gittree.push.dialog', [path.join(path.dirname(repoD.root), 'no-such-repo')]),
    );
    assert.strictEqual(p13.lastPushDialogOpened(), undefined, 'nothing open was named: no dialog');
  });

  /**
   * POST-P14ce: the repositories picked in the Repositories panel narrow the
   * Commit window: its list, its counter and button, and what a bare commit
   * (its button, Ctrl+K) commits. The message box stays the editor's.
   */
  suite('the Repositories panel’s pick narrows the Commit window (POST-P14ce)', () => {
    const inView = (): ReposInView => (core.debugRegistry.get('phase02') as { reposInView: ReposInView }).reposInView;

    teardown(() => {
      inView().clear('elsewhere');
    });

    test('the list, its counter and its button show the repository picked alone; the rest is counted', async function () {
      this.timeout(60_000);
      await tick(repoD, '# repoD out of the pick\n');
      await tick(repoE, '# repoE picked\n');
      await focus(repoD);
      const whole = reg.commitWindow.buildState();
      inView().set([repoE.root], 'elsewhere');

      const state = reg.commitWindow.buildState();
      assert.deepStrictEqual(state.repos.map((r) => r.root), [repoE.root], 'the repository picked, alone');
      assert.ok(state.filter, 'the list says it is narrowed');
      assert.deepStrictEqual(state.filter.shown.map((r) => r.root), [repoE.root]);
      const d = state.filter.hidden.find((r) => r.root === repoD.root);
      assert.ok(d && d.changes > 0 && d.ticked > 0, "repoD's ticked change is counted out of view");
      assert.deepStrictEqual(state.targets, [labelOf(repoE)], 'the button names the repository picked');
      // The counter counts what the list shows; the bar, the rest.
      assert.ok(state.checkedCount >= 1);
      assert.strictEqual(
        state.checkedCount + state.filter.hidden.reduce((n, r) => n + r.ticked, 0),
        whole.checkedCount,
      );
      // The box stays the editor's; Amend acts on the repository listed.
      assert.strictEqual(state.activeRepo, repoD.root);
      assert.strictEqual(state.commitRepo, repoE.root);

      // The Repositories panel draws the same pick.
      const panel = (core.debugRegistry.get('phase02') as { panel: { buildState(): Promise<BranchPanelStateDto> } }).panel;
      assert.deepStrictEqual((await panel.buildState()).scope, [repoE.root]);

      // Shown all again from the Command Palette: every repository listed.
      await vscode.commands.executeCommand('gittree.branches.showAllRepositories');
      const all = reg.commitWindow.buildState();
      assert.strictEqual(all.filter, undefined);
      assert.ok(all.repos.some((r) => r.root === repoD.root) && all.repos.some((r) => r.root === repoE.root));
      assert.strictEqual(all.commitRepo, all.activeRepo);
    });

    test('a bare commit commits the repository picked alone, with the message on screen, and says where it went', async function () {
      this.timeout(90_000);
      await tick(repoD, '# repoD stays ticked\n');
      await tick(repoE, '# repoE committed from the pick\n');
      await focus(repoD);
      // A repository row's Show Only This Repository, in the Commit window.
      await vscode.commands.executeCommand('gittree.branches.selectRepository', { repoRoot: repoE.root });
      assert.deepStrictEqual(reg.commitWindow.buildState().targets, [labelOf(repoE)]);

      const beforeD = headOf(repoD);
      const beforeE = headOf(repoE);
      const message = 'committed what the list shows';
      reg.commitWindow.messageBoxFor(repoD).value = message;
      const notes = core.debugRegistry.get('notifications') as NotificationsRegistry;
      notes.clear();

      // No repository argument: the button, Ctrl+K.
      await commitWith(() => vscode.commands.executeCommand('gittree.commit'));

      await waitFor(() => headOf(repoE) !== beforeE, 60_000);
      assert.strictEqual(subjectOf(repoE), message, 'repoE used the message on screen');
      assert.strictEqual(headOf(repoD), beforeD, 'repoD is out of the list and must not commit');
      await waitFor(() => notes.recent().some((n) => n.message.endsWith(`committed to ${labelOf(repoE)}: ${message}`)), 30_000);
      assert.strictEqual(reg.commitWindow.messageBoxFor(repoD).value, '', 'the box that held the message is emptied');
      await waitFor(() => ourTargets().length === 1, 30_000);

      // Hand repoD back clean.
      inView().clear('elsewhere');
      reg.commitWindow.messageBoxFor(repoD).value = 'pick cleanup of repoD';
      await commitWith(() => vscode.commands.executeCommand('gittree.commit', repoD.root));
      await waitFor(() => headOf(repoD) !== beforeD, 60_000);
      await waitFor(() => ourTargets().length === 0, 30_000);
    });

    test('nothing ticked in the repository picked: it says where the ticks are, commits nothing, and Show All Repositories widens', async function () {
      this.timeout(90_000);
      await tick(repoD, '# repoD ticked, out of the pick\n');
      await focus(repoD);
      inView().set([repoE.root], 'elsewhere');
      const beforeD = headOf(repoD);
      const beforeE = headOf(repoE);
      reg.commitWindow.messageBoxFor(repoD).value = 'must not be committed';
      const notes = core.debugRegistry.get('notifications') as NotificationsRegistry;
      notes.clear();
      const saved = process.env['GITTREE_TEST_NOTIFICATION_ACTION'];
      process.env['GITTREE_TEST_NOTIFICATION_ACTION'] = 'Show All Repositories';
      try {
        await commitWith(() => vscode.commands.executeCommand('gittree.commit'));
      } finally {
        if (saved === undefined) delete process.env['GITTREE_TEST_NOTIFICATION_ACTION'];
        else process.env['GITTREE_TEST_NOTIFICATION_ACTION'] = saved;
      }
      const said = notes.recent().find((n) => n.message.startsWith(`Nothing ticked to commit in ${labelOf(repoE)}.`));
      assert.ok(said, JSON.stringify(notes.recent()));
      assert.match(said.message, new RegExp(`What is ticked in .*${labelOf(repoD)}|What is ticked in \\d+ repositories`, 'u'));
      assert.deepStrictEqual(said.actions, ['Show All Repositories']);
      assert.strictEqual(headOf(repoD), beforeD, 'nothing committed');
      assert.strictEqual(headOf(repoE), beforeE, 'nothing committed');
      // Its button, taken: every repository in view again.
      await waitFor(() => !inView().snapshot().narrowed, 10_000);

      // Hand repoD back clean.
      reg.commitWindow.messageBoxFor(repoD).value = 'pick notice cleanup of repoD';
      await commitWith(() => vscode.commands.executeCommand('gittree.commit', repoD.root));
      await waitFor(() => headOf(repoD) !== beforeD, 60_000);
      await waitFor(() => ourTargets().length === 0, 30_000);
    });
  });

  /**
   * The tree merges one changelist across repositories into a single row, so a
   * changelist action on that row has to reach every repository behind it —
   * otherwise the row would show one list and act on part of it.
   */
  suite('merged changelist rows fan out', () => {
    const listsOf = (r: RepoHandle) => reg.changelistsFor(r).getLists();
    const namedIn = (r: RepoHandle, name: string) => listsOf(r).find((l) => l.name === name);

    teardown(() => {
      // Every repository, not just this suite's two: `changelist.new` creates
      // the list project-wide, so cleaning only D and E would leave an extra
      // changelist in the repos three other suites assert against — and an
      // extra list changes quick-pick option counts, which is enough to hang a
      // prompt that only appears when there is more than one choice.
      for (const r of core.repos) {
        for (const l of listsOf(r)) {
          if (!l.isDefault) reg.changelistsFor(r).remove(l.id);
        }
      }
    });

    test('a new changelist is created in every repository, not just the active one', async function () {
      this.timeout(60_000);
      const saved = process.env['GITTREE_TEST_BRANCH_NAME'];
      process.env['GITTREE_TEST_BRANCH_NAME'] = 'Feature Fanout';
      try {
        await vscode.commands.executeCommand('gittree.changelist.new');
      } finally {
        if (saved === undefined) delete process.env['GITTREE_TEST_BRANCH_NAME'];
        else process.env['GITTREE_TEST_BRANCH_NAME'] = saved;
      }
      // Present everywhere, so the merged row is real and `Move to…` offers it
      // in whichever repository the file happens to live.
      for (const r of core.repos) {
        assert.ok(namedIn(r, 'Feature Fanout'), `missing in ${labelOf(r)}`);
      }
    });

    test('an action on a merged row reaches every repository behind it', async function () {
      this.timeout(60_000);
      for (const r of [repoD, repoE]) reg.changelistsFor(r).create('Shared', undefined, false);
      const targets = [repoD, repoE].map((r) => ({
        repoRoot: r.root,
        listId: namedIn(r, 'Shared')!.id,
      }));
      // The ids differ per repository — which is exactly why a merged row has to
      // carry `targets` rather than one {repoRoot, listId} it could guess from.
      assert.notStrictEqual(targets[0]!.listId, targets[1]!.listId);
      for (const r of [repoD, repoE]) {
        assert.ok(listsOf(r).find((l) => l.isDefault)?.isActive, 'default starts active');
      }

      // setActive is the fan-out under test: no prompts, so the plumbing is
      // what is being measured rather than a dialog seam.
      await vscode.commands.executeCommand('gittree.changelist.setActive', { targets });

      for (const r of [repoD, repoE]) {
        assert.strictEqual(
          listsOf(r).find((l) => l.isActive)?.name,
          'Shared',
          `${labelOf(r)} kept its own active list; the fan-out missed it`,
        );
      }
      // A scoped row still means one repository, and must not touch the other.
      await vscode.commands.executeCommand('gittree.changelist.setActive', {
        repoRoot: repoD.root,
        listId: listsOf(repoD).find((l) => l.isDefault)!.id,
      });
      assert.ok(listsOf(repoD).find((l) => l.isDefault)?.isActive, 'repoD scoped back to default');
      assert.strictEqual(
        listsOf(repoE).find((l) => l.isActive)?.name,
        'Shared',
        'a scoped action must not reach a second repository',
      );
    });

    test('committing a merged row commits that list in each repository', async function () {
      this.timeout(90_000);
      for (const r of [repoD, repoE]) reg.changelistsFor(r).create('Batch', undefined, false);
      await tick(repoD, '# repoD merged list\n');
      await tick(repoE, '# repoE merged list\n');
      // Move each repo's README into its own copy of the shared list.
      for (const r of [repoD, repoE]) {
        reg.changelistsFor(r).moveFiles(['README.md'], namedIn(r, 'Batch')!.id);
        reg.changelistsFor(r).setListChecked(namedIn(r, 'Batch')!.id, true);
      }
      const targets = [repoD, repoE].map((r) => ({
        repoRoot: r.root,
        listId: namedIn(r, 'Batch')!.id,
      }));

      const beforeD = headOf(repoD);
      const beforeE = headOf(repoE);
      await focus(repoD);
      reg.commitWindow.messageBoxFor(repoD).value = 'merged changelist across both repos';

      await commitWith(() =>
        vscode.commands.executeCommand('gittree.changelist.commitList', { targets }),
      );

      await waitFor(() => headOf(repoD) !== beforeD && headOf(repoE) !== beforeE, 60_000);
      for (const r of [repoD, repoE]) {
        assert.strictEqual(
          subjectOf(r),
          'merged changelist across both repos',
          `${labelOf(r)} did not commit the merged changelist`,
        );
      }
    });
  });

  /**
   * POST-P14bf: the Unversioned Files rows, a repository's share of them and a
   * folder row act on every file beneath them, as IntelliJ's actions act on a
   * node's files. Every file made here is taken back out of the index and off
   * the disk, and every list made is removed, so the suites after this one find
   * the repositories as the runner made them.
   */
  suite('Unversioned Files and folder rows', () => {
    const made: Array<[RepoHandle, string]> = [];
    const listsOf = (r: RepoHandle) => reg.changelistsFor(r).getLists();
    const status = (r: RepoHandle): string => gitWithRetry(r.root, ['status', '--porcelain', '-uall']);

    function newFile(r: RepoHandle, rel: string): void {
      const abs = path.join(r.root, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, `export const made = '${rel}';\n`);
      made.push([r, rel]);
    }

    async function refreshed(r: RepoHandle, until: () => boolean): Promise<void> {
      await r.refresher.refreshNow();
      await waitFor(until, 20_000);
    }

    teardown(async function () {
      this.timeout(60_000);
      for (const [r, rel] of made) {
        gitWithRetry(r.root, ['rm', '--cached', '-q', '--ignore-unmatch', '--', rel]);
        fs.rmSync(path.join(r.root, rel), { force: true });
      }
      for (const [r, rel] of made) {
        const top = rel.split('/')[0]!;
        if (top !== rel) fs.rmSync(path.join(r.root, top), { recursive: true, force: true });
      }
      made.length = 0;
      for (const r of core.repos) {
        for (const l of listsOf(r)) if (!l.isDefault) reg.changelistsFor(r).remove(l.id);
      }
      await Promise.all([repoD.refresher.refreshNow(), repoE.refresher.refreshNow()]);
    });

    test("Add to VCS on Unversioned Files adds each repository's new files, into its default list", async function () {
      this.timeout(60_000);
      newFile(repoD, 'pending/one.ts');
      newFile(repoD, 'pending/two.ts');
      newFile(repoE, 'pending-e.ts');
      await refreshed(repoD, () => reg.changelistsFor(repoD).unversioned().includes('pending/two.ts'));
      await refreshed(repoE, () => reg.changelistsFor(repoE).unversioned().includes('pending-e.ts'));

      // The merged Unversioned Files row's payload: one target per repository.
      await vscode.commands.executeCommand('gittree.addToVcs', {
        webviewSection: 'commitGroup',
        listIsUnversioned: true,
        targets: [
          { repoRoot: repoD.root, listId: '__unversioned__' },
          { repoRoot: repoE.root, listId: '__unversioned__' },
        ],
      });

      // Intent to add: tracked now, its content not in the index.
      assert.match(status(repoD), /^ A pending\/one\.ts$/mu);
      assert.match(status(repoD), /^ A pending\/two\.ts$/mu);
      assert.match(status(repoE), /^ A pending-e\.ts$/mu);
      await refreshed(repoD, () => reg.changelistsFor(repoD).unversioned().length === 0);
      const defaultD = listsOf(repoD).find((l) => l.isDefault)!;
      assert.ok(defaultD.files.includes('pending/one.ts') && defaultD.files.includes('pending/two.ts'), 'in the default list');
      await refreshed(repoE, () => listsOf(repoE).find((l) => l.isDefault)!.files.includes('pending-e.ts'));
    });

    test('Move to Another Changelist… adds new files to VCS in the list picked, made where missing', async function () {
      this.timeout(60_000);
      reg.changelistsFor(repoD).create('Incoming', undefined, false);
      newFile(repoD, 'moved/d.ts');
      newFile(repoE, 'moved/e.ts');
      await refreshed(repoD, () => reg.changelistsFor(repoD).unversioned().includes('moved/d.ts'));
      await refreshed(repoE, () => reg.changelistsFor(repoE).unversioned().includes('moved/e.ts'));

      const saved = process.env['GITTREE_TEST_CHANGELIST_PICK'];
      process.env['GITTREE_TEST_CHANGELIST_PICK'] = 'Incoming';
      try {
        await vscode.commands.executeCommand('gittree.changelist.moveTo', {
          webviewSection: 'commitGroup',
          listIsUnversioned: true,
          targets: [
            { repoRoot: repoD.root, listId: '__unversioned__' },
            { repoRoot: repoE.root, listId: '__unversioned__' },
          ],
        });
      } finally {
        if (saved === undefined) delete process.env['GITTREE_TEST_CHANGELIST_PICK'];
        else process.env['GITTREE_TEST_CHANGELIST_PICK'] = saved;
      }

      for (const [r, rel] of [
        [repoD, 'moved/d.ts'],
        [repoE, 'moved/e.ts'],
      ] as const) {
        const incoming = listsOf(r).find((l) => l.name === 'Incoming');
        assert.ok(incoming, `${labelOf(r)} has an Incoming list, made there if it had none`);
        assert.ok(incoming.files.includes(rel), `${rel} moved into ${labelOf(r)}'s Incoming`);
        // IntelliJ's Move adds unversioned files to VCS in the list it moves them to.
        assert.match(status(r), new RegExp(`^ A ${rel.replace('.', '\\.')}$`, 'mu'));
      }
      await refreshed(repoD, () => listsOf(repoD).find((l) => l.name === 'Incoming')!.files.includes('moved/d.ts'));
    });

    test('Add to VCS leaves a new file already moved into a list in that list', async function () {
      this.timeout(60_000);
      const keep = reg.changelistsFor(repoD).create('Keep', undefined, false);
      newFile(repoD, 'kept.ts');
      await refreshed(repoD, () => reg.changelistsFor(repoD).unversioned().includes('kept.ts'));
      reg.changelistsFor(repoD).moveFiles(['kept.ts'], keep.id);

      await vscode.commands.executeCommand('gittree.addToVcs', {
        webviewSection: 'commitFile',
        repoRoot: repoD.root,
        relPath: 'kept.ts',
        relPaths: ['kept.ts'],
      });

      assert.match(status(repoD), /^ A kept\.ts$/mu);
      await repoD.refresher.refreshNow();
      assert.ok(listsOf(repoD).find((l) => l.id === keep.id)?.files.includes('kept.ts'), 'still in Keep');
    });

    test('Add to .gitignore on a folder of new files writes one rule for the folder', async function () {
      this.timeout(60_000);
      const ignoreFile = path.join(repoD.root, '.gitignore');
      const before = fs.existsSync(ignoreFile) ? fs.readFileSync(ignoreFile, 'utf8') : undefined;
      try {
        newFile(repoD, 'scratch-dir/a.txt');
        newFile(repoD, 'scratch-dir/b.txt');
        await refreshed(repoD, () => reg.changelistsFor(repoD).unversioned().includes('scratch-dir/b.txt'));

        await vscode.commands.executeCommand('gittree.gitignore.add', {
          webviewSection: 'commitFolder',
          repoRoot: repoD.root,
          relPath: 'scratch-dir/a.txt',
          relPaths: ['scratch-dir/a.txt', 'scratch-dir/b.txt'],
          folder: 'scratch-dir',
        });

        const lines = fs.readFileSync(ignoreFile, 'utf8').split(/\r?\n/u);
        assert.ok(lines.includes('/scratch-dir/'), 'the folder, as IntelliJ writes it');
        assert.ok(!lines.includes('/scratch-dir/a.txt'), 'not a line per file');
      } finally {
        if (before === undefined) fs.rmSync(ignoreFile, { force: true });
        else fs.writeFileSync(ignoreFile, before);
      }
    });

    test('Add to .gitignore on a folder git tracks something in writes a rule per new file', async function () {
      this.timeout(60_000);
      const ignoreFile = path.join(repoD.root, '.gitignore');
      const before = fs.existsSync(ignoreFile) ? fs.readFileSync(ignoreFile, 'utf8') : undefined;
      try {
        newFile(repoD, 'mixed/keep.ts');
        gitWithRetry(repoD.root, ['add', '-N', '--', 'mixed/keep.ts']);
        newFile(repoD, 'mixed/new.txt');
        await refreshed(repoD, () => reg.changelistsFor(repoD).unversioned().includes('mixed/new.txt'));

        await vscode.commands.executeCommand('gittree.gitignore.add', {
          webviewSection: 'commitFolder',
          repoRoot: repoD.root,
          relPath: 'mixed/new.txt',
          relPaths: ['mixed/new.txt'],
          folder: 'mixed',
        });

        const lines = fs.readFileSync(ignoreFile, 'utf8').split(/\r?\n/u);
        // `/mixed/` would also hide every file added to mixed/ later.
        assert.ok(lines.includes('/mixed/new.txt'), 'the new file');
        assert.ok(!lines.includes('/mixed/'), 'never the folder git tracks a file in');
      } finally {
        if (before === undefined) fs.rmSync(ignoreFile, { force: true });
        else fs.writeFileSync(ignoreFile, before);
      }
    });
  });
});
