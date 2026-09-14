import * as assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { canonicalKey, RepoDiscovery } from '../../../src/core/repoDiscovery';
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
    assert.strictEqual(c.repos.length, 5, `expected 5 repos, got ${c.repos.map((r) => r.root).join(', ')}`);
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

  /**
   * The reported arrangement: one plain folder holding several checkouts.
   * Exercised against the real filesystem and the real git probe — the unit
   * suite fakes both, and this is where Windows path spellings (8.3 names,
   * drive-letter case) get a say. The fixture lives outside the shared
   * workspace on purpose: adding a workspace folder would perturb every other
   * suite in this window.
   */
  suite('a folder of checkouts', () => {
    let parent: string;
    const expected: string[] = [];

    suiteSetup(function () {
      this.timeout(60_000);
      parent = fs.mkdtempSync(path.join(os.tmpdir(), 'gittree-scan-'));
      for (const name of ['alpha', 'beta', 'gamma']) {
        const repo = path.join(parent, name);
        fs.mkdirSync(repo);
        execFileSync('git', ['init', '-q'], { cwd: repo });
        expected.push(canonicalKey(repo));
      }
      // A plain directory alongside them, and a repo one level deeper.
      fs.mkdirSync(path.join(parent, 'docs'));
      const deep = path.join(parent, 'group', 'delta');
      fs.mkdirSync(deep, { recursive: true });
      execFileSync('git', ['init', '-q'], { cwd: deep });
      expected.sort();
    });

    suiteTeardown(() => {
      // %TEMP% is not a dumping ground — this fixture is ours to remove.
      try {
        fs.rmSync(parent, { recursive: true, force: true, maxRetries: 5 });
      } catch {
        // A lingering git handle on Windows must not fail the suite.
      }
    });

    /** A RepoDiscovery wired to the real git executor, as Core wires it. */
    async function realDiscovery(): Promise<RepoDiscovery> {
      const c = await core();
      return new RepoDiscovery({
        getRepoRoot: async (dir) => {
          const r = await c.git.exec(dir, ['rev-parse', '--show-toplevel'], {
            structured: true,
            noOptionalLocks: true,
            allowNonZeroExit: true,
          });
          if (r.exitCode !== 0) return undefined;
          const top = r.stdout.trim();
          return top.length > 0 ? path.normalize(top) : undefined;
        },
      });
    }

    test('are all found at the default depth, and none without the scan', async function () {
      this.timeout(60_000);
      const d = await realDiscovery();

      const found = (await d.scan([parent], { maxDepth: 1 })).map((r) => canonicalKey(r));
      assert.deepStrictEqual(
        found.sort(),
        expected,
        'the folder of checkouts must yield exactly its checkouts',
      );

      // The parent-walk alone is what shipped, and it finds nothing here.
      assert.deepStrictEqual(
        await d.scan([parent]),
        [],
        'without the downward scan this folder resolves to no repository at all',
      );
    });

    test('reach a deeper checkout only when the depth allows it', async function () {
      this.timeout(60_000);
      const d = await realDiscovery();
      const delta = canonicalKey(path.join(parent, 'group', 'delta'));

      const shallow = (await d.scan([parent], { maxDepth: 1 })).map((r) => canonicalKey(r));
      assert.ok(!shallow.includes(delta), 'depth 1 must not reach group/delta');

      const deeper = (await d.scan([parent], { maxDepth: 2 })).map((r) => canonicalKey(r));
      assert.deepStrictEqual(deeper.sort(), [...expected, delta].sort());
    });

    test('match opening every checkout as its own workspace folder', async function () {
      this.timeout(60_000);
      const d = await realDiscovery();
      const scanned = (await d.scan([parent], { maxDepth: 1 })).map((r) => canonicalKey(r)).sort();
      const asFolders = (
        await d.scan(['alpha', 'beta', 'gamma'].map((n) => path.join(parent, n)))
      )
        .map((r) => canonicalKey(r))
        .sort();
      assert.deepStrictEqual(scanned, asFolders, 'the two ways of opening must agree');
    });

    test('are governed by settings that are actually registered', () => {
      // Core reads these two keys; a typo in either package.json id would
      // silently fall back to the `get` default and never be tunable.
      const cfg = vscode.workspace.getConfiguration('gittree');
      assert.strictEqual(
        cfg.inspect<number>('repositoryScan.maxDepth')?.defaultValue,
        1,
        'gittree.repositoryScan.maxDepth is not contributed with default 1',
      );
      assert.deepStrictEqual(
        cfg.inspect<string[]>('repositoryScan.ignoredFolders')?.defaultValue,
        ['node_modules'],
        'gittree.repositoryScan.ignoredFolders is not contributed with the expected default',
      );
    });

    test('skip an ignored folder by name', async function () {
      this.timeout(60_000);
      const d = await realDiscovery();
      const found = (
        await d.scan([parent], { maxDepth: 1, ignoredFolders: ['beta', 'gam*'] })
      ).map((r) => canonicalKey(r));
      assert.deepStrictEqual(found, [canonicalKey(path.join(parent, 'alpha'))]);
    });
  });

  test('debug command dumps repository state as JSON', async function () {
    this.timeout(30_000);
    await core();
    await vscode.commands.executeCommand('gittree.debug.showState');
    const doc = vscode.window.activeTextEditor?.document;
    assert.ok(doc, 'no active editor after debug command');
    const parsed = JSON.parse(doc.getText()) as {
      statusBar: { activeRepoKey?: string; repoKeys?: string[]; bars?: unknown[] };
      repos: Array<{ root: string; snapshot: unknown }>;
    };
    assert.strictEqual(parsed.repos.length, 5);
    assert.ok(parsed.repos[0]?.snapshot);
    // The status-bar block is why this dump gets opened; an empty one would be
    // a diagnostic that cannot answer the question it exists for.
    assert.strictEqual(parsed.statusBar.repoKeys?.length, 5);
    assert.strictEqual(parsed.statusBar.bars?.length, 5);
    assert.ok(parsed.statusBar.activeRepoKey, 'no active repo key resolved');
  });
});
