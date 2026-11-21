import * as assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { Core } from '../../../src/core/core';
import { canonicalKey } from '../../../src/core/repoDiscovery';
import { activateGeet, waitFor, workspaceRepoA } from '../setup';

/**
 * The status-bar widget against a changing repository set.
 *
 * Reported symptom: "sometimes, after taking some actions on the Branch popup,
 * the Geet branch button disappears". Root cause: a bar's visibility is
 * `activeRepoKey() === key`, and `activeRepoKey` reads the live handle set —
 * `repoForUri` resolves against it, and the fallback is `core.repos[0]` — but
 * only `onDidChangeActiveTextEditor` ever re-evaluated it. When the repository
 * whose widget was showing left the workspace, its own items were disposed and
 * every surviving bar kept the `visible = false` it had last computed. Nothing
 * recomputed them, so the status bar went empty and stayed empty. Branch-popup
 * actions write into `.git`, the workspace watcher turns that into a
 * rediscovery, and a rediscovery is what can drop a handle — hence "sometimes".
 *
 * The sixth repository lives *inside* repoA rather than as a sixth workspace
 * folder: discovery.test.ts records why (adding a workspace folder perturbs
 * every other suite in this shared window). repoA is the safe host — its own
 * suite, phase01, runs earlier, and nothing after this file asserts on it.
 */
