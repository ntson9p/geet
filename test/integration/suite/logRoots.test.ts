import * as assert from 'node:assert';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { Phase04Registry } from '../../../src/log/register';
import type { Core, RepoHandle } from '../../../src/core/core';
import { activateGeet, gitWithRetry, waitFor, workspaceRepoA, workspaceRepoB } from '../setup';

/**
 * `Paths ▾ · Roots`, and the repository the log renders.
 *
 * The log shows one repository. It used to *re-derive* which one from the
 * focused editor on every re-init — and `startSession` runs on every filter
 * change, refresh and rehydrate — so a filter change while a file from another
 * repository happened to be focused moved the log there and re-ran the filter
 * against it. A `paths` entry is repo-relative and a `refs` entry names one
 * repository's branches, so the move either emptied the log or failed the page
 * read on `unknown revision`. Nothing said which repository was on show and
 * nothing let you choose one.
 *
 * Read-only by construction: every assertion here uses history and files the
 * fixtures already have. The shared state it does move is which root the log
 * is pinned to, which the teardown puts back, and one branch a test makes in
 * repoA and deletes again.
 */
suite('Log roots & path filter', () => {
  let core: Core;
  let reg: Phase04Registry;
  let repoA: RepoHandle;
  let repoB: RepoHandle;
  let restoreRoot: string | undefined;

  const session = () => reg.logView.currentSession!;

  suiteSetup(async function () {
    this.timeout(60_000);
    core = await activateGeet();
    reg = core.debugRegistry.get('phase04') as Phase04Registry;
    assert.ok(reg, 'phase04 registry missing');
    repoA = core.repoForPath(workspaceRepoA())!;
    repoB = core.repoForPath(workspaceRepoB())!;
    assert.ok(repoA && repoB, 'fixture repositories missing');
    await vscode.commands.executeCommand('geet.log.focus');
    await waitFor(() => reg.logView.currentSession !== undefined, 30_000);
    restoreRoot = reg.logView.currentSession?.repoRoot;
  });

  suiteTeardown(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    if (restoreRoot !== undefined) reg.logView.showRoot(restoreRoot);
    await reg.logView.setFilter({ sort: 'topo', refs: 'HEAD' }, restoreRoot);
  });

  test('Roots lists every repository in the workspace, each distinctly named', function () {
    this.timeout(30_000);
    const roots = reg.logView.currentSession!.roots;
    assert.strictEqual(
      roots.length,
      core.repos.length,
      'the section is the workspace, not the repositories one feature happens to know about',
    );
    const keys = new Set(roots.map((r) => r.root));
    for (const repo of core.repos) {
      assert.ok(keys.has(repo.root), `${path.basename(repo.root)} is missing from Roots`);
    }
    // Two rows reading the same is a chooser you cannot choose with.
    const labels = roots.map((r) => r.label);
    assert.strictEqual(new Set(labels).size, labels.length, `labels collide: ${labels.join(', ')}`);
    assert.ok(labels.every((l) => l.length > 0));
  });

  test('the log holds its root when a file from another repository is focused', async function () {
    this.timeout(60_000);
    reg.logView.showRoot(repoB.root);
    assert.strictEqual(session().repoRoot, repoB.root);

    // Exactly the reported sequence: work in one repository, look at another's
    // log, touch a filter. The root used to follow the editor, silently.
    await vscode.window.showTextDocument(
      await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(repoA.root, 'README.md'))),
    );
    await reg.logView.setFilter({ sort: 'date', refs: 'HEAD' });
    assert.strictEqual(
      session().repoRoot,
      repoB.root,
      'a filter change is not a request to change repository',
    );

    reg.logView.refresh();
    assert.strictEqual(session().repoRoot, repoB.root, 'neither is a refresh');
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });

  test('switching root drops the repo-relative filter and keeps the portable part', async function () {
    this.timeout(60_000);
    reg.logView.showRoot(repoA.root);
    const branchA = gitWithRetry(repoA.root, ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
    await reg.logView.setFilter(
      {
        sort: 'date',
        refs: [branchA],
        paths: ['src'],
        follow: true,
        authors: ['Geet Test'],
        dateRange: { from: '2000-01-01' },
        text: { q: 'initial', regex: false, matchCase: false },
      },
      repoA.root,
    );
    assert.deepStrictEqual(reg.logView.currentSession!.filter.refs, [branchA]);

    reg.logView.showRoot(repoB.root);
    const after = reg.logView.currentSession!.filter;
    assert.strictEqual(session().repoRoot, repoB.root);
    // `src` does not exist in repoB: picking a root is picking the paths afresh.
    assert.strictEqual(after.paths, undefined, 'paths are repo-relative');
    assert.strictEqual(after.follow, undefined, 'follow rides on a single path');
    assert.strictEqual(after.range, undefined);
    // POST-P14bh: the Branch selection stays, as IntelliJ's filters stay when
    // its roots change. A name repoB lacks is left out of the read instead.
    assert.deepStrictEqual(after.refs, [branchA], 'the Branch selection survives the switch');
    // Nothing about an author or a date is repo-relative, so nothing is lost.
    assert.deepStrictEqual(after.authors, ['Geet Test']);
    assert.deepStrictEqual(after.dateRange, { from: '2000-01-01' });
    assert.strictEqual(after.text?.q, 'initial');
    assert.strictEqual(after.sort, 'date');
  });

  test('a branch only one repository has: kept across the switch, and the other log says it is missing', async function () {
    this.timeout(90_000);
    // The owner's report: Paths ▾ reset Branch ▾ to HEAD. Now the selection
    // stays even where the repository picked lacks the branch.
    const onlyInA = `gt-only-in-a-${Date.now()}`;
    gitWithRetry(repoA.root, ['branch', onlyInA]);
    const branchB = gitWithRetry(repoB.root, ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
    try {
      reg.logView.showRoot(repoA.root);
      await reg.logView.setFilter({ sort: 'date', refs: [onlyInA] }, repoA.root);
      await waitFor(() => (reg.logView.currentSession?.rowCount ?? 0) > 0, 30_000);
      assert.deepStrictEqual(session().missingRefs, []);

      reg.logView.showRoot(repoB.root);
      assert.strictEqual(session().repoRoot, repoB.root);
      assert.deepStrictEqual(session().filter.refs, [onlyInA], 'Branch ▾ keeps what was picked');
      // git would refuse the whole log over the unknown name; the read leaves
      // it out, finds nothing left, and says which name was missing.
      await waitFor(() => reg.logView.currentSession?.eof === true, 30_000);
      assert.strictEqual(session().rowCount, 0, 'repoB has nothing on a branch it does not have');
      assert.deepStrictEqual(session().missingRefs, [onlyInA]);

      // With a branch repoB does have beside it, that one's history shows.
      await reg.logView.setFilter({ sort: 'date', refs: [onlyInA, branchB] }, repoB.root);
      await waitFor(() => (reg.logView.currentSession?.rowCount ?? 0) > 0, 30_000);
      assert.deepStrictEqual(session().missingRefs, [onlyInA]);

      // And back in repoA, the branch is there again.
      reg.logView.showRoot(repoA.root);
      assert.deepStrictEqual(session().filter.refs, [onlyInA, branchB]);
      await waitFor(() => (reg.logView.currentSession?.rowCount ?? 0) > 0, 30_000);
      assert.ok(!session().missingRefs.includes(onlyInA), 'repoA has its own branch');
    } finally {
      await reg.logView.setFilter({ sort: 'topo', refs: 'HEAD' }, repoA.root);
      gitWithRetry(repoA.root, ['branch', '-D', onlyInA]);
    }
  });

  test('a root outside the workspace is refused rather than guessed at', function () {
    this.timeout(30_000);
    reg.logView.showRoot(repoB.root);
    assert.strictEqual(reg.logView.showRoot(path.join(repoB.root, 'no-such-repo')), false);
    assert.strictEqual(session().repoRoot, repoB.root, 'a refused switch leaves the log alone');
    assert.strictEqual(reg.logView.showRoot(repoB.root), true, 're-picking the current root is a no-op');
  });

  test('Show File History follows the file’s repository, not the focused editor', async function () {
    this.timeout(60_000);
    // Pinned to A, asked about a file in B — the Explorer context menu can do
    // exactly this, and the relative path it computes belongs to B.
    reg.logView.showRoot(repoA.root);
    await vscode.commands.executeCommand(
      'geet.showFileHistory',
      vscode.Uri.file(path.join(repoB.root, 'README.md')),
    );
    await waitFor(() => reg.logView.currentSession?.repoRoot === repoB.root, 20_000);
    const filter = reg.logView.currentSession!.filter;
    assert.deepStrictEqual(filter.paths, ['README.md']);
    assert.strictEqual(filter.follow, true);
    // The filter is only right *because* it ran in B; in A it would have been
    // a path filter over a file that repository never had.
    await waitFor(() => (reg.logView.currentSession?.rowCount ?? 0) > 0, 30_000);
  });

  test('Compare with Current runs in the repository whose branch it names', async function () {
    this.timeout(60_000);
    reg.logView.showRoot(repoA.root);
    const branchB = gitWithRetry(repoB.root, ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
    await vscode.commands.executeCommand('geet.branches.compareInLog', repoB.root, branchB);
    await waitFor(() => reg.logView.currentSession?.repoRoot === repoB.root, 20_000);
    assert.strictEqual(reg.logView.currentSession!.filter.range?.a, branchB);
  });

  test('revealCommit lands in the repository the sha came from, wide enough to find it', async function () {
    this.timeout(90_000);
    reg.logView.showRoot(repoA.root);
    await reg.logView.setFilter(
      { sort: 'date', refs: 'HEAD', text: { q: 'nothing-matches-this', regex: false, matchCase: false } },
      repoA.root,
    );
    const headB = gitWithRetry(repoB.root, ['rev-parse', 'HEAD']).trim();
    await reg.logView.revealCommit(headB, repoB.root);
    assert.strictEqual(
      session().repoRoot,
      repoB.root,
      'the root argument used to be dropped, so this paged A looking for B’s sha',
    );
    // Reveal inside one repository respects its filter; there is no filter for
    // a repository the log has not been showing, and another one's text query
    // would have hidden the very commit that was asked for.
    const after = session().filter;
    assert.strictEqual(after.refs, 'ALL');
    assert.strictEqual(after.text, undefined);
    assert.strictEqual(after.sort, 'date', 'the sort is the one thing that always travels');
    await waitFor(() => (reg.logView.currentSession?.rowCount ?? 0) > 0, 30_000);
    assert.ok(
      reg.logView.currentSession!.rowCount > 0 &&
        gitWithRetry(repoB.root, ['cat-file', '-t', headB]).trim() === 'commit',
      'the sha the log was pointed at belongs to B',
    );
  });
});
