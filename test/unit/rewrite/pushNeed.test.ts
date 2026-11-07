/**
 * POST-QA F2: a rewrite needs a force push only when it replaced commits that
 * were already on the upstream — not merely because the upstream moved on.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { GitExecutorImpl } from '../../../src/core/git/executor';
import { pushNeedAfterRewrite } from '../../../src/rewrite/pushNeed';
import { FixtureRepo } from '../../fixtures/fixtureRepo';

const git = new GitExecutorImpl({ gitPath: 'git', version: '2.43.0' });
const repos: FixtureRepo[] = [];
afterEach(() => {
  for (const r of repos.splice(0)) r.dispose();
});

/**
 * main: base ← pushed (on origin/main) ← local; origin/main optionally one
 * teammate commit further. The remote-tracking ref stands in for a fetch.
 */
function setup(incoming: boolean): { repo: FixtureRepo; pushed: string; local: string } {
  const repo = FixtureRepo.create({ prefix: 'gittree-pushneed-' });
  repos.push(repo);
  repo.commit('base', { 'a.txt': 'a\n' });
  const pushed = repo.commit('pushed', { 'b.txt': 'b\n' });
  let upstreamTip = pushed;
  if (incoming) {
    repo.git('checkout', '-q', '-b', 'mate');
    upstreamTip = repo.commit('teammate', { 'm.txt': 'm\n' });
    repo.git('checkout', '-q', 'main');
    repo.git('branch', '-q', '-D', 'mate');
  }
  repo.git('update-ref', 'refs/remotes/origin/main', upstreamTip);
  const local = repo.commit('local', { 'c.txt': 'c\n' });
  return { repo, pushed, local };
}

const reword = (repo: FixtureRepo, message: string): void => {
  repo.git('commit', '-q', '--amend', '-m', message);
};

describe('pushNeedAfterRewrite', () => {
  it('rewording a commit that was never pushed needs no force, even with incoming commits (the QA case)', async () => {
    const { repo, local } = setup(true);
    reword(repo, 'local, reworded');
    expect(await pushNeedAfterRewrite(git, repo.root, 'origin/main', local, [])).toBe('none');
  });

  it('rewriting a pushed commit needs a force push', async () => {
    const { repo, pushed } = setup(false);
    repo.git('reset', '-q', '--hard', pushed);
    const preHead = repo.head();
    reword(repo, 'pushed, reworded');
    expect(await pushNeedAfterRewrite(git, repo.root, 'origin/main', preHead, [])).toBe('force');
  });

  it('says a force push would lose the commits the branch never brought in', async () => {
    const { repo, pushed } = setup(true);
    repo.git('reset', '-q', '--hard', pushed);
    const preHead = repo.head();
    reword(repo, 'pushed, reworded');
    expect(await pushNeedAfterRewrite(git, repo.root, 'origin/main', preHead, [])).toBe('force-would-lose');
  });

  it('a protected branch is never offered a force push', async () => {
    const { repo, pushed } = setup(false);
    repo.git('reset', '-q', '--hard', pushed);
    const preHead = repo.head();
    reword(repo, 'pushed, reworded');
    expect(await pushNeedAfterRewrite(git, repo.root, 'origin/main', preHead, ['master', 'main'])).toBe('protected');
    expect(await pushNeedAfterRewrite(git, repo.root, 'origin/main', preHead, ['release/.*'])).toBe('force');
  });

  it('dropping only unpushed commits needs no force', async () => {
    const { repo, pushed, local } = setup(true);
    repo.git('reset', '-q', '--hard', pushed);
    expect(await pushNeedAfterRewrite(git, repo.root, 'origin/main', local, [])).toBe('none');
  });
});
