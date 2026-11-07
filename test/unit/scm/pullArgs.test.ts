/**
 * POST-QA F6: GitTree: Pull says how to reconcile when git's config does not,
 * and stays out of the way when it does.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { GitExecutorImpl } from '../../../src/core/git/executor';
import { pullStrategyArgs } from '../../../src/scm/pullArgs';
import { FixtureRepo } from '../../fixtures/fixtureRepo';

// GIT_CONFIG_NOSYSTEM / an empty global config keep this machine's settings
// (pull.rebase in a user's ~/.gitconfig) out of the answer.
const git = new GitExecutorImpl({ gitPath: 'git', version: '2.43.0' });
const repos: FixtureRepo[] = [];
afterEach(() => {
  for (const r of repos.splice(0)) r.dispose();
});

function repo(): FixtureRepo {
  const r = FixtureRepo.create({ prefix: 'gittree-pullargs-' });
  repos.push(r);
  r.commit('base', { 'a.txt': 'a\n' });
  return r;
}

describe('pullStrategyArgs', () => {
  it('merges explicitly when nothing is configured', async () => {
    const r = repo();
    // Asked through the same executor: a machine-wide pull.rebase (Git for
    // Windows' installer writes one) decides before GitTree would.
    const machine = await git.exec(r.root, ['config', '--get-regexp', '^pull\\.'], { allowNonZeroExit: true });
    const expected = machine.stdout.trim().length > 0 ? [] : ['--no-rebase'];
    expect(await pullStrategyArgs(git, r.root, 'main')).toEqual(expected);
  });

  it('leaves pull.rebase, pull.ff and branch.<name>.rebase to git', async () => {
    const a = repo();
    a.git('config', 'pull.rebase', 'true');
    expect(await pullStrategyArgs(git, a.root, 'main')).toEqual([]);

    const b = repo();
    b.git('config', 'pull.ff', 'only');
    expect(await pullStrategyArgs(git, b.root, 'main')).toEqual([]);

    const c = repo();
    c.git('config', 'branch.main.rebase', 'merges');
    expect(await pullStrategyArgs(git, c.root, 'main')).toEqual([]);
  });
});
