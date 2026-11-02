import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { Phase03Registry } from '../../../src/commit/register';
import type { Phase01Registry } from '../../../src/scm/register';
import { makeRevUri } from '../../../src/core/vdocs/revContentProvider';
import type { DiffEntry, DiffSessionRegistry } from '../../../src/diff/diffSession';
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
    // POST-P14u: the repository selector, and the Branches view that follows
    // it. `gittree.branches` is now the repository-scoped hub; the
    // all-repositories tree it replaced moved to `gittree.branchesLegacy`.
    'gittree.repositories',
    'gittree.branches',
    'gittree.branchesLegacy',
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

  test('POST-P14n: the extra sidebar panes are gated on a setting, not a default', () => {
    // POST-P14m used `"visibility": "hidden"`, which is only a FIRST-REGISTRATION
    // default: VS Code persists a container's layout the first time it renders
    // and never consults the default again, so on every existing install the
    // four panes kept showing. A `when` clause is evaluated live and removes
    // the view outright, which is what actually reaches an upgraded user.
    const views = contributes()['views'] as Record<
      string,
      Array<{ id: string; visibility?: string; when?: string }>
    >;
    const byId = new Map(views['gittree']!.map((v) => [v.id, v]));
    for (const id of [
      // POST-P14u: `gittree.branches` left this list by being promoted — it is
      // the sidebar's Branches view now. What it used to draw is
      // `gittree.branchesLegacy`, and that is still gated exactly as before.
      'gittree.branchesLegacy',
      'gittree.worktrees',
      'gittree.localHistory',
      'gittree.stashes',
    ]) {
      const when = byId.get(id)?.when ?? '';
      assert.ok(
        when.includes('config.gittree.sidebar.extraViews'),
        `${id} must be gated on the setting, not on a visibility default; when=${when}`,
      );
      // Turning the setting on has to SHOW the pane. `hidden` would mean it
      // appeared only after a second trip through the Views menu.
      assert.notStrictEqual(byId.get(id)?.visibility, 'hidden', `${id} must not also be hidden`);
    }
    // Local History is still revealed on demand and keeps its second clause,
    // or `gittree.history.show` would silently do nothing with the setting off.
    // (`gittree.branches.active` went with POST-P14u: the view it unlocked is
    // now contributed unconditionally, so there is nothing left to unlock.)
    assert.ok(byId.get('gittree.localHistory')?.when?.includes('gittree.localHistory.active'));
    for (const view of views['gittree']!) {
      assert.ok(
        (view.when ?? '') !== 'gittree.branches.active',
        'a context key nothing arms would leave the view permanently hidden',
      );
    }

    /**
     * Two views open unconditionally, and only two. The commit window IS the
     * sidebar; POST-P14u added the Branches view beside it, because the status
     * bar cannot be the way in — Cursor has no status bar at all, and a user
     * who has just installed GitTree has to find branches somewhere.
     */
    const UNCONDITIONAL = ['gittree.commit', 'gittree.branches'];
    for (const id of UNCONDITIONAL) assert.strictEqual(byId.get(id)?.when, undefined, id);
    for (const view of views['gittree']!) {
      const optional = view.visibility === 'hidden' || view.when !== undefined;
      assert.ok(
        UNCONDITIONAL.includes(view.id) || optional,
        `${view.id} opens unconditionally beneath the commit window`,
      );
    }
  });

  test('POST-P14n: the gate overrides a layout that already has the pane showing', async function () {
    this.timeout(60_000);
    // This is the upgrade case, and the reason the first attempt shipped broken:
    // a profile that has ALREADY persisted the pane as visible. Turn the setting
    // on, reveal the pane for real, then turn it off — a `when` clause has to
    // win over the persisted state, which a visibility default never does.
    const core = await activateGitTree();
    const stashView = (core.debugRegistry.get('phase07') as { stashView: vscode.TreeView<unknown> })
      .stashView;
    const cfg = (): vscode.WorkspaceConfiguration => vscode.workspace.getConfiguration('gittree');
    const setExtra = async (value: boolean | undefined): Promise<void> => {
      await cfg().update('sidebar.extraViews', value, vscode.ConfigurationTarget.Global);
      await waitFor(
        () => cfg().get<boolean>('sidebar.extraViews', false) === (value === true),
        10_000,
      );
    };

    try {
      await setExtra(true);
      await vscode.commands.executeCommand('gittree.stashes.focus');
      await waitFor(() => stashView.visible, 20_000);
      assert.strictEqual(stashView.visible, true, 'the pane must be showing before the gate closes');

      // The layout now records this pane as visible. Close the gate.
      await setExtra(false);
      await waitFor(() => !stashView.visible, 20_000);
      assert.strictEqual(
        stashView.visible,
        false,
        'a persisted-visible pane must still go away when the setting is off',
      );
    } finally {
      await setExtra(undefined);
    }
  });

  test('POST-P14n: Show Local History still opens its view with the setting off', async function () {
    this.timeout(60_000);
    // The gate's one real hazard: you cannot focus a view that is not
    // contributed, so `Show Local History` would have become a no-op. It arms
    // `gittree.localHistory.active` first — IntelliJ's own model, where
    // `Show History` opens the window rather than leaving it standing open.
    const core = await activateGitTree();
    const view = (core.debugRegistry.get('phase09') as { view: vscode.TreeView<unknown> }).view;
    assert.strictEqual(
      vscode.workspace.getConfiguration('gittree').get<boolean>('sidebar.extraViews', false),
      false,
      'this test is about the default, off state',
    );
    try {
      await vscode.commands.executeCommand('gittree.history.show');
      await waitFor(() => view.visible, 20_000);
      assert.strictEqual(view.visible, true, 'Show Local History must reveal the view');
    } finally {
      // The key is session-wide once armed; later suites share this window.
      await vscode.commands.executeCommand('setContext', 'gittree.localHistory.active', false);
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
    let reg: { sessions: Pick<DiffSessionRegistry, 'open'>; lastHint?: string };
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
          'p14n1.txt 1/3:3',
          'p14n1.txt 1/3:14',
          'p14n2.txt 2/3:3',
          'p14n2.txt 2/3:14',
          'p14n3.txt 3/3:3',
          'p14n3.txt 3/3:14',
        ],
        `walk was ${visited.join(' -> ')}`,
      );
      assert.ok(
        visited.filter((v) => v === 'p14n1.txt 1/3:14').length >= 2,
        'the last change of a file must be visited twice: once reached, once arming',
      );

      // At the very end it must say so and stay put, never wrap to the top.
      const end = at()!;
      assert.strictEqual(end.title, 'p14n3.txt 3/3');
      assert.strictEqual(end.line, 14, 'navigation wrapped instead of stopping');
      assert.match(String(reg.lastHint), /last change/u);

      for (const n of names) git('rm', '-q', '-f', n);
      git('commit', '-m', 'p14 nav cleanup');
    });

    /**
     * What VS Code's toolbar button and `Alt+F5` do: run the command by id from
     * the workbench, which is what has to land on GitTree's registration. Calling
     * it from here would stay inside the extension host and prove nothing.
     */
    const pressNative = async (direction: 'next' | 'previous'): Promise<void> => {
      await vscode.commands.executeCommand('runCommands', {
        commands: [`workbench.action.compareEditor.${direction}Change`],
      });
      await new Promise((r) => setTimeout(r, 250));
    };

    /**
     * A commit of a few files with two well-separated changes each, plus `extras`
     * and the paths it touches. Staged by name: this repository is shared with the
     * other suites, whose files are none of this commit's business.
     */
    const commitWalk = (
      names: readonly string[],
      extras: () => void = () => undefined,
      touched: readonly string[] = [],
    ): { head: string; cleanup: () => void; entries: DiffEntry[] } => {
      const body = Array.from({ length: 20 }, (_, i) => `row ${i + 1}`).join('\n') + '\n';
      for (const n of names) fs.writeFileSync(path.join(fsRoot, n), body);
      git('add', ...names);
      git('commit', '-m', 'p14 walk base');
      for (const n of names) {
        fs.writeFileSync(
          path.join(fsRoot, n),
          body.replace('row 4\n', 'row 4 EDITED\n').replace('row 15\n', 'row 15 EDITED\n'),
        );
      }
      extras();
      git('add', '-A', '--', ...names, ...touched);
      git('commit', '-m', 'p14 walk edits');
      const head = git('rev-parse', 'HEAD').trim();
      const entries: DiffEntry[] = names.map((n) => ({
        original: makeRevUri(fsRoot, n, `${head}^`),
        modified: makeRevUri(fsRoot, n, head),
        title: n,
        label: n,
      }));
      return {
        head,
        entries,
        cleanup: () => {
          git('rm', '-q', '-rf', '--ignore-unmatch', '--', ...names, ...touched);
          git('commit', '-m', 'p14 walk cleanup');
        },
      };
    };

    const firstHunkOpen = async (): Promise<void> => {
      await waitFor(() => at() !== undefined && at()!.line === 3, 15_000);
    };

    test("VS Code's own next-change button and key do the walk", async function () {
      this.timeout(120_000);
      const { entries, cleanup } = commitWalk(['p14b1.txt', 'p14b2.txt']);
      await reg.sessions.open(entries, 0);
      await firstHunkOpen();

      await pressNative('next');
      assert.strictEqual(at()?.line, 14, 'the second change of the file');

      await pressNative('next');
      assert.strictEqual(at()?.line, 14, 'the last change must hold, not wrap to the first');
      assert.match(String(reg.lastHint), /Press again to go to the next file/u);

      await pressNative('next');
      await waitFor(() => at()?.title === 'p14b2.txt 2/2', 15_000);
      await waitFor(() => at()?.line === 3, 15_000);
      cleanup();
    });

    test('going back lands on the last change, and says so going past the first', async function () {
      this.timeout(120_000);
      const { entries, cleanup } = commitWalk(['p14p1.txt', 'p14p2.txt']);
      await reg.sessions.open(entries, 1);
      await firstHunkOpen();

      await pressNative('previous');
      assert.strictEqual(at()?.line, 3, 'the first change holds');
      assert.match(String(reg.lastHint), /Press again to go to the previous file/u);

      await pressNative('previous');
      await waitFor(() => at()?.title === 'p14p1.txt 1/2', 15_000);
      await waitFor(() => at()?.line === 14, 15_000);

      await pressNative('previous');
      await waitFor(() => at()?.line === 3, 15_000);
      await pressNative('previous');
      assert.strictEqual(at()?.title, 'p14p1.txt 1/2');
      assert.strictEqual(at()?.line, 3, 'navigation wrapped instead of stopping');
      assert.match(String(reg.lastHint), /first change/u);
      cleanup();
    });

    test('moving the cursor takes back the warning', async function () {
      this.timeout(120_000);
      const { entries, cleanup } = commitWalk(['p14c1.txt', 'p14c2.txt']);
      await reg.sessions.open(entries, 0);
      await firstHunkOpen();
      await pressNative('next');
      await pressNative('next');
      assert.match(String(reg.lastHint), /Press again/u);

      const editor = vscode.window.activeTextEditor!;
      editor.selection = new vscode.Selection(0, 0, 0, 0);
      await new Promise((r) => setTimeout(r, 200));
      await pressNative('next');
      assert.strictEqual(at()?.title, 'p14c1.txt 1/2', 'a press from elsewhere must stay in the file');
      assert.strictEqual(at()?.line, 3);
      cleanup();
    });

    test('walking a commit stays in one tab, unless the tab was kept', async function () {
      this.timeout(120_000);
      const { entries, cleanup } = commitWalk(['p14t1.txt', 'p14t2.txt', 'p14t3.txt']);
      await reg.sessions.open(entries, 0);
      await firstHunkOpen();
      const tabs = (): number => vscode.window.tabGroups.activeTabGroup.tabs.length;

      await vscode.commands.executeCommand('gittree.diff.nextFile');
      await waitFor(() => at()?.title === 'p14t2.txt 2/3', 15_000);
      assert.strictEqual(tabs(), 1, 'a preview tab is replaced');

      await vscode.commands.executeCommand('workbench.action.keepEditor');
      await vscode.commands.executeCommand('gittree.diff.nextFile');
      await waitFor(() => at()?.title === 'p14t3.txt 3/3', 15_000);
      assert.strictEqual(tabs(), 2, 'a tab the user kept stays');
      cleanup();
    });

    test('an added and a deleted file are stops; a rename with no edit is not', async function () {
      this.timeout(120_000);
      const gone = path.join(fsRoot, 'p14goner.txt');
      const moved = path.join(fsRoot, 'p14moved-old.txt');
      fs.writeFileSync(gone, 'going away\n');
      fs.writeFileSync(moved, 'only renamed\n');
      git('add', 'p14goner.txt', 'p14moved-old.txt');
      git('commit', '-m', 'p14 stops base');
      const { head, cleanup } = commitWalk(['p14s1.txt'], () => {
        fs.writeFileSync(path.join(fsRoot, 'p14added.txt'), 'brand new\nsecond line\n');
        fs.rmSync(gone);
        fs.renameSync(moved, path.join(fsRoot, 'p14moved-new.txt'));
      }, ['p14added.txt', 'p14goner.txt', 'p14moved-old.txt', 'p14moved-new.txt']);
      const entry = (o: string, m: string, title: string, identical = false): DiffEntry => ({
        original: makeRevUri(fsRoot, o, `${head}^`),
        modified: makeRevUri(fsRoot, m, head),
        title,
        identical,
      });
      await reg.sessions.open(
        [
          entry('p14s1.txt', 'p14s1.txt', 'edited'),
          entry('p14moved-old.txt', 'p14moved-new.txt', 'renamed', true),
          entry('p14added.txt', 'p14added.txt', 'added'),
          entry('p14goner.txt', 'p14goner.txt', 'deleted'),
        ],
        0,
      );
      await firstHunkOpen();

      await vscode.commands.executeCommand('gittree.diff.nextChange');
      await new Promise((r) => setTimeout(r, 250));
      assert.strictEqual(at()?.line, 14);
      await vscode.commands.executeCommand('gittree.diff.nextChange');
      await new Promise((r) => setTimeout(r, 250));
      await vscode.commands.executeCommand('gittree.diff.nextChange');
      await waitFor(() => at()?.title === 'added 3/4', 15_000);

      await vscode.commands.executeCommand('gittree.diff.nextChange');
      await new Promise((r) => setTimeout(r, 250));
      await vscode.commands.executeCommand('gittree.diff.nextChange');
      await waitFor(() => at()?.title === 'deleted 4/4', 15_000);

      // The file arrows stop on it all the same: it is in the list.
      await vscode.commands.executeCommand('gittree.diff.prevFile');
      await waitFor(() => at()?.title === 'added 3/4', 15_000);
      await vscode.commands.executeCommand('gittree.diff.prevFile');
      await waitFor(() => at()?.title === 'renamed 2/4', 15_000);
      cleanup();
    });

    test('a binary file opens as a diff that says what it is, in any tab', async function () {
      this.timeout(120_000);
      const name = 'p14image.png';
      const { head, cleanup } = commitWalk(['p14i1.txt'], () => {
        fs.writeFileSync(path.join(fsRoot, name), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 13, 1, 2, 3]));
      }, [name]);
      const entries: DiffEntry[] = [
        {
          original: makeRevUri(fsRoot, name, `${head}^`),
          modified: makeRevUri(fsRoot, name, head),
          title: 'image',
        },
      ];
      await reg.sessions.open(entries, 0);
      // By name VS Code would hand this to its image viewer, which cannot read
      // `gittree-rev:` and shows an error page with no toolbar.
      await waitFor(() => vscode.window.activeTextEditor !== undefined, 15_000);
      const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
      assert.ok(tab?.input instanceof vscode.TabInputTextDiff);
      assert.match(vscode.window.activeTextEditor!.document.getText(), /^Binary file, 11 bytes \(/u);
      cleanup();
    });

    test('a diff GitTree did not open still wraps, untouched', async function () {
      this.timeout(120_000);
      const { head, cleanup } = commitWalk(['p14u1.txt']);
      await vscode.commands.executeCommand(
        'vscode.diff',
        makeRevUri(fsRoot, 'p14u1.txt', `${head}^`),
        makeRevUri(fsRoot, 'p14u1.txt', head),
        'plain',
      );
      await firstHunkOpen();
      reg.lastHint = undefined;
      await pressNative('next');
      assert.strictEqual(at()?.line, 14);
      await pressNative('next');
      assert.strictEqual(at()?.line, 3, "VS Code's own behaviour on everyone else's diffs");
      assert.strictEqual(reg.lastHint, undefined);
      cleanup();
    });

    test('the setting hands the arrows back', async function () {
      this.timeout(120_000);
      const cfg = vscode.workspace.getConfiguration('gittree.diff');
      const { entries, cleanup } = commitWalk(['p14o1.txt', 'p14o2.txt']);
      await cfg.update('goToNextFileAfterLastChange', false, vscode.ConfigurationTarget.Global);
      try {
        await reg.sessions.open(entries, 0);
        await firstHunkOpen();
        reg.lastHint = undefined;
        await pressNative('next');
        await pressNative('next');
        assert.strictEqual(at()?.title, 'p14o1.txt 1/2', 'stays in the file');
        assert.strictEqual(at()?.line, 3, 'and wraps');
        assert.strictEqual(reg.lastHint, undefined);
      } finally {
        await cfg.update('goToNextFileAfterLastChange', undefined, vscode.ConfigurationTarget.Global);
      }
      cleanup();
    });

    test('the diff toolbar controls are scoped to GitTree diffs', () => {
      const menus = contributes()['menus'] as Record<string, Array<{ command?: string; when?: string }>>;
      const ours = (menus['editor/title'] ?? []).filter((e) =>
        String(e.command ?? '').startsWith('gittree.diff.'),
      );
      assert.strictEqual(ours.length, 5, 'expected 2 file arrows + 3 view toggles');
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
      // Same reasoning, and the stakes are the opposite way round: a leaked
      // `true` would make the "off by default" assertion fail on a product
      // that is behaving correctly.
      await setHoverActions(undefined);
    });

    /**
     * POST-P14aa: write `changeBars.hoverActions` globally and wait until the
     * value is readable. `undefined` restores the default.
     */
    async function setHoverActions(value: boolean | undefined): Promise<void> {
      await vscode.workspace
        .getConfiguration('gittree')
        .update('changeBars.hoverActions', value, vscode.ConfigurationTarget.Global);
      await waitFor(
        () =>
          vscode.workspace.getConfiguration('gittree').get<boolean>('changeBars.hoverActions') ===
          (value ?? false),
        10_000,
      );
    }

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
      await setHoverActions(undefined);
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

    test('POST-P14aa: the hover is opt-in — silent by default, live when turned on', async function () {
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
      /**
       * The provider is registered and disposed by a configuration listener,
       * which runs some time after the new value is readable. So poll the
       * observable contract — what a hover actually returns — rather than the
       * setting, which would race the listener and pass or fail by luck.
       */
      const settles = async (line: number, want: boolean): Promise<void> => {
        const deadline = Date.now() + 10_000;
        while ((await ours(line)) !== want) {
          if (Date.now() > deadline) {
            throw new Error(`GitTree hover on line ${line} never became ${String(want)}`);
          }
          await new Promise((r) => setTimeout(r, 100));
        }
      };

      try {
        // Same bars, same line that answered before this change. Only the
        // setting stands between it and a popup, so silence here is the
        // setting's doing and not a missing change.
        assert.strictEqual(await ours(3), false, 'the hover must be off by default');

        await setHoverActions(true);
        await settles(3, true);
        assert.strictEqual(await ours(8), false, 'GitTree hovered a line with no change');

        // Turning it back off takes effect without a reload.
        await setHoverActions(false);
        await settles(3, false);
      } finally {
        await setHoverActions(undefined);
        git('checkout', '--', 'p14hover.txt');
        git('rm', '-q', '-f', 'p14hover.txt');
        git('commit', '-m', 'p14 hover cleanup');
      }
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
