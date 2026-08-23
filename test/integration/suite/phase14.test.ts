import * as assert from 'node:assert';
import * as vscode from 'vscode';
import type { Phase03Registry } from '../../../src/commit/register';
import { activateGitTree, workspaceRepoC } from '../setup';

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
    // `scm/change/title` is the quick-diff peek toolbar and outlives T2; it goes
    // with the quick-diff provider itself in T4.
    assert.deepStrictEqual(
      Object.keys(menus).filter((k) => k.startsWith('scm')),
      ['scm/change/title'],
      'only the quick-diff peek menu may remain',
    );

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
});
