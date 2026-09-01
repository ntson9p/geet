import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { Phase03Registry } from '../../../src/commit/register';
import type { Phase01Registry } from '../../../src/scm/register';
import { makeRevUri } from '../../../src/core/vdocs/revContentProvider';
import type { DiffEntry } from '../../../src/diff/diffSession';
import { activateGitTree, gitWithRetry, waitFor, workspaceRepoC } from '../setup';

/**
 * Phase 14 — owning the SCM surface. This suite guards the *structural*
 * commitments the phase makes: which container the views live in, that no
 * `scm/*` contribution survives, and that nothing reads or writes another
 * extension's configuration. Those are package.json-level facts, so they are
 * asserted against the live extension manifest rather than by driving UI.
 */
suite('P14 owning the SCM surface', () => {
  function contributes(): Record<string, unknown> {
    const ext = vscode.extensions.getExtension('gittree.gittree');
    assert.ok(ext, 'extension missing');
    const c = (ext.packageJSON as { contributes?: Record<string, unknown> }).contributes;
    assert.ok(c, 'no contributes block');
    return c;
  }

  /**
   * Views GitTree contributes to its own container, in manifest order.
   * T2 removed `gittree.changelists` and `gittree.shelf`: the commit window's
   * change tree and Shelf tab supersede them.
   */
  const EXPECTED_VIEWS = [
    'gittree.commit',
    'gittree.branches',
    'gittree.worktrees',
    'gittree.compare',
    'gittree.localHistory',
    'gittree.conflicts',
    'gittree.stashes',
    'gittree.revTree',
  ];

  test('T1: an activitybar container "gittree" is contributed', () => {
    const containers = contributes()['viewsContainers'] as
      | { activitybar?: Array<{ id: string; title: string; icon: string }> }
      | undefined;
    const bar = containers?.activitybar ?? [];
    const ours = bar.find((c) => c.id === 'gittree');
    assert.ok(ours, `no "gittree" activitybar container, got ${bar.map((c) => c.id).join(', ')}`);
    assert.ok(ours.icon.endsWith('.svg'), `activitybar icons must be an SVG path, got ${ours.icon}`);
  });

  test('T1: every view lives in the GitTree container, none in VS Code\'s scm container', () => {
    const views = contributes()['views'] as Record<string, Array<{ id: string }>>;
    assert.ok(views['gittree'], 'no views contributed to the gittree container');
    assert.strictEqual(
      views['scm'],
      undefined,
      'GitTree still contributes views to VS Code\'s Source Control container',
    );
    assert.deepStrictEqual(
      views['gittree'].map((v) => v.id),
      EXPECTED_VIEWS,
      'GitTree container view set or order changed',
    );
    // The Git tool window stays in the panel — that is the §2A shape.
    assert.deepStrictEqual((views['gittree-panel'] ?? []).map((v) => v.id), ['gittree.log']);
  });

  test('POST-P14m: only the commit window is visible by default in the container', () => {
    // IntelliJ's Commit tool window is the Commit tab and nothing beneath it.
    // Branches, Worktrees, Local History and Stashes all moved to the surface
    // JetBrains keeps them on, so they must not open as sidebar sections; they
    // stay registered so a user can re-add any of them from ⋯ → Views.
    const views = contributes()['views'] as Record<
      string,
      Array<{ id: string; visibility?: string; when?: string }>
    >;
    const byId = new Map(views['gittree']!.map((v) => [v.id, v]));
    for (const id of [
      'gittree.branches',
      'gittree.worktrees',
      'gittree.localHistory',
      'gittree.stashes',
    ]) {
      assert.strictEqual(
        byId.get(id)?.visibility,
        'hidden',
        `${id} must not open as a sidebar section — IntelliJ has no such pane`,
      );
    }
    // The commit window itself is the one thing that IS the sidebar.
    assert.strictEqual(byId.get('gittree.commit')?.visibility, undefined);
    // Everything else in the container is already gated on a `when` clause, so
    // nothing among them opens unasked either.
    for (const view of views['gittree']!) {
      const optional = view.visibility === 'hidden' || view.when !== undefined;
      assert.ok(
        view.id === 'gittree.commit' || optional,
        `${view.id} opens unconditionally beneath the commit window`,
      );
    }
  });

  test('T1: the commit view still resolves from the new container', async function () {
    this.timeout(30_000);
    // A container move is only real if the view still resolves from it; the
    // manifest assertions above cannot see that.
    await vscode.commands.executeCommand('workbench.view.extension.gittree');
    await vscode.commands.executeCommand('gittree.commit.focus');
  });

  test('T2: the native commit surface is gone from the manifest', () => {
    const c = contributes();
    const menus = c['menus'] as Record<string, unknown[]>;
    // The three menus T2 owns. `scm/change/title` was the quick-diff peek
    // toolbar and outlived T2 deliberately, because the provider it belonged to
    // did; T4 removed both, and asserts the total is zero.
    for (const key of ['scm/title', 'scm/resourceState/context', 'scm/resourceGroup/context']) {
      assert.strictEqual(menus[key], undefined, `${key} should be gone`);
    }

    const settings = (c['configuration'] as Array<{ properties?: Record<string, unknown> }>).flatMap(
      (b) => Object.keys(b.properties ?? {}),
    );
    assert.ok(!settings.includes('gittree.commit.window'), 'gittree.commit.window must be gone');
    assert.ok(
      settings.includes('gittree.commit.paradigm'),
      'the paradigm setting is unrelated and must survive',
    );

    // Nothing may still be gated on the retired context key.
    for (const [name, arr] of Object.entries(menus)) {
      for (const e of arr as Array<{ when?: string }>) {
        assert.ok(
          !String(e.when ?? '').includes('gittree.commitWindow'),
          `${name} still references the retired commitWindow context key`,
        );
      }
    }
  });

  test('T2: changelist commands accept the commit window context shape', async function () {
    this.timeout(60_000);
    const core = await activateGitTree();
    const reg = core.debugRegistry.get('phase03') as Phase03Registry;
    assert.ok(reg, 'phase03 registry missing');
    const repo = core.repoForPath(workspaceRepoC());
    assert.ok(repo, 'repoC not discovered');

    // The shared window runs the staging paradigm from phase03 onward.
    const wasChangelists = reg.paradigm.paradigm === 'changelists';
    if (!wasChangelists) await reg.paradigm.switch();
    try {
      const service = reg.changelistsFor(repo);
      const list = service.create('P14 context list', undefined, false);
      assert.notStrictEqual(
        service.getLists().find((l) => l.isActive)?.id,
        list.id,
        'fixture list should not start active',
      );

      // This is the whole point of T2: the changelists tree view is gone, so
      // the only caller left passes {repoRoot, listId} from the webview.
      await vscode.commands.executeCommand('gittree.changelist.setActive', {
        repoRoot: repo.root,
        listId: list.id,
      });
      assert.strictEqual(
        service.getLists().find((l) => l.isActive)?.id,
        list.id,
        'setActive did not accept the webview context shape',
      );

      // An unresolvable repo must be a no-op, never a throw — a context object
      // can outlive the repo it named.
      await vscode.commands.executeCommand('gittree.changelist.setActive', {
        repoRoot: 'D:/no/such/repo',
        listId: list.id,
      });
      assert.strictEqual(service.getLists().find((l) => l.isActive)?.id, list.id);

      service.setActive(service.getLists().find((l) => l.isDefault)!.id);
      service.remove(list.id);
    } finally {
      if (!wasChangelists) await reg.paradigm.switch();
    }
  });

  test('T4: no SCM contribution and no SourceControl survives', async function () {
    this.timeout(30_000);
    const menus = contributes()['menus'] as Record<string, unknown[]>;
    assert.deepStrictEqual(
      Object.keys(menus).filter((k) => k.startsWith('scm')),
      [],
      'GitTree still contributes to VS Code SCM menus',
    );

    // The registry is the runtime half of the same claim: nothing hands out a
    // SourceControl any more, so nothing can be holding one.
    const core = await activateGitTree();
    const p1 = core.debugRegistry.get('phase01') as Record<string, unknown>;
    assert.ok(p1, 'phase01 registry missing');
    assert.strictEqual(p1['sourceControls'], undefined, 'phase01 still exposes SourceControls');
    assert.ok(p1['statusBars'], 'the status bar controllers should still be registered');
    assert.ok(p1['changeBars'], 'the change bars controller should still be registered');
  });

  test('T4: the commit view badge carries the pending-change count', async function () {
    this.timeout(90_000);
    const core = await activateGitTree();
    const reg = core.debugRegistry.get('phase03') as Phase03Registry;
    const repo = core.repoForPath(workspaceRepoC())!;
    const root = repo.root;

    await vscode.commands.executeCommand('workbench.view.extension.gittree');
    await vscode.commands.executeCommand('gittree.commit.focus');
    await waitFor(() => reg.commitWindow.isResolved, 15_000);

    // `SourceControl.count` used to carry this; the view badge replaces it.
    fs.writeFileSync(path.join(root, 'p14badge.txt'), 'badge me\n');
    await repo.refresher.refreshNow();
    await waitFor(() => {
      reg.commitWindow.push();
      return (reg.commitWindow.badgeValue ?? 0) > 0;
    }, 20_000);

    fs.rmSync(path.join(root, 'p14badge.txt'));
    await repo.refresher.refreshNow();
  });

  test('T5: GitTree owns its status colours and the last unstable API is gone', () => {
    const c = contributes();
    const colors = (c['colors'] ?? []) as Array<{
      id: string;
      defaults?: Record<string, string>;
    }>;
    const ids = colors.map((x) => x.id).sort();
    const statusIds = [
      'gittree.color.added',
      'gittree.color.conflicted',
      'gittree.color.deleted',
      'gittree.color.ignored',
      'gittree.color.modified',
      'gittree.color.renamed',
      'gittree.color.untracked',
    ];
    assert.deepStrictEqual(
      ids.filter((id) => id.startsWith('gittree.color.')),
      statusIds,
      'GitTree must contribute its own status colours',
    );
    // The palette as a whole stays a closed set: a new contributed colour is
    // public surface and has to be added here deliberately.
    assert.deepStrictEqual(
      ids,
      [
        'gittree.blame.age1Background',
        'gittree.blame.age2Background',
        'gittree.blame.age3Background',
        'gittree.blame.age4Background',
        'gittree.blame.age5Background',
        'gittree.blame.foreground',
        'gittree.blame.uncommittedBackground',
        ...statusIds,
      ],
      'every contributed colour is accounted for',
    );
    // Every variant needs a default or the colour goes blank in that theme —
    // which is the exact failure mode `gitDecoration.*` had when the built-in
    // git extension was disabled.
    for (const color of colors) {
      for (const variant of ['light', 'dark', 'highContrast', 'highContrastLight']) {
        assert.ok(
          typeof color.defaults?.[variant] === 'string',
          `${color.id} has no ${variant} default`,
        );
      }
    }

    const settings = (c['configuration'] as Array<{ properties?: Record<string, unknown> }>).flatMap(
      (b) => Object.keys(b.properties ?? {}),
    );
    // The setting only chose between the tri-editor and the `_open.mergeEditor`
    // internal-command bridge; the bridge is deleted, so the choice is gone.
    assert.ok(!settings.includes('gittree.merge.ui'), 'gittree.merge.ui should be gone');
  });

  test('T6: the coexistence machinery is gone and git.enabled is untouched', async function () {
    this.timeout(30_000);
    const c = contributes();
    const settings = (c['configuration'] as Array<{ properties?: Record<string, unknown> }>).flatMap(
      (b) => Object.keys(b.properties ?? {}),
    );
    assert.ok(!settings.includes('gittree.mode'), 'gittree.mode should be gone');
    assert.ok(
      settings.includes('gittree.decorations.fileExplorer'),
      'the one thing the mode still gated needs a plain setting',
    );

    // No walkthrough step may still ask the user to choose a mode.
    const walkthroughs = (c['walkthroughs'] ?? []) as Array<{ steps?: Array<{ id?: string }> }>;
    for (const w of walkthroughs) {
      for (const step of w.steps ?? []) {
        assert.ok(!String(step.id ?? '').includes('pickMode'), 'a pickMode step survived');
      }
    }

    // The guarantee the whole task exists for: activation writes nothing.
    const inspected = vscode.workspace.getConfiguration('git').inspect<boolean>('enabled');
    assert.strictEqual(inspected?.workspaceValue, undefined, 'git.enabled must not be written');
    assert.strictEqual(inspected?.globalValue, undefined, 'git.enabled must not be written globally');

    // And the core no longer carries a mode at all.
    const core = await activateGitTree();
    assert.strictEqual(
      (core as unknown as Record<string, unknown>)['mode'],
      undefined,
      'Core still exposes a mode manager',
    );
  });

  // ---- T7: cross-file change navigation ------------------------------------

  suite('T7 diff navigation', () => {
    let repoRoot: string;
    let fsRoot: string;
    let reg: { sessions: { open(e: readonly DiffEntry[], i: number): Promise<void> }; lastHint?: string };
    const git = (...args: string[]): string => gitWithRetry(repoRoot, args);

    /** Where the cursor is, and which file the open diff is showing. */
    const at = (): { title: string; line: number } | undefined => {
      const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
      const editor = vscode.window.activeTextEditor;
      if (!tab || !editor) return undefined;
      return { title: tab.label, line: editor.selection.active.line };
    };

    suiteSetup(async function () {
      this.timeout(90_000);
      const core = await activateGitTree();
      repoRoot = workspaceRepoC();
      fsRoot = core.repoForPath(repoRoot)!.root;
      reg = core.debugRegistry.get('phase14') as typeof reg;
      assert.ok(reg, 'phase14 diff registry missing');
    });

    teardown(async () => {
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    });

    test('walks every change of every file, arms at each boundary, and never wraps', async function () {
      this.timeout(120_000);
      // Three files, two well-separated changes each.
      const body = Array.from({ length: 20 }, (_, i) => `row ${i + 1}`).join('\n') + '\n';
      const names = ['p14n1.txt', 'p14n2.txt', 'p14n3.txt'];
      for (const n of names) fs.writeFileSync(path.join(fsRoot, n), body);
      git('add', ...names);
      git('commit', '-m', 'p14 nav base');
      for (const n of names) {
        fs.writeFileSync(
          path.join(fsRoot, n),
          body.replace('row 4', 'row 4 EDITED').replace('row 15', 'row 15 EDITED'),
        );
      }
      git('add', ...names);
      git('commit', '-m', 'p14 nav edits');
      const head = git('rev-parse', 'HEAD').trim();

      const entries: DiffEntry[] = names.map((n) => ({
        original: makeRevUri(fsRoot, n, `${head}^`),
        modified: makeRevUri(fsRoot, n, head),
        title: n,
      }));
      await reg.sessions.open(entries, 0);
      await waitFor(() => at() !== undefined, 15_000);

      // VS Code parks the cursor on the first difference when a diff opens, so
      // starting the walk from wherever it lands would skip a change. Reset to
      // the top and let the first press find change one.
      const start = vscode.window.activeTextEditor!;
      start.selection = new vscode.Selection(0, 0, 0, 0);
      await vscode.commands.executeCommand('gittree.diff.nextChange');
      await waitFor(() => (at()?.line ?? -1) === 3, 10_000);

      const visited: string[] = [];
      for (let step = 0; step < 12; step++) {
        const before = at()!;
        visited.push(`${before.title}:${before.line}`);
        await vscode.commands.executeCommand('gittree.diff.nextChange');
        // Give a crossing time to open the next diff.
        await new Promise((r) => setTimeout(r, 250));
      }

      // Each file contributes rows 3 and 14; a boundary shows as the SAME
      // position repeated, because the first press arms instead of jumping.
      // That repetition is the feature, not a stutter.
      const unique = visited.filter((v, i) => i === 0 || v !== visited[i - 1]);
      assert.deepStrictEqual(
        unique,
        [
          'p14n1.txt:3',
          'p14n1.txt:14',
          'p14n2.txt:3',
          'p14n2.txt:14',
          'p14n3.txt:3',
          'p14n3.txt:14',
        ],
        `walk was ${visited.join(' -> ')}`,
      );
      assert.ok(
        visited.filter((v) => v === 'p14n1.txt:14').length >= 2,
        'the last change of a file must be visited twice: once reached, once arming',
      );

      // At the very end it must say so and stay put, never wrap to the top.
      const end = at()!;
      assert.strictEqual(end.title, 'p14n3.txt');
      assert.strictEqual(end.line, 14, 'navigation wrapped instead of stopping');
      assert.match(String(reg.lastHint), /Last change/u);

      for (const n of names) git('rm', '-q', '-f', n);
      git('commit', '-m', 'p14 nav cleanup');
    });

    test('the diff toolbar controls are scoped to GitTree diffs', () => {
      const menus = contributes()['menus'] as Record<string, Array<{ command?: string; when?: string }>>;
      const ours = [...(menus['editor/title/navigation'] ?? []), ...(menus['editor/title'] ?? [])].filter(
        (e) => String(e.command ?? '').startsWith('gittree.diff.'),
      );
      assert.strictEqual(ours.length, 5, 'expected 2 arrows + 3 view toggles');
      for (const e of ours) {
        // Unscoped, these would appear on every diff in the window, including
        // ones GitTree knows nothing about.
        assert.match(String(e.when), /isInDiffEditor/u);
        assert.match(String(e.when), /gittree\.diff\.active/u);
      }
    });
  });

  // ---- T3: GitTree's own change bars ---------------------------------------

  suite('T3 change bars', () => {
    let repoRoot: string;
    let fsRoot: string;
    let repo: ReturnType<Awaited<ReturnType<typeof activateGitTree>>['repoForPath']>;
    let bars: Phase01Registry['changeBars'];
    const git = (...args: string[]): string => gitWithRetry(repoRoot, args);
    const abs = (rel: string): string => path.join(fsRoot, rel);

    /**
     * Open the file and force one recompute. `expect` is the content just
     * written: a `TextDocument` already open does NOT pick up a disk write
     * synchronously, so without waiting for it the bars would be computed
     * against the previous text. The model refresh is for the same reason on
     * the other side — after a CLI `git add`, a stale snapshot still calls the
     * file untracked, and untracked files deliberately get no bars.
     */
    async function paint(
      rel: string,
      expect: string,
      opts: { tracked?: boolean; settle?: 'changes' | 'empty' } = {},
    ): Promise<ReturnType<typeof bars.changesFor>> {
      const uri = vscode.Uri.file(abs(rel));
      await repo!.refresher.refreshNow();
      if (opts.tracked === true) {
        // One refresh is not enough under full-suite load: the watcher can
        // still be reporting the pre-`git add` snapshot, and a file the model
        // calls untracked deliberately gets no bars — which looks exactly like
        // "the bars are broken".
        await waitFor(() => {
          const e = repo!.model.snapshot.statusEntries.find((x) => x.path === rel);
          return e === undefined || (e.kind !== 'untracked' && e.kind !== 'ignored');
        }, 20_000);
      }
      const doc = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(doc, { preview: false });
      // The controller deliberately does nothing for a document with no visible
      // editor — correct in production, but `showTextDocument` resolving does
      // not mean `visibleTextEditors` has caught up, and the early return would
      // leave nothing computed and look like "no changes".
      await waitFor(
        () => vscode.window.visibleTextEditors.some((e) => e.document === doc),
        10_000,
      );
      await waitFor(() => doc.getText() === expect, 15_000);
      await bars.refreshNow(doc);

      // A status refresh can land mid-recompute and momentarily clear the bars
      // — the model snapshot an apply reads may be older than the git state it
      // describes. That is fine in the product (the next apply repaints), but a
      // test that reads once can catch the gap. Wait for the state to settle,
      // then let the caller assert what it actually is: converging on "some
      // changes" is not the same as asserting *which*.
      //
      // Each attempt is AWAITED. Firing `refreshNow` from inside a 25 ms poll
      // without awaiting queues a git read per tick, which under full-suite
      // load thrashes the repo queue badly enough that it never converges.
      if (opts.settle !== undefined) {
        const want = opts.settle;
        const deadline = Date.now() + 20_000;
        for (;;) {
          await bars.refreshNow(doc);
          const d = bars.changesFor(uri);
          const ok =
            want === 'changes'
              ? d !== undefined && d.changes.length > 0
              : d === undefined || d.changes.length === 0;
          if (ok) break;
          if (Date.now() > deadline) {
            throw new Error(`change bars for ${rel} never settled to "${want}"`);
          }
          await new Promise((r) => setTimeout(r, 200));
        }
      }
      return bars.changesFor(uri);
    }
    const rows = (d: ReturnType<typeof bars.changesFor>): string[] =>
      (d?.changes ?? []).map((c) => `${c.kind} ${c.startLine}-${c.endLine}`);

    suiteSetup(async function () {
      this.timeout(60_000);
      const core = await activateGitTree();
      repoRoot = workspaceRepoC();
      repo = core.repoForPath(repoRoot);
      fsRoot = repo!.root;
      bars = (core.debugRegistry.get('phase01') as Phase01Registry).changeBars;
      assert.ok(bars, 'change bars controller missing from the phase01 registry');
      // The test VS Code keeps ONE user-data-dir across runs, so a global
      // setting written by a previous run survives into this one. The cutoff
      // test writes exactly such a setting; if its restore lost the race with
      // shutdown, every later run would silently paint no bars at all. Reset to
      // the default here rather than trusting the previous run's teardown.
      await resetCutoff();
    });

    /** Put `changeBars.maxFileLines` back to its default and wait for it. */
    async function resetCutoff(): Promise<void> {
      await vscode.workspace
        .getConfiguration('gittree')
        .update('changeBars.maxFileLines', undefined, vscode.ConfigurationTarget.Global);
      await waitFor(
        () =>
          vscode.workspace.getConfiguration('gittree').get<number>('changeBars.maxFileLines') ===
          20000,
        10_000,
      );
    }

    suiteTeardown(async () => {
      await resetCutoff();
    });

    teardown(async () => {
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    });

    test('paints bars on exactly the changed lines, and clears them on revert', async function () {
      this.timeout(90_000);
      const body = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';
      fs.writeFileSync(abs('p14bars.txt'), body);
      git('add', 'p14bars.txt');
      git('commit', '-m', 'p14 bars base');

      // One modification, one insertion, one deletion, well separated so the
      // diff cannot legitimately merge them.
      const lines = body.split('\n');
      lines[1] = 'line 2 CHANGED';
      lines.splice(5, 0, 'INSERTED');
      lines.splice(9, 1);
      fs.writeFileSync(abs('p14bars.txt'), lines.join('\n'));

      const painted = await paint('p14bars.txt', lines.join('\n'), {
        tracked: true,
        settle: 'changes',
      });
      assert.deepStrictEqual(rows(painted), ['modified 1-1', 'added 5-5', 'deleted 9-9']);

      // Reverting the file must take the bars with it — a stale bar is worse
      // than no bar, because Rollback acts on what the bar claims.
      fs.writeFileSync(abs('p14bars.txt'), body);
      const cleared = await paint('p14bars.txt', body, { tracked: true, settle: 'empty' });
      assert.deepStrictEqual(rows(cleared), []);

      git('rm', '-q', '-f', 'p14bars.txt');
      git('commit', '-m', 'p14 bars cleanup');
    });

    test('an untracked file gets no bars — it has no base to compare against', async function () {
      this.timeout(60_000);
      fs.writeFileSync(abs('p14untracked.txt'), 'brand new\n');
      await vscode.commands.executeCommand('gittree.refresh');
      const painted = await paint('p14untracked.txt', 'brand new\n', { settle: 'empty' });
      assert.strictEqual(painted, undefined, 'untracked files must not report changes');
      fs.rmSync(abs('p14untracked.txt'));
    });

    test('the hover fires on a changed line and stays silent on an unchanged one', async function () {
      this.timeout(90_000);
      const body = Array.from({ length: 10 }, (_, i) => `row ${i + 1}`).join('\n') + '\n';
      fs.writeFileSync(abs('p14hover.txt'), body);
      git('add', 'p14hover.txt');
      git('commit', '-m', 'p14 hover base');
      fs.writeFileSync(abs('p14hover.txt'), body.replace('row 4', 'row 4 EDITED'));

      const modified = body.replace('row 4', 'row 4 EDITED');
      const painted = await paint('p14hover.txt', modified, { tracked: true, settle: 'changes' });
      assert.deepStrictEqual(rows(painted), ['modified 3-3']);

      const uri = vscode.Uri.file(abs('p14hover.txt'));
      const ours = async (line: number): Promise<boolean> => {
        const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
          'vscode.executeHoverProvider',
          uri,
          new vscode.Position(line, 0),
        );
        // Other providers answer here too; ours is the one carrying the
        // change-action command links.
        return (hovers ?? []).some((h) =>
          h.contents.some((c) =>
            typeof c === 'string' ? false : c.value.includes('command:gittree.change.'),
          ),
        );
      };
      assert.strictEqual(await ours(3), true, 'no GitTree hover on the changed line');
      assert.strictEqual(await ours(8), false, 'GitTree hovered a line with no change');

      git('checkout', '--', 'p14hover.txt');
      git('rm', '-q', '-f', 'p14hover.txt');
      git('commit', '-m', 'p14 hover cleanup');
    });

    test('a file over the line cutoff paints nothing rather than stalling', async function () {
      this.timeout(90_000);
      const cfg = vscode.workspace.getConfiguration('gittree');
      const body = Array.from({ length: 40 }, (_, i) => `big ${i + 1}`).join('\n') + '\n';
      fs.writeFileSync(abs('p14big.txt'), body);
      git('add', 'p14big.txt');
      git('commit', '-m', 'p14 big base');
      fs.writeFileSync(abs('p14big.txt'), body.replace('big 5', 'big 5 EDITED'));

      const bigMod = body.replace('big 5', 'big 5 EDITED');
      const bigRows = { tracked: true, settle: 'changes' } as const;
      assert.deepStrictEqual(rows(await paint('p14big.txt', bigMod, bigRows)), ['modified 4-4']);
      await cfg.update('changeBars.maxFileLines', 100, vscode.ConfigurationTarget.Global);
      await waitFor(
        () =>
          vscode.workspace.getConfiguration('gittree').get<number>('changeBars.maxFileLines') === 100,
        10_000,
      );
      try {
        // 41 lines is under 100, so it still paints; the cutoff only bites above.
        assert.deepStrictEqual(rows(await paint('p14big.txt', bigMod, bigRows)), ['modified 4-4']);
        await cfg.update('changeBars.maxFileLines', 100000, vscode.ConfigurationTarget.Global);
        await cfg.update('changeBars.maxFileLines', 10, vscode.ConfigurationTarget.Global);
        await waitFor(
          () =>
            vscode.workspace.getConfiguration('gittree').get<number>('changeBars.maxFileLines') === 10,
          10_000,
        );
        assert.strictEqual(
          await paint('p14big.txt', bigMod, { tracked: true, settle: 'empty' }),
          undefined,
          'cutoff must suppress the bars',
        );
      } finally {
        // Wait for the restore to be observed, not just requested — an
        // un-awaited reset is how this setting leaks into the next run.
        await resetCutoff();
      }

      git('checkout', '--', 'p14big.txt');
      git('rm', '-q', '-f', 'p14big.txt');
      git('commit', '-m', 'p14 big cleanup');
    });
  });
});
