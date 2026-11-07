/**
 * POST-QA F7: Yours and Theirs follow the user. Mid-rebase git's stage 2
 * ("ours") is the branch being rebased onto and stage 3 the user's own commit,
 * so every side the user picks is swapped back — as IntelliJ swaps it.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createGitExecutor } from '../../../src/core/git/executor';
import { isRebasing } from '../../../src/core/model/inProgressOp';
import { gitSideFlag, sideRef, userConflictKind } from '../../../src/merge/conflictKinds';
import { MergeComputer } from '../../../src/merge/mergeCompute';
import { FixtureRepo, midRebase } from '../../fixtures/fixtureRepo';

const repos: FixtureRepo[] = [];
afterEach(() => {
  for (const r of repos.splice(0)) r.dispose();
});

describe('gitSideFlag / userConflictKind / sideRef', () => {
  it('keeps git\'s sides outside a rebase', () => {
    expect(gitSideFlag('ours', false)).toBe('--ours');
    expect(gitSideFlag('theirs', false)).toBe('--theirs');
    expect(userConflictKind('deleted-by-us', false)).toBe('deleted-by-us');
    expect(sideRef('left', false, 'merge')).toBe('HEAD');
    expect(sideRef('right', false, 'merge')).toBe('MERGE_HEAD');
    expect(sideRef('right', false, 'cherry-pick')).toBe('CHERRY_PICK_HEAD');
    expect(sideRef('right', false, 'revert')).toBe('REVERT_HEAD');
    // An unstash or unshelve has no commit for the incoming side.
    expect(sideRef('right', false, undefined)).toBeUndefined();
  });

  it('swaps them mid-rebase', () => {
    expect(gitSideFlag('ours', true)).toBe('--theirs');
    expect(gitSideFlag('theirs', true)).toBe('--ours');
    expect(userConflictKind('deleted-by-us', true)).toBe('deleted-by-them');
    expect(userConflictKind('deleted-by-them', true)).toBe('deleted-by-us');
    expect(userConflictKind('both-modified', true)).toBe('both-modified');
    expect(sideRef('left', true, 'rebase-interactive')).toBe('REBASE_HEAD');
    expect(sideRef('right', true, 'rebase-interactive')).toBe('HEAD');
  });
});

describe('isRebasing', () => {
  it('is true mid-rebase and false mid-merge', () => {
    const rebasing = midRebase();
    repos.push(rebasing);
    expect(isRebasing(rebasing.gitDir)).toBe(true);

    const merging = FixtureRepo.create({ prefix: 'gittree-midmerge-' });
    repos.push(merging);
    merging.makeConflict();
    expect(isRebasing(merging.gitDir)).toBe(false);
  });

  it('is false for git am, which shares rebase-apply but applies onto the user\'s branch', () => {
    const repo = FixtureRepo.create({ prefix: 'gittree-am-' });
    repos.push(repo);
    repo.commit('base', { 'a.txt': 'a\n' });
    fs.mkdirSync(path.join(repo.gitDir, 'rebase-apply'));
    fs.writeFileSync(path.join(repo.gitDir, 'rebase-apply', 'applying'), '');
    expect(isRebasing(repo.gitDir)).toBe(false);
    fs.writeFileSync(path.join(repo.gitDir, 'rebase-apply', 'rebasing'), '');
    expect(isRebasing(repo.gitDir)).toBe(true);
  });
});

describe('a rebase conflict, from the user\'s side', () => {
  it('puts the user\'s own commit in Yours, and --ours/--theirs agree with it', async () => {
    // main ("OURS line 2") rebased onto fixture/theirs ("THEIRS line 2").
    const repo = midRebase();
    repos.push(repo);
    const rel = 'rebase-conflict.txt';
    const git = await createGitExecutor({});
    if (!git) throw new Error('git not found');
    const computer = new MergeComputer((args) =>
      git.exec(repo.root, args, { structured: true, noOptionalLocks: true, allowNonZeroExit: true }),
    );

    const asGit = await computer.compute(rel);
    const asUser = await computer.compute(rel, { reversed: true });
    if (asGit.kind !== 'text' || asUser.kind !== 'text') throw new Error('expected text');
    // Raw stages: git's "ours" is the branch rebased onto.
    expect(asGit.merge.stages.ours).toContain('THEIRS line 2');
    // Swapped: Yours is the user's own change.
    expect(asUser.merge.stages.ours).toContain('OURS line 2');
    expect(asUser.merge.stages.theirs).toContain('THEIRS line 2');
    expect(asUser.merge.blocks[0]?.ours.join('')).toContain('OURS line 2');

    // Accept Yours checks out the user's version.
    repo.git('checkout', gitSideFlag('ours', isRebasing(repo.gitDir)), '--', rel);
    expect(fs.readFileSync(path.join(repo.root, rel), 'utf8')).toContain('OURS line 2');
    repo.git('checkout', gitSideFlag('theirs', isRebasing(repo.gitDir)), '--', rel);
    expect(fs.readFileSync(path.join(repo.root, rel), 'utf8')).toContain('THEIRS line 2');
  });
});
