import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { Phase03Registry } from '../../../src/commit/register';
import type { Core, RepoHandle } from '../../../src/core/core';
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
    // and several later suites resolve "the repository to act on" from the
    // active editor (logView.activeRepo, pickRepo). Leaving one open points
    // them at repoD/repoE, where the shas they were given do not exist.
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

    // No repo argument: the palette / Ctrl+K / commit-button path.
    await commitWith(() => vscode.commands.executeCommand('gittree.commit'));

    await waitFor(() => headOf(repoD) !== beforeD && headOf(repoE) !== beforeE, 60_000);
    assert.strictEqual(subjectOf(repoD), message, 'repoD committed with the typed message');
    assert.strictEqual(subjectOf(repoE), message, 'repoE committed with the same message');

    // The message was typed into repoD's box; repoE has its own, and reading it
    // instead of the one handed down would have rejected repoE as empty.
    for (const [repo, head] of untouched) {
      assert.strictEqual(
        headOf(repo),
        head,
        `${labelOf(repo)} had nothing ticked and must not have been committed`,
      );
    }
    assert.deepStrictEqual(
      ourTargets(),
      [],
      'both repos are clean again, so nothing is targeted',
    );
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
});