suite('status bar visibility follows the repository set', () => {
  /** The `phase01` registry, structurally — never `instanceof` across the bundle. */
  interface BarShape {
    update(): void;
    setFetching(fetching: boolean): void;
    titles: string[];
    tooltips: string[];
    visible: boolean;
  }
  interface DiagnosticsShape {
    rendered: string[];
    itemIds: string[];
  }
  interface Phase01Shape {
    statusBars: Map<string, BarShape>;
    statusBarDiagnostics(): DiagnosticsShape;
  }

  /** Untracked inside repoA while it exists, so `.git/info/exclude` hides it. */
  const NESTED = 'geet-statusbar-tmp';

  let core: Core;
  let phase01: Phase01Shape;
  let bars: Map<string, BarShape>;
  let repoARoot: string;
  let repoAKey: string;
  let nestedDir: string;
  let nestedFile: string;
  let nestedKey: string;
  let excludeFile: string;
  let excludeBefore: string | undefined;
  let marker = 0;

  const visibleKeys = (): string[] =>
    [...bars.entries()].filter(([, bar]) => bar.visible).map(([key]) => key).sort();

  /** What the single host actually holds and last drew. */
  const diagnostics = (): DiagnosticsShape => phase01.statusBarDiagnostics();

  /**
   * Forces a rediscovery and waits for its effect.
   *
   * The `.git` watcher already pokes one — that is the product path this test
   * is about — but its event is debounced 500 ms and its delivery is
   * platform-dependent, which is not what is under test here. The
   * configuration listener is a deterministic second trigger, and rescans are
   * serialized, so asking twice costs one extra scan and can never interleave.
   * The value changes every call so `affectsConfiguration` always fires, and
   * it names a folder that does not exist so discovery still finds exactly
   * what it would have found anyway.
   */
  async function rescanUntil(
    cond: () => boolean,
    what: string,
    extraIgnores: readonly string[] = [],
  ): Promise<void> {
    marker += 1;
    await vscode.workspace.getConfiguration('geet').update(
      'repositoryScan.ignoredFolders',
      // The marker changes every call so `affectsConfiguration` always fires
      // and never coalesces two requests into one; it names a folder that
      // cannot exist, so it changes nothing about what discovery finds.
      ['node_modules', ...extraIgnores, `geet-no-such-folder-${marker}`],
      vscode.ConfigurationTarget.Workspace,
    );
    try {
      await waitFor(cond, 40_000);
    } catch {
      throw new Error(`rediscovery never produced: ${what}`);
    }
  }

  suiteSetup(async function () {
    this.timeout(120_000);
    core = await activateGeet();
    const reg = core.debugRegistry.get('phase01') as Phase01Shape | undefined;
    assert.ok(reg, 'phase01 registry missing — registerPhase01 not run?');
    phase01 = reg;
    bars = reg.statusBars;

    repoARoot = workspaceRepoA();
    repoAKey = canonicalKey(repoARoot);
    nestedDir = path.join(repoARoot, NESTED);
    nestedFile = path.join(nestedDir, 'nested.txt');

    excludeFile = path.join(repoARoot, '.git', 'info', 'exclude');
    excludeBefore = fs.existsSync(excludeFile) ? fs.readFileSync(excludeFile, 'utf8') : undefined;
    fs.mkdirSync(path.dirname(excludeFile), { recursive: true });
    fs.writeFileSync(excludeFile, `${excludeBefore ?? ''}\n${NESTED}/\n`);

    // Created here, before `canonicalKey` is asked for its key: %TEMP% hands
    // out 8.3 short names, `canonicalKey` realpaths what exists and falls back
    // to the literal spelling for what does not, and the two forms do not
    // compare equal. A bare directory carries no `.git`, so discovery ignores
    // it until the test runs `git init` inside it.
    fs.mkdirSync(nestedDir, { recursive: true });
    nestedKey = canonicalKey(nestedDir);

    // A leftover editor from an earlier suite would decide `activeRepoKey()`
    // for us; the baseline has to be the `core.repos[0]` fallback. Closing
    // fires the editor event, but only if something was open — the explicit
    // sweep makes the *starting point* deterministic. Nothing after this
    // nudges anything: the assertions below are about what Geet does on
    // its own.
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    for (const bar of bars.values()) bar.update();
  });

  suiteTeardown(async function () {
    this.timeout(120_000);
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');

    // Ignore it first and wait for the handle to go: that disposes its
    // GitDirWatcher, and until it does Windows refuses to unlink `.git`.
    await rescanUntil(
      () => !bars.has(nestedKey) && core.repos.length === 5,
      'the five fixtures',
      [NESTED],
    );
    let removed = false;
    try {
      fs.rmSync(nestedDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      removed = true;
    } catch {
      // An AV scanner still holding it. Not fatal — see the branch below.
    }

    if (excludeBefore === undefined) {
      try {
        fs.rmSync(excludeFile, { force: true, maxRetries: 5 });
      } catch {
        // Leaving one exclude line behind is harmless.
      }
    } else {
      fs.writeFileSync(excludeFile, excludeBefore);
    }

    // Back to five repositories, and to the shipped setting, before
    // syncFetchAll (repoD/repoE) runs. If the fixture survived deletion the
    // ignore entry has to stay, or the next scan rediscovers it as a sixth
    // repository in a window that expects five.
    if (removed) {
      await vscode.workspace
        .getConfiguration('geet')
        .update('repositoryScan.ignoredFolders', undefined, vscode.ConfigurationTarget.Workspace);
    } else {
      await vscode.workspace
        .getConfiguration('geet')
        .update(
          'repositoryScan.ignoredFolders',
          ['node_modules', NESTED],
          vscode.ConfigurationTarget.Workspace,
        );
    }
    await waitFor(() => core.repos.length === 5, 40_000);

    const repoA = core.repoForPath(repoARoot);
    if (repoA) {
      await repoA.refresher.refreshNow();
      await waitFor(() => repoA.model.snapshot.statusEntries.length === 0, 20_000);
    }
  });

  /**
   * POST-P14s — the reported defect, and the one the two previous attempts
   * missed. `createStatusBarItem(id, …)` says the id "must be unique within the
   * extension" because VS Code routes the entry by it: every item sharing an id
   * shares **one** entry, `show()` updates it and `hide()` *disposes* it. A
   * controller per repository, each creating `geet.status.0`, therefore gave
   * six co-owners the power to delete the seventh's widget — which is what a
   * fetch fan-out did, one `setFetching` at a time.
   *
   * Nothing downstream of the violation is observable from in here: `visible`
   * stayed true and `titles` stayed right while the entry was gone, which is
   * exactly why it survived two rounds of tests. So the assertion is the
   * contract itself, on the ids Geet actually holds.
   */
  test('one status-bar item per slot, never one per repository', function () {
    this.timeout(60_000);
    // The whole point is N repositories against a fixed number of slots; with
    // one repository the old shape could not collide and proves nothing.
    assert.ok(core.repos.length >= 2, `need ≥2 repositories, got ${core.repos.length}`);
    assert.strictEqual(bars.size, core.repos.length, 'every repository needs a controller');

    const ids = diagnostics().itemIds;
    assert.ok(ids.length > 0, 'the host created no status bar item at all');
    assert.deepStrictEqual(
      ids,
      [...new Set(ids)],
      `duplicate status bar ids — VS Code routes these to one entry, so any ` +
        `holder's hide() disposes every other holder's widget: ${ids.join(', ')}`,
    );
    // The count is a property of the slots (branch, and rebase while one is
    // running), so it must not track the repository count — that scaling is
    // what the defect looked like from here.
    assert.ok(
      ids.length <= 2,
      `${ids.length} items for ${core.repos.length} repositories: ${ids.join(', ')}`,
    );
  });

  /**
   * The behaviour that failure produced. `fetchOne` brackets each repository's
   * fetch with `setFetching(true/false)`, so a project-wide fetch updates every
   * controller in turn — and under the old shape each inactive one disposed the
   * shared entry as it went. This walks that path directly.
   */
  test('an inactive repository updating does not take the widget down', async function () {
    this.timeout(60_000);
    const first = core.repos[0];
    assert.ok(first, 'no repositories discovered');
    const firstKey = canonicalKey(first.root);
    await waitFor(() => visibleKeys().join() === firstKey, 20_000);

    const before = diagnostics().rendered;
    assert.ok(
      (before[0] ?? '').length > 0,
      `nothing was rendered to begin with: ${JSON.stringify(before)}`,
    );

    // Exactly what the fetch fan-out does to every repository that is not the
    // one on screen — and nothing else, so the widget has no reason to change.
    for (const repo of core.repos.slice(1)) {
      const bar = bars.get(canonicalKey(repo.root));
      assert.ok(bar, `no controller for ${repo.root}`);
      bar.setFetching(true);
      bar.setFetching(false);
    }

    assert.deepStrictEqual(
      diagnostics().rendered,
      before,
      'another repository fetching changed what the status bar is showing',
    );
    assert.deepStrictEqual(visibleKeys(), [firstKey], 'the active repository changed');
  });

  test('a repository leaving the workspace does not take the widget with it', async function () {
    this.timeout(120_000);

    // Baseline: nothing focused, so `activeRepoKey()` is the `core.repos[0]`
    // fallback and exactly that repository is showing.
    const first = core.repos[0];
    assert.ok(first, 'no repositories discovered');
    const firstKey = canonicalKey(first.root);
    await waitFor(() => visibleKeys().join() === firstKey, 20_000);

    // 1. A sixth repository joins.
    fs.writeFileSync(nestedFile, 'nested\n');
    execFileSync('git', ['init', '-q'], { cwd: nestedDir });
    await rescanUntil(() => bars.has(nestedKey), `a status bar for ${NESTED}`);
    assert.deepStrictEqual(
      visibleKeys(),
      [firstKey],
      'a repository joining must not add a second visible widget',
    );

    // 2. Focus a file inside it. `repoForUri` takes the longest matching root,
    //    so the nested repository is now the active one and owns the widget.
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(nestedFile));
    await vscode.window.showTextDocument(doc, { preview: false });
    await waitFor(() => visibleKeys().join() === nestedKey, 20_000);

    // 3. It leaves the workspace while its file stays open and focused, so no
    //    editor event fires to paper over the missing invalidation. Dropping it
    //    through the ignore setting rather than the filesystem is deliberate:
    //    `Core.rescan` takes the identical removal path either way, and on
    //    Windows the repository's own GitDirWatcher holds `.git` open, so
    //    deleting it there fails with EPERM for reasons that have nothing to do
    //    with what is under test.
    //
    //    This is the reported failure: before the fix `visibleKeys()` came back
    //    empty — the nested repository's items were disposed along with it, and
    //    repoA's were still holding the `visible = false` they took in step 2.
    await rescanUntil(() => !bars.has(nestedKey), `${NESTED} to be dropped`, [NESTED]);

    assert.deepStrictEqual(
      visibleKeys(),
      [repoAKey],
      'the widget vanished when the repository it was showing left the workspace',
    );

    // The surviving bar is a real widget, not just a flag: the open file now
    // resolves to repoA, and that is the repository the button must be offering.
    const bar = bars.get(repoAKey);
    assert.ok(bar, 'repoA lost its status bar controller');
    assert.match(
      bar.titles[0] ?? '',
      // `list-tree` is the branded button's mark; the git glyphs are `full`
      // mode's, and `sync~spin` is either mode mid-fetch.
      /^\$\((list-tree|git-branch|git-commit|sync~spin)\)/u,
      'the widget must still render something clickable',
    );
  });

  /**
   * POST-P14r. The widget's footprint is the whole reason the previous shape
   * failed: an unbounded `$(arrow-down) 26050 $(arrow-up) 10893` pushed it off
   * a crowded status bar. These assert the wiring — that the setting reaches
   * the controller, and that a change to it redraws with no other event.
   */
  test('the widget shape follows geet.statusBar, and the setting alone redraws it', async function () {
    this.timeout(60_000);
    const bar = bars.get(repoAKey);
    assert.ok(bar, 'repoA has no status bar controller');
    const cfg = (): vscode.WorkspaceConfiguration =>
      vscode.workspace.getConfiguration('geet');

    try {
      // Default is `auto`, and this window always has the built-in Git
      // extension, so the compact button is what `auto` must resolve to.
      await cfg().update('statusBar', undefined, vscode.ConfigurationTarget.Workspace);
      await waitFor(() => bar.titles[0] === '$(list-tree) Geet $(chevron-down)', 20_000);
      assert.ok(bar.visible, 'the button must be showing');
      assert.ok(
        (bar.tooltips[0] ?? '').includes('Click for branches and actions'),
        `tooltip: ${bar.tooltips[0] ?? ''}`,
      );

      // Nothing but the setting changes — no git operation, no editor event —
      // so reaching `full` proves the configuration listener is wired.
      await cfg().update('statusBar', 'full', vscode.ConfigurationTarget.Workspace);
      await waitFor(() => (bar.titles[0] ?? '').startsWith('$(git-branch) '), 20_000);
      assert.ok(bar.visible, 'the full widget must be showing');

      // `off` contributes nothing at all, which is not the same as hidden.
      await cfg().update('statusBar', 'off', vscode.ConfigurationTarget.Workspace);
      await waitFor(() => bar.visible === false, 20_000);
      assert.strictEqual(bar.titles.join(''), '', `off must render nothing: ${bar.titles.join()}`);
    } finally {
      await cfg().update('statusBar', undefined, vscode.ConfigurationTarget.Workspace);
      await waitFor(() => bar.titles[0] === '$(list-tree) Geet $(chevron-down)', 20_000);
    }
  });
});
