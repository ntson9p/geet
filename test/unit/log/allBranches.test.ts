/**
 * POST-QA: "All branches" lists every branch, remote branch and tag — and no
 * stash internals, which `git log --all` showed as commits.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildLogArgs, DEFAULT_FILTER } from '../../../src/log/logFilter';
import { FixtureRepo } from '../../fixtures/fixtureRepo';

const repos: FixtureRepo[] = [];
afterEach(() => {
  for (const r of repos.splice(0)) r.dispose();
});

describe('All branches against real git', () => {
  it('shows a branch and a tag, never a stash', () => {
    const repo = FixtureRepo.create({ prefix: 'gittree-allbranches-' });
    repos.push(repo);
    repo.commit('base', { 'a.txt': 'a\n' });
    repo.branch('side', { checkout: true });
    repo.commit('on side', { 'b.txt': 'b\n' });
    repo.checkout('main');
    repo.commit('on main', { 'c.txt': 'c\n' });
    repo.tag('v1');
    fs.writeFileSync(path.join(repo.root, 'a.txt'), 'wip\n');
    fs.writeFileSync(path.join(repo.root, 'u.txt'), 'untracked\n');
    repo.git('stash', 'push', '-u', '-m', 'parked work');

    const args = buildLogArgs({ ...DEFAULT_FILTER, refs: 'ALL' }, '%s', { skip: 0, maxCount: 100 });
    const subjects = repo.git(...args).split('\n').filter((l) => l.length > 0);
    expect(subjects).toEqual(expect.arrayContaining(['on main', 'on side', 'base']));
    // `git log --all` adds "On main: parked work", "index on main: …" and
    // "untracked files on main: …".
    expect(subjects.filter((s) => /parked work|index on main|untracked files on/u.test(s))).toEqual([]);
    expect(repo.git('log', '--all', '--format=%s')).toMatch(/parked work/u);
  });
});
