import * as assert from 'node:assert';
import type { Core, RepoHandle } from '../../../src/core/core';
import { activateGitTree, gitWithRetry, workspaceRepoA } from '../setup';

interface Phase10RegistryShape {
  offerPlaybook(repoRoot: string): Promise<void>;
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
