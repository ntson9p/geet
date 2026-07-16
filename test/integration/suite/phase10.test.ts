import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { Core, RepoHandle } from '../../../src/core/core';
import { activateGitTree, gitWithRetry, workspaceRepoA } from '../setup';

interface Phase10RegistryShape {
  offerPlaybook(repoRoot: string): Promise<void>;
  generatePlayground(): Promise<string | undefined>;
}

/** P10-T1 step 4: large-repo playbook prompt (threshold + choice seams). */
suite('P10 hardening — large-repo playbook', () => {
  let core: Core;
  let repo: RepoHandle;
  let reg: Phase10RegistryShape;

  const git = (...args: string[]): string => gitWithRetry(repo.root, args);

  suiteSetup(async function () {
    this.timeout(60_000);
    core = await activateGitTree();
    repo = core.repoForPath(workspaceRepoA())!;
    assert.ok(repo, 'repoA not discovered');
    reg = core.debugRegistry.get('phase10') as Phase10RegistryShape;
    assert.ok(reg, 'phase10 registry missing');
  });

  test('T1: >threshold repo offers fsmonitor+untrackedCache once; enable writes config', async function () {
    this.timeout(60_000);
    const gitVersion = git('--version');
    const m = /(\d+)\.(\d+)/.exec(gitVersion);
    const supportsFsmonitor =
      m !== null &&
      (Number(m[1]) > 2 || (Number(m[1]) === 2 && Number(m[2]) >= 37));
    if (!supportsFsmonitor) {
      this.skip(); // capability-gated feature — nothing to offer on old git
      return;
    }

    process.env['GITTREE_TEST_LARGE_REPO_THRESHOLD'] = '1';
    process.env['GITTREE_TEST_PLAYBOOK_CHOICE'] = 'enable';
    try {
      await reg.offerPlaybook(repo.root);
      assert.strictEqual(git('config', 'core.fsmonitor').trim(), 'true');
      assert.strictEqual(git('config', 'core.untrackedCache').trim(), 'true');

      // One-time: a second offer must not rewrite config (remembered answer).
      git('config', '--unset', 'core.fsmonitor');
      await reg.offerPlaybook(repo.root);
      assert.throws(() => git('config', 'core.fsmonitor'), 'second offer must be a no-op');
    } finally {
      delete process.env['GITTREE_TEST_LARGE_REPO_THRESHOLD'];
      delete process.env['GITTREE_TEST_PLAYBOOK_CHOICE'];
      try {
        git('fsmonitor--daemon', 'stop');
      } catch {
        // daemon never started — fine
      }
      try {
        git('config', '--unset', 'core.fsmonitor');
      } catch {
        // already unset
      }
      try {
        git('config', '--unset', 'core.untrackedCache');
      } catch {
        // already unset
      }
      await repo.refresher.refreshNow();
    }
  });
});

/** P10-T3: onboarding — playground generator + walkthrough plumbing. */
suite('P10 onboarding — playground generator', () => {
  let reg: Phase10RegistryShape;
  const target = path.join(os.tmpdir(), `gittree-e2e-playground-${process.pid}`);

  suiteSetup(async function () {
    this.timeout(60_000);
    const core = await activateGitTree();
    reg = core.debugRegistry.get('phase10') as Phase10RegistryShape;
    assert.ok(reg, 'phase10 registry missing');
  });

  suiteTeardown(() => {
    // .git objects carry the readonly bit on Windows — plain rmSync EPERMs.
    if (!fs.existsSync(target)) return;
    const clearReadonly = (d: string): void => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, e.name);
        if (e.isDirectory()) clearReadonly(full);
        else fs.chmodSync(full, 0o666);
      }
    };
    clearReadonly(target);
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 5 });
  });

  test('T3: generates a walkthrough-shaped repo — history, pending edit, conflicting branch', async function () {
    this.timeout(60_000);
    process.env['GITTREE_TEST_PLAYGROUND_DIR'] = target;
    try {
      const dir = await reg.generatePlayground();
      assert.strictEqual(dir, target);

      const git = (...args: string[]): string => gitWithRetry(target, args);
      // main has 3 commits and blame-worthy history…
      assert.strictEqual(git('rev-parse', '--abbrev-ref', 'HEAD').trim(), 'main');
      const log = git('log', '--oneline').trim().split('\n');
      assert.strictEqual(log.length, 3, `main history: ${log.join(' | ')}`);
      // …and the pending edit for the user's first commit.
      assert.match(git('status', '--porcelain'), /^ M NOTES\.md/m);

      // Walkthrough order: the first-commit exercise cleans the worktree…
      git('add', 'NOTES.md');
      git('commit', '-m', 'my first commit');

      // …then the conflict exercise: rebasing feature/polish onto main must
      // conflict, specifically on src/greeting.js.
      git('checkout', 'feature/polish');
      try {
        assert.throws(
          () => git('rebase', 'main'),
          /conflict|could not apply|patch failed|failed/i,
          'rebase onto main must conflict',
        );
        assert.match(git('status', '--porcelain'), /^(UU|AA) src\/greeting\.js/m);
      } finally {
        try {
          git('rebase', '--abort');
        } catch {
          // no rebase in progress — the throw happened before conflict state
        }
        git('checkout', 'main');
      }
      // Non-empty target refused (no clobbering).
      assert.strictEqual(await reg.generatePlayground(), undefined);
    } finally {
      delete process.env['GITTREE_TEST_PLAYGROUND_DIR'];
    }
  });

  test('T3: walkthrough + onboarding commands are registered', async () => {
    const all = await vscode.commands.getCommands(true);
    for (const cmd of ['gittree.openWalkthrough', 'gittree.generatePlayground']) {
      assert.ok(all.includes(cmd), `${cmd} missing`);
    }
  });
});
