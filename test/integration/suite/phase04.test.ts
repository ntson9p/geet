import * as assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { RepoHandle } from '../../../src/core/core';
import type { Phase04Registry } from '../../../src/log/register';
import { activateGitTree, gitWithRetry, waitFor, workspaceRepoA } from '../setup';

/** Phase 4 host-side acceptance (webview internals covered by Playwright). */
suite('P4 log & blame host', () => {
  let repoRoot: string;
  let fsRoot: string;
  let reg: Phase04Registry;
  let repo: RepoHandle;

  const git = (...args: string[]): string => gitWithRetry(repoRoot, args);

  suiteSetup(async function () {
    this.timeout(60_000);
    repoRoot = workspaceRepoA();
    const core = await activateGitTree();
    repo = core.repoForPath(repoRoot)!;
    fsRoot = repo.root;
    reg = core.debugRegistry.get('phase04') as Phase04Registry;
    assert.ok(reg, 'phase04 registry missing');
    // The log shows one repository at a time and holds it; claim repoA so this
    // suite does not inherit whichever root ran before it.
    reg.logView.showRoot(fsRoot);
  });

  test('log view boots a session and streams rows', async function () {
    this.timeout(60_000);
    await vscode.commands.executeCommand('gittree.log.focus');
    await waitFor(() => (reg.logView.currentSession?.rowCount ?? 0) > 0, 30_000).catch((err: Error) => {
      const root = reg.logView.currentSession?.repoRoot ?? repoRoot;
      let replay = '';
      try {
        const out = execFileSync(
          'git',
          [
            'log',
            '--format=%H%x00%P%x00%an%x00%ae%x00%at%x00%cn%x00%ct%x00%D%x00%s%x00%b%x1e',
            '--parents',
            '--topo-order',
            '--skip=0',
            '--max-count=2000',
          ],
          { cwd: root, encoding: 'latin1' },
        );
        replay = `replay bytes=${out.length} frames=${out.split('\x1e').length - 1}`;
      } catch (e) {
        replay = `replay failed: ${String(e)}`;
      }
      throw new Error(
        `${err.message} — trail: ${JSON.stringify(reg.logView.debugTrail)} — ${replay}`,
      );
    });
    const session = reg.logView.currentSession!;
    assert.ok(session.repoRoot.length > 0);
    // POST-P14y: the log opens in date order, IntelliJ's default.
    assert.strictEqual(session.filter.sort, 'date');
  });

  test('the graph re-pages itself when history moves — no manual refresh', async function () {
    this.timeout(90_000);
    await vscode.commands.executeCommand('gittree.log.focus');
    await waitFor(() => (reg.logView.currentSession?.rowCount ?? 0) > 0, 30_000);
    const before = reg.logView.currentSession!.rowCount;
    const autoBefore = reg.logView.autoRefreshCount;
    const headBefore = git('rev-parse', 'HEAD').trim();

    // An empty commit moves refs/heads/* without touching the worktree, so the
    // restore below cannot destroy anything this test did not create.
    git('commit', '--allow-empty', '-m', 'p4 auto-refresh probe');
    // Deliberately NOT calling gittree.log.refresh: the model event alone has
    // to re-page the graph. refreshNow() stands in for the fs watcher so the
    // assertion measures model→log view, not watcher latency (P0-T6 covers
    // that path separately).
    await repo.refresher.refreshNow();
    await waitFor(() => (reg.logView.currentSession?.rowCount ?? 0) > before, 30_000);
    assert.ok(
      reg.logView.autoRefreshCount > autoBefore,
      'the re-page came from the auto-refresh path',
    );

    // ...and it follows history back down again.
    git('reset', '--hard', headBefore);
    await repo.refresher.refreshNow();
    await waitFor(() => (reg.logView.currentSession?.rowCount ?? 0) === before, 30_000);
  });

  test('a status-only change never re-pages the graph', async function () {
    this.timeout(60_000);
    await vscode.commands.executeCommand('gittree.log.focus');
    await waitFor(() => (reg.logView.currentSession?.rowCount ?? 0) > 0, 30_000);
    const autoBefore = reg.logView.autoRefreshCount;

    // A dirty worktree fires `status` and nothing else. Re-paging on that
    // would cost a `git log` per save in a watched file.
    const scratch = path.join(fsRoot, 'p4-status-only.txt');
    fs.writeFileSync(scratch, `touched ${Date.now()}\n`);
    try {
      await waitFor(
        () => repo.model.snapshot.statusEntries.some((e) => e.path === 'p4-status-only.txt'),
        20_000,
      );
      await repo.refresher.refreshNow();
      await new Promise((r) => setTimeout(r, 1000)); // past the 300ms debounce
      assert.strictEqual(
        reg.logView.autoRefreshCount,
        autoBefore,
        'status alone must not re-page the graph',
      );
    } finally {
      fs.rmSync(scratch, { force: true });
    }
  });

  test('a page asked for twice while it is being read is laid out once', async function () {
    this.timeout(60_000);
    await reg.logView.setFilter({ sort: 'date', refs: 'HEAD' }, fsRoot);
    await waitFor(() => reg.logView.currentSession?.eof === true, 30_000);
    const commits = Number(git('rev-list', '--count', 'HEAD').trim());
    // A fresh session, and its page 0 asked for twice while it is read: what
    // `rehydrate` re-posting the webview's unanswered request amounts to. Read
    // twice, the page went through the graph layout twice and the session held
    // every commit twice.
    assert.ok(reg.logView.refresh(), 'the tab has a session to re-read');
    await Promise.all([reg.logView.requestPage(0), reg.logView.requestPage(0)]);
    await waitFor(() => reg.logView.currentSession?.eof === true, 30_000);
    assert.strictEqual(
      reg.logView.currentSession!.rowCount,
      commits,
      `trail: ${JSON.stringify(reg.logView.debugTrail.slice(-8))}`,
    );
  });

  test('a commit made from outside just after a GitTree operation reaches the model and the log', async function () {
    this.timeout(60_000);
    await vscode.commands.executeCommand('gittree.log.focus');
    await waitFor(() => (reg.logView.currentSession?.rowCount ?? 0) > 0, 30_000);
    const headBefore = git('rev-parse', 'HEAD').trim();
    const rowsBefore = reg.logView.currentSession!.rowCount;
    // A GitTree operation: for a second after it ends, the queue calls every
    // watcher event ours.
    await repo.queue.enqueue({
      label: 'p4 probe operation',
      kind: 'mutate',
      quietProgress: true,
      run: () => Promise.resolve(),
    });
    // Its post-op refresh reads…
    await new Promise((r) => setTimeout(r, 400));
    try {
      // …and then a commit lands from a terminal, inside that second. Its
      // events used to be dropped as ours, with no refresh left to read them.
      git('commit', '--allow-empty', '-m', 'p4 commit from outside');
      if (!repo.queue.isSelfInflicted(Date.now())) {
        // Too slow a machine to land it inside the window: nothing to measure.
        this.skip();
      }
      const made = git('rev-parse', 'HEAD').trim();
      // No refreshNow(): the watcher alone has to bring it in.
      await waitFor(() => repo.model.snapshot.headSha === made, 10_000);
      await waitFor(() => (reg.logView.currentSession?.rowCount ?? 0) > rowsBefore, 30_000);
    } finally {
      git('reset', '--hard', headBefore);
      await repo.refresher.refreshNow();
    }
  });

  test('revealCommit loads pages until the sha is present', async function () {
    this.timeout(60_000);
    const head = git('rev-parse', 'HEAD').trim();
    await reg.logView.revealCommit(head);
    assert.ok((reg.logView.currentSession?.rowCount ?? 0) > 0);
  });

  test('file history opens the log in --follow path mode', async function () {
    this.timeout(60_000);
    const target = vscode.Uri.file(path.join(fsRoot, 'README.md'));
    await vscode.commands.executeCommand('gittree.showFileHistory', target);
    await waitFor(() => reg.logView.currentSession?.filter.follow === true, 15_000);
    const filter = reg.logView.currentSession!.filter;
    assert.deepStrictEqual(filter.paths, ['README.md']);
    assert.strictEqual(filter.refs, 'ALL');
  });

  test('compare-in-log sets a range filter (P2-T5 upgrade)', async function () {
    this.timeout(60_000);
    git('branch', '-f', 'p4-compare', 'HEAD');
    await vscode.commands.executeCommand('gittree.branches.compareInLog', repoRoot, 'p4-compare');
    await waitFor(() => reg.logView.currentSession?.filter.range !== undefined, 15_000);
    assert.strictEqual(reg.logView.currentSession!.filter.range!.a, 'p4-compare');
    git('branch', '-D', 'p4-compare');
  });

  test('commit actions: branch/tag here, reset soft round-trip', async function () {
    this.timeout(60_000);
    const head = git('rev-parse', 'HEAD').trim();
    const parent = git('rev-parse', 'HEAD~1').trim();

    process.env['GITTREE_TEST_BRANCH_NAME'] = 'p4/action-branch';
    try {
      await vscode.commands.executeCommand('gittree.log.createBranchHere', { sha: head });
    } finally {
      delete process.env['GITTREE_TEST_BRANCH_NAME'];
    }
    assert.ok(git('branch', '--list', 'p4/action-branch').includes('p4/action-branch'));
    git('branch', '-D', 'p4/action-branch');

    process.env['GITTREE_TEST_BRANCH_NAME'] = 'p4-tag';
    try {
      await vscode.commands.executeCommand('gittree.log.createTagHere', { sha: head });
    } finally {
      delete process.env['GITTREE_TEST_BRANCH_NAME'];
    }
    assert.ok(git('tag', '--list', 'p4-tag').includes('p4-tag'));
    git('tag', '-d', 'p4-tag');

    process.env['GITTREE_TEST_RESET_MODE'] = 'soft';
    try {
      await vscode.commands.executeCommand('gittree.log.resetHere', { sha: parent });
    } finally {
      delete process.env['GITTREE_TEST_RESET_MODE'];
    }
    await waitFor(() => git('rev-parse', 'HEAD').trim() === parent, 15_000);
    // Restore (the commit is still referenced by the soft-reset index).
    git('reset', '--soft', head);
    assert.strictEqual(git('rev-parse', 'HEAD').trim(), head);
  });

  test('copy revision number writes the clipboard', async function () {
    this.timeout(30_000);
    // The Windows clipboard is a shared, lockable OS resource: under a
    // disconnected RDP session (no rdpclip) or a clipboard-manager collision,
    // writes vanish and reads return ''. Probe first and skip as a capability
    // gap rather than failing the suite on an environment defect; the command
    // path itself is still asserted wherever a clipboard exists.
    const roundTrips = async (text: string): Promise<boolean> => {
      for (let attempt = 0; attempt < 5; attempt++) {
        await vscode.env.clipboard.writeText(text);
        if ((await vscode.env.clipboard.readText()) === text) return true;
        await new Promise((r) => setTimeout(r, 200));
      }
      return false;
    };
    if (!(await roundTrips('gittree-clipboard-probe'))) {
      this.skip();
    }

    const head = git('rev-parse', 'HEAD').trim();
    for (let attempt = 0; attempt < 5; attempt++) {
      await vscode.commands.executeCommand('gittree.log.copySha', { sha: head });
      if ((await vscode.env.clipboard.readText()) === head) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    assert.strictEqual(await vscode.env.clipboard.readText(), head);
  });

  test('reveal reports a commit the filter hides instead of doing nothing', async function () {
    this.timeout(90_000);
    await vscode.commands.executeCommand('gittree.log.focus');
    await reg.logView.setFilter({ sort: 'topo', refs: 'HEAD' } as never, fsRoot);
    await waitFor(() => (reg.logView.currentSession?.rowCount ?? 0) > 0, 30_000);
    const head = git('rev-parse', 'HEAD').trim();
    const baseRows = reg.logView.currentSession!.rowCount;

    // A real commit that HEAD cannot reach: `refs: 'HEAD'` is the DEFAULT
    // filter, so this is the everyday case, not a contrived one.
    git('commit', '--allow-empty', '-m', 'p4 off-branch probe');
    const offBranch = git('rev-parse', 'HEAD').trim();
    git('reset', '--hard', head);
    git('branch', 'p4-offbranch', offBranch);
    try {
      await repo.refresher.refreshNow();
      await waitFor(() => (reg.logView.currentSession?.rowCount ?? 0) === baseRows, 30_000);
      assert.strictEqual(
        git('rev-parse', '--verify', `${offBranch}^{commit}`).trim(),
        offBranch,
        'precondition: git agrees the commit is real',
      );

      assert.strictEqual(
        await reg.logView.revealCommit(offBranch, fsRoot),
        false,
        'a commit outside the filter is reported as not revealed',
      );
      assert.ok(
        !reg.logView.selectedCommits.includes(offBranch),
        'and nothing was selected behind the report',
      );

      // The same commit under a filter that does not hide it.
      await reg.logView.setFilter({ sort: 'topo', refs: 'ALL' } as never, fsRoot);
      await waitFor(() => (reg.logView.currentSession?.rowCount ?? 0) > baseRows, 30_000);
      assert.strictEqual(
        await reg.logView.revealCommit(offBranch, fsRoot),
        true,
        'and it reveals normally once the filter admits it',
      );
    } finally {
      git('branch', '-D', 'p4-offbranch');
      await reg.logView.setFilter({ sort: 'topo', refs: 'HEAD' } as never, fsRoot);
    }
  });

  test('blame follows a commit, and never reports a superseded sha', async function () {
    this.timeout(120_000);
    const base = git('rev-parse', 'HEAD').trim();
    const target = path.join(fsRoot, 'src', 'a.ts');
    const original = fs.readFileSync(target, 'utf8');
    try {
      // Start from a known slate. Everything BlameUi does resolves from the
      // ACTIVE editor, and this shared window accumulates tabs from earlier
      // suites — including `gittree-rev:` documents opened into a multi-diff
      // (phase02's compare). While one of those is the active tab,
      // `showTextDocument` does not win `activeTextEditor` back, so the
      // annotation would be computed for someone else's file no matter how
      // many times this test asked for its own.
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(target));
      const editor = await vscode.window.showTextDocument(doc);
      await editor.edit((b) =>
        b.replace(new vscode.Range(0, 0, 0, doc.lineAt(0).text.length), 'export const a = 42; // p4'),
      );
      await doc.save();
      const versionAtBlame = doc.version;

      if (!reg.blameUi.isEnabled(doc)) await reg.blameUi.toggle(editor);
      /**
       * `cursorCommit` answers for whatever editor is ACTIVE, and this shared
       * window carries stray tabs between suites (phase02's compare tab is
       * never closed), so each read re-asserts the target instead of assuming
       * it still has focus. Polling rather than asserting once is also correct
       * on its own terms: a blame that straddled a HEAD move is deliberately
       * not cached, and the head watcher re-runs it a beat later.
       *
       * `waitFor` cannot be used — its predicate is synchronous, so an async
       * one would resolve to a truthy Promise and pass without ever checking.
       */
      const blameSettlesOn = async (
        want: (lb: ReturnType<typeof reg.blameUi.cursorCommit>) => boolean,
        what: string,
        /** Drive the recompute (setup), or let the head watcher do it (the assertion). */
        drive = false,
      ): Promise<void> => {
        const started = Date.now();
        for (;;) {
          const shown = await vscode.window.showTextDocument(doc);
          shown.selection = new vscode.Selection(0, 0, 0, 0);
          if (drive) await reg.blameUi.refresh();
          const lb = reg.blameUi.cursorCommit();
          if (want(lb)) return;
          if (Date.now() - started > 30_000) {
            throw new Error(
              `${what}; last read was ${JSON.stringify(lb)} ` +
                `[active=${vscode.window.activeTextEditor?.document.uri.fsPath ?? 'none'} ` +
                `want=${target} enabled=${reg.blameUi.isEnabled(doc)} ` +
                `modelHead=${repo.model.snapshot.headSha?.slice(0, 7)} ` +
                `headRefreshes=${reg.blameUi.headRefreshCount}]`,
            );
          }
          await new Promise((r) => setTimeout(r, 100));
        }
      };

      // Setup: drive the recompute, since which editor was active when the
      // toggle's own refresh ran is this window's business, not the product's.
      await blameSettlesOn(
        (lb) => lb?.isUncommitted === true,
        'precondition: the edited line reads as uncommitted',
        true,
      );

      // Committing leaves the buffer byte-for-byte identical, so `doc.version`
      // never moves — which is exactly what used to pin the stale answer.
      const watchedBefore = reg.blameUi.headRefreshCount;
      git('add', '--', 'src/a.ts');
      git('commit', '-m', 'p4 blame follows history');
      const committed = git('rev-parse', 'HEAD').trim();
      await repo.refresher.refreshNow();
      // No `drive` here: the head watcher has to do this on its own, which is
      // the whole product claim.
      await blameSettlesOn((lb) => lb?.sha === committed, 'the annotation never followed the commit');
      assert.ok(
        reg.blameUi.headRefreshCount > watchedBefore,
        'and it followed because HEAD moved, not because something else repainted',
      );
      assert.strictEqual(doc.version, versionAtBlame, 'the buffer really did not change');

      // An amend replaces the sha with the bytes still identical. The old sha
      // is then reachable from nothing, and the hover offers it behind Copy
      // sha / Show Diff / Show in Log.
      git('commit', '--amend', '-m', 'p4 blame follows history (amended)');
      const amended = git('rev-parse', 'HEAD').trim();
      assert.notStrictEqual(committed, amended);
      await repo.refresher.refreshNow();
      await blameSettlesOn((lb) => lb?.sha === amended, 'the annotation kept the superseded sha');
      assert.strictEqual(
        git('blame', '-L', '1,1', '--porcelain', '--', 'src/a.ts').split('\n')[0]!.split(' ')[0],
        amended,
        'and it agrees with git blame itself',
      );
    } finally {
      const open = vscode.window.activeTextEditor;
      if (open && reg.blameUi.isEnabled(open.document)) await reg.blameUi.toggle(open);
      git('reset', '--hard', base);
      fs.writeFileSync(target, original);
      git('checkout', '--', 'src/a.ts');
      // `closeActiveEditor`, not `closeAllEditors`: this window carries tabs
      // other suites left open, and tearing the whole tab set down races the
      // next test's `showTextDocument` — which is how the neighbouring blame
      // test ended up reading phase02's leftover compare tab instead of its
      // own file. Close only what this test opened.
      await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
      // Settle the model before handing the window on: these are CLI writes,
      // so the next test would otherwise start its blame while HEAD is still
      // moving underneath it.
      await repo.refresher.refreshNow();
    }
  });

  test('blame toggle annotates and cursorCommit resolves the line author', async function () {
    this.timeout(60_000);
    const file = path.join(fsRoot, 'README.md');
    assert.ok(fs.existsSync(file));
    const editor = await vscode.window.showTextDocument(vscode.Uri.file(file));
    editor.selection = new vscode.Selection(0, 0, 0, 0);
    await reg.blameUi.toggle(editor);
    await waitFor(() => reg.blameUi.cursorCommit() !== undefined, 20_000);
    const lb = reg.blameUi.cursorCommit()!;
    assert.match(lb.sha, /^[0-9a-f]{40}$/);
    assert.ok(lb.author.length > 0);
    await reg.blameUi.toggle(editor); // off again
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
  });
});
