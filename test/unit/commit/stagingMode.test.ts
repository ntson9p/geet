/**
 * POST-QA F5: the staging paradigm's Commit window — IntelliJ's Staged /
 * Unstaged / Unversioned nodes, no ticks, a row's diff by its half, and whole
 * files staged and unstaged against real git.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { stageFiles, unstageFiles } from '../../../src/commit/staging/stageFiles';
import { localDiffSides } from '../../../src/commit/window/localDiffSides';
import { stagingGroups } from '../../../src/commit/window/stagingGroups';
import { GitExecutorImpl } from '../../../src/core/git/executor';
import type { StatusEntry } from '../../../src/core/model/statusEntry';
import {
  CONFLICTS_GROUP_ID,
  STAGED_GROUP_ID,
  stagingSideOf,
  UNSTAGED_GROUP_ID,
  UNVERSIONED_GROUP_ID,
} from '../../../src/shared/protocol';
import { FixtureRepo } from '../../fixtures/fixtureRepo';

const NAMES = { conflicts: 'Merge Conflicts', staged: 'Staged', unstaged: 'Unstaged', unversioned: 'Unversioned Files' };
const entry = (p: string, x: string, y: string, extra: Partial<StatusEntry> = {}): StatusEntry =>
  ({ kind: 'ordinary', path: p, x, y, ...extra }) as StatusEntry;

describe('stagingGroups', () => {
  it('puts a file staged in part in both Staged and Unstaged, and ticks nothing', () => {
    const groups = stagingGroups(
      [
        entry('both.ts', 'M', 'M'),
        entry('staged.ts', 'A', '.'),
        entry('worktree.ts', '.', 'D'),
        entry('new.txt', '?', '?', { kind: 'untracked' }),
      ],
      NAMES,
    );
    expect(groups.map((g) => g.id)).toEqual([STAGED_GROUP_ID, UNSTAGED_GROUP_ID, UNVERSIONED_GROUP_ID]);
    expect(groups.every((g) => !g.checkable)).toBe(true);
    const [staged, unstaged, unversioned] = groups;
    expect(staged!.changes.map((c) => [c.path, c.kind, c.checked])).toEqual([
      ['both.ts', 'modified', true],
      ['staged.ts', 'added', true],
    ]);
    expect(unstaged!.changes.map((c) => [c.path, c.kind, c.checked])).toEqual([
      ['both.ts', 'modified', false],
      ['worktree.ts', 'deleted', false],
    ]);
    expect(unversioned!.changes.map((c) => c.kind)).toEqual(['untracked']);
  });

  it('keeps a staged rename\'s old name, and puts conflicts first', () => {
    const groups = stagingGroups(
      [entry('new.ts', 'R', '.', { origPath: 'old.ts' }), entry('c.ts', 'U', 'U', { kind: 'unmerged' })],
      NAMES,
    );
    expect(groups.map((g) => g.id)).toEqual([CONFLICTS_GROUP_ID, STAGED_GROUP_ID]);
    expect(groups[1]!.changes[0]).toMatchObject({ path: 'new.ts', origPath: 'old.ts', kind: 'renamed' });
    expect(groups[0]!.changes[0]).toMatchObject({ kind: 'conflicted', checked: false });
  });

  it('names its groups so the webview can tell the halves apart', () => {
    expect(stagingSideOf(STAGED_GROUP_ID)).toBe('staged');
    expect(stagingSideOf(UNSTAGED_GROUP_ID)).toBe('unstaged');
    expect(stagingSideOf(UNVERSIONED_GROUP_ID)).toBe('unversioned');
    expect(stagingSideOf('default')).toBeUndefined();
  });
});

describe('localDiffSides with a row\'s half', () => {
  const HEAD = { relPath: 'a.ts', ref: 'HEAD' };
  it('opens a Staged row as HEAD against the index, even when the file has unstaged changes too', () => {
    expect(localDiffSides('a.ts', entry('a.ts', 'M', 'M'), 'staging', 'staged')).toEqual({
      left: HEAD,
      right: 'index',
      titleKind: 'index',
    });
  });

  it('opens an Unstaged row as the index against the file', () => {
    expect(localDiffSides('a.ts', entry('a.ts', 'M', 'M'), 'staging', 'unstaged')).toEqual({
      left: { relPath: 'a.ts', ref: ':0' },
      right: 'worktree',
      titleKind: 'working-tree',
    });
  });

  it('ignores a half with changelists', () => {
    expect(localDiffSides('a.ts', entry('a.ts', 'M', 'M'), 'changelists', 'staged').right).toBe('worktree');
  });
});

describe('stageFiles / unstageFiles against real git', () => {
  const git = new GitExecutorImpl({ gitPath: 'git', version: '2.43.0' });
  const repos: FixtureRepo[] = [];
  afterEach(() => {
    for (const r of repos.splice(0)) r.dispose();
  });
  const status = (r: FixtureRepo): string[] =>
    r
      .git('status', '--porcelain')
      .split('\n')
      .filter((l) => l.length > 0)
      .sort();

  it('stages a modification, a deletion and a new file, and unstages them again', async () => {
    const r = FixtureRepo.create({ prefix: 'gittree-stagefiles-' });
    repos.push(r);
    r.commit('base', { 'm.txt': 'm\n', 'd.txt': 'd\n' });
    fs.writeFileSync(path.join(r.root, 'm.txt'), 'm2\n');
    fs.rmSync(path.join(r.root, 'd.txt'));
    fs.writeFileSync(path.join(r.root, 'n.txt'), 'n\n');
    await stageFiles(git, r.root, ['m.txt', 'd.txt', 'n.txt']);
    expect(status(r)).toEqual(['A  n.txt', 'D  d.txt', 'M  m.txt']);
    await unstageFiles(git, r.root, ['m.txt', 'd.txt', 'n.txt']);
    expect(status(r)).toEqual([' D d.txt', ' M m.txt', '?? n.txt']);
  });

  it('unstages before the first commit, where there is no HEAD', async () => {
    const r = FixtureRepo.create({ prefix: 'gittree-stagefiles-unborn-' });
    repos.push(r);
    fs.writeFileSync(path.join(r.root, 'a.txt'), 'a\n');
    await stageFiles(git, r.root, ['a.txt']);
    expect(status(r)).toEqual(['A  a.txt']);
    await unstageFiles(git, r.root, ['a.txt']);
    expect(status(r)).toEqual(['?? a.txt']);
  });
});
