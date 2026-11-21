/**
 * POST-QA: HEAD plus a selection through a scratch index, against real git —
 * the changelists commit of a merge, which `commit --only` refuses, and the
 * ordinary partial commit it has always been.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { commitSelection, SCRATCH_INDEX } from '../../../src/commit/selectionCommit';
import { GitExecutorImpl } from '../../../src/core/git/executor';
import { FixtureRepo } from '../../fixtures/fixtureRepo';

const git = new GitExecutorImpl({ gitPath: 'git', version: '2.43.0' });
const plain = { amend: false, sign: false };

const repos: FixtureRepo[] = [];
afterEach(() => {
  for (const r of repos.splice(0)) r.dispose();
});

const status = (repo: FixtureRepo): string[] =>
  repo
    .git('status', '--porcelain')
    .split('\n')
    .filter((l) => l.length > 0)
    .sort();

/**
 * Mid-merge: f.txt conflicted and resolved (staged), g.txt merged cleanly,
 * n.txt added and h.txt deleted by theirs; unrelated.txt a local file.
 */
function midMerge(): FixtureRepo {
  const repo = FixtureRepo.create({ prefix: 'geet-selcommit-' });
  repos.push(repo);
  repo.commit('base', { 'f.txt': 'a\nb\nc\n', 'g.txt': 'one\n', 'h.txt': 'keep\n' });
  repo.branch('other', { checkout: true });
  repo.commit('theirs', { 'f.txt': 'a\nB-theirs\nc\n', 'g.txt': 'one\ntwo\n', 'n.txt': 'new\n', 'h.txt': null });
  repo.checkout(repo.defaultBranch);
  repo.commit('ours', { 'f.txt': 'a\nB-ours\nc\n' });
  expect(repo.merge('other')).toBe(false);
  repo.writeFiles({ 'f.txt': 'a\nB-resolved\nc\n', 'unrelated.txt': 'local\n' });
  repo.git('add', 'f.txt');
  return repo;
}

describe('commitSelection', () => {
  it('commits a merge from what is ticked, which `commit --only` refuses', async () => {
    const repo = midMerge();
    expect(repo.tryGit('commit', '-m', 'x', '--only', '--', 'f.txt').stderr).toMatch(
      /cannot do a partial commit during a merge/u,
    );
    const ours = repo.head();
    await commitSelection(git, repo.root, repo.gitDir, ['f.txt', 'g.txt', 'n.txt', 'h.txt'], [], 'Merge other', plain);

    expect(repo.git('rev-list', '--parents', '-n', '1', 'HEAD').trim().split(' ')).toEqual([
      repo.head(),
      ours,
      repo.git('rev-parse', 'other').trim(),
    ]);
    expect(fs.existsSync(path.join(repo.gitDir, 'MERGE_HEAD'))).toBe(false);
    expect(repo.git('show', 'HEAD:f.txt')).toBe('a\nB-resolved\nc\n');
    expect(repo.git('show', 'HEAD:g.txt')).toBe('one\ntwo\n');
    expect(repo.git('show', 'HEAD:n.txt')).toBe('new\n');
    expect(repo.tryGit('cat-file', '-e', 'HEAD:h.txt').status).not.toBe(0);
    expect(repo.git('log', '-1', '--format=%s')).toBe('Merge other\n');
    // The local file was never ticked, and nothing else is left over.
    expect(status(repo)).toEqual(['?? unrelated.txt']);
    expect(fs.existsSync(path.join(repo.gitDir, SCRATCH_INDEX))).toBe(false);
  });

  it('keeps our side of an unticked file in the merge commit, its merged content still at hand', async () => {
    const repo = midMerge();
    await commitSelection(git, repo.root, repo.gitDir, ['f.txt', 'n.txt', 'h.txt'], [], 'Merge other', plain);

    expect(repo.git('rev-list', '--parents', '-n', '1', 'HEAD').trim().split(' ')).toHaveLength(3);
    expect(repo.git('show', 'HEAD:g.txt')).toBe('one\n');
    expect(fs.readFileSync(path.join(repo.root, 'g.txt'), 'utf8')).toBe('one\ntwo\n');
    expect(status(repo)).toEqual(['?? unrelated.txt', 'M  g.txt']);
  });

  it('commits whole files and a part of another, and leaves the working tree and the rest of the index alone', async () => {
    const repo = FixtureRepo.create({ prefix: 'geet-selcommit-' });
    repos.push(repo);
    repo.commit('base', { 'a.txt': 'a1\n', 'p.txt': 'l1\nl2\nl3\nl4\n', 's.txt': 's1\n' });
    repo.writeFiles({ 'a.txt': 'a2\n', 'p.txt': 'L1\nl2\nl3\nL4\n', 's.txt': 's2\n' });
    repo.git('add', 's.txt');
    // Line 1 of p.txt only.
    const patch = '--- a/p.txt\n+++ b/p.txt\n@@ -1 +1 @@\n-l1\n+L1\n';
    await commitSelection(git, repo.root, repo.gitDir, ['a.txt'], [{ relPath: 'p.txt', patch }], 'part', plain);

    expect(repo.git('show', 'HEAD:a.txt')).toBe('a2\n');
    expect(repo.git('show', 'HEAD:p.txt')).toBe('L1\nl2\nl3\nl4\n');
    expect(repo.git('show', 'HEAD:s.txt')).toBe('s1\n');
    expect(fs.readFileSync(path.join(repo.root, 'p.txt'), 'utf8')).toBe('L1\nl2\nl3\nL4\n');
    expect(status(repo)).toEqual([' M p.txt', 'M  s.txt']);
  });

  it('refuses while a conflict is left, though the scratch index would not see it', async () => {
    const repo = FixtureRepo.create({ prefix: 'geet-selcommit-' });
    repos.push(repo);
    repo.makeConflict('c.txt');
    repo.writeFiles({ 'other.txt': 'x\n' });
    const before = repo.head();
    await expect(
      commitSelection(git, repo.root, repo.gitDir, ['other.txt'], [], 'too soon', plain),
    ).rejects.toThrow(/unmerged files/u);
    expect(repo.head()).toBe(before);
    expect(fs.existsSync(path.join(repo.gitDir, 'MERGE_HEAD'))).toBe(true);
    expect(fs.existsSync(path.join(repo.gitDir, SCRATCH_INDEX))).toBe(false);
  });

  it('commits a ticked untracked file in a merge', async () => {
    const repo = midMerge();
    await commitSelection(
      git,
      repo.root,
      repo.gitDir,
      ['f.txt', 'g.txt', 'n.txt', 'h.txt', 'unrelated.txt'],
      [],
      'Merge other',
      plain,
    );
    expect(repo.git('show', 'HEAD:unrelated.txt')).toBe('local\n');
    expect(status(repo)).toEqual([]);
  });
});
