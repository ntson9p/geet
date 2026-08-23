import * as assert from 'node:assert';
import * as vscode from 'vscode';
import { canonicalKey } from '../../../src/core/repoDiscovery';
import type { GitTreeApi } from '../../../src/extension';

/**
 * P0-T7 acceptance: the multi-root fixture workspace (two repos, wired in
 * runTests.ts) is discovered; activation performs no consent side effects.
 */
suite('P0-T7 discovery, activation, ModeManager', () => {
  async function core() {
    const ext = vscode.extensions.getExtension<GitTreeApi>('gittree.gittree');
    assert.ok(ext, 'extension missing');
    const api = await ext.activate();
    const corePromise = api.getCore();
    assert.ok(corePromise, 'test hook getCore() unavailable — GITTREE_TEST not set?');
    const c = await corePromise;
    assert.ok(c, 'core failed to initialize (git missing?)');
    return c;
  }

  test('discovers all workspace repos', async function () {
    this.timeout(30_000);
    const c = await core();
    assert.strictEqual(c.repos.length, 3, `expected 3 repos, got ${c.repos.map((r) => r.root).join(', ')}`);
    const keys = c.repos.map((r) => canonicalKey(r.root));
    const repoA = process.env['GITTREE_TEST_REPO_A'];
    const repoB = process.env['GITTREE_TEST_REPO_B'];
    assert.ok(repoA && repoB, 'runner did not export fixture repo paths');
    assert.ok(keys.includes(canonicalKey(repoA)), `repoA missing from ${keys.join(', ')}`);
    assert.ok(keys.includes(canonicalKey(repoB)), `repoB missing from ${keys.join(', ')}`);
  });

  test('models are populated after discovery', async function () {
    this.timeout(30_000);
    const c = await core();
    for (const repo of c.repos) {
      assert.match(repo.model.snapshot.headSha ?? '', /^[0-9a-f]{40}$/, `no HEAD sha for ${repo.root}`);
      assert.ok(repo.model.snapshot.refs.length > 0, `no refs for ${repo.root}`);
      assert.strictEqual(repo.model.snapshot.statusEntries.length, 0, `dirty fixture ${repo.root}`);
    }
  });

  test('repoForUri picks the owning repo', async function () {
    this.timeout(30_000);
    const c = await core();
    const [a] = c.repos;
    assert.ok(a);
    const inner = vscode.Uri.joinPath(vscode.Uri.file(a.root), 'src', 'x.ts');
    assert.strictEqual(c.repoForUri(inner)?.root, a.root);
    assert.strictEqual(c.repoForUri(vscode.Uri.file('/nowhere/else')), undefined);
  });

  test('activation leaves the built-in git untouched', async function () {
    this.timeout(30_000);
    await core();
    // P14-T6 deleted the consent machinery entirely, so this is now an
    // unconditional guarantee rather than a property of the "unset" mode:
    // nothing in GitTree writes `git.enabled` except the one-shot migration
    // that REMOVES an override this extension wrote earlier, and this
    // workspace never had one.
    const inspected = vscode.workspace.getConfiguration('git').inspect<boolean>('enabled');
    assert.strictEqual(inspected?.workspaceValue, undefined, 'git.enabled must not be written');
  });

  test('debug command dumps repository state as JSON', async function () {
    this.timeout(30_000);
    await core();
    await vscode.commands.executeCommand('gittree.debug.showState');
    const doc = vscode.window.activeTextEditor?.document;
    assert.ok(doc, 'no active editor after debug command');
    const parsed = JSON.parse(doc.getText()) as Array<{ root: string; snapshot: unknown }>;
    assert.strictEqual(parsed.length, 3);
    assert.ok(parsed[0]?.snapshot);
  });
});
