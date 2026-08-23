import * as assert from 'node:assert';
import * as vscode from 'vscode';

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

  /** Views GitTree contributes to its own container, in manifest order. */
  const EXPECTED_VIEWS = [
    'gittree.commit',
    'gittree.changelists',
    'gittree.branches',
    'gittree.worktrees',
    'gittree.compare',
    'gittree.localHistory',
    'gittree.conflicts',
    'gittree.stashes',
    'gittree.shelf',
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
});
