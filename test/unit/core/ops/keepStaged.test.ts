/**
 * POST-QA F3/F4: staged changes survive the operations that reset the index —
 * `rebase --autostash` and `reset --keep` — against real git.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GitExecutorImpl } from '../../../../src/core/git/executor';
import {
  parseDiffIndexRaw,
  readStaged,
  resetKeepStaged,
  restoreStaged,
} from '../../../../src/core/ops/keepStaged';
import { FixtureRepo } from '../../../fixtures/fixtureRepo';

const git = new GitExecutorImpl({ gitPath: 'git', version: '2.43.0' });

const repos: FixtureRepo[] = [];
afterEach(() => {
  for (const r of repos.splice(0)) r.dispose();
});

/** base: keep.txt, touched.txt, gone.txt; then "dropme" (touched.txt line 1) and "top" (top.txt). */
function history(): { repo: FixtureRepo; dropme: string } {
  const repo = FixtureRepo.create({ prefix: 'gittree-keepstaged-' });
  repos.push(repo);
  repo.commit('base', { 'keep.txt': 'k1\n', 'touched.txt': 'l1\nl2\nl3\n', 'gone.txt': 'g\n', 'both.txt': 'b1\n' });
  const dropme = repo.commit('dropme', { 'touched.txt': 'L1\nl2\nl3\n' });
  repo.commit('top', { 'top.txt': 'top\n' });
  return { repo, dropme };
}

/** Staged: keep.txt modified, new.txt added, gone.txt deleted, both.txt staged + more unstaged. */
function stageWork(repo: FixtureRepo): void {
  fs.writeFileSync(path.join(repo.root, 'keep.txt'), 'k2\n');
  fs.writeFileSync(path.join(repo.root, 'new.txt'), 'brand new\n');
  fs.writeFileSync(path.join(repo.root, 'both.txt'), 'b2\n');
  repo.git('add', 'keep.txt', 'new.txt', 'both.txt');
  repo.git('rm', '-q', 'gone.txt');
  fs.writeFileSync(path.join(repo.root, 'both.txt'), 'b3\n');
}

const status = (repo: FixtureRepo): string[] =>
  repo
    .git('status', '--porcelain')
    .split('\n')
    .filter((l) => l.length > 0)
    .sort();

describe('parseDiffIndexRaw', () => {
  it('reads modes, blob and path of every record', () => {
    const sha = 'a'.repeat(40);
    const zero = '0'.repeat(40);
    const raw = `:100644 100644 ${zero} ${sha} M\0src/a b.ts\0:000000 100755 ${zero} ${sha} A\0run.sh\0:100644 000000 ${sha} ${zero} D\0old.txt\0`;
    expect(parseDiffIndexRaw(raw)).toEqual([
      { path: 'src/a b.ts', headMode: '100644', indexMode: '100644', indexSha: sha },
      { path: 'run.sh', headMode: '000000', indexMode: '100755', indexSha: sha },
      { path: 'old.txt', headMode: '100644', indexMode: '000000', indexSha: zero },
    ]);
  });

  it('reads nothing from nothing', () => {
    expect(parseDiffIndexRaw('')).toEqual([]);
  });
});

describe('readStaged / restoreStaged around rebase --autostash', () => {
  it('a dropped commit leaves every staged change staged', async () => {
    const { repo, dropme } = history();
    stageWork(repo);
    const before = status(repo);
    expect(before).toEqual(['A  new.txt', 'D  gone.txt', 'M  keep.txt', 'MM both.txt']);

    const snapshot = await readStaged(git, repo.root);
    expect(snapshot?.entries.map((e) => e.path).sort()).toEqual(['both.txt', 'gone.txt', 'keep.txt', 'new.txt']);
    repo.git('rebase', '--autostash', '--onto', `${dropme}^`, dropme);
    // What git leaves: the content is back, the staging is not.
    expect(status(repo)).not.toEqual(before);

    const result = await restoreStaged(git, repo.root, snapshot!);
    expect(result.skipped).toEqual([]);
    expect(status(repo)).toEqual(before);
    expect(repo.git('show', ':both.txt')).toBe('b2\n');
    expect(fs.readFileSync(path.join(repo.root, 'both.txt'), 'utf8')).toBe('b3\n');
  });

  it('leaves a path the rewrite itself changed as the rewrite left it', async () => {
    const { repo, dropme } = history();
    // Staged on top of the commit about to be dropped, three lines away from
    // its change, so git's autostash merges cleanly.
    fs.writeFileSync(path.join(repo.root, 'touched.txt'), 'L1\nl2\nL3 staged\n');
    fs.writeFileSync(path.join(repo.root, 'keep.txt'), 'k2\n');
    repo.git('add', 'touched.txt', 'keep.txt');
    const snapshot = await readStaged(git, repo.root);
    // touched.txt's staged blob still holds the dropped commit's "L1":
    // restoring it would stage the drop straight back in.
    repo.git('rebase', '--autostash', '--onto', `${dropme}^`, dropme);
    const result = await restoreStaged(git, repo.root, snapshot!);
    expect(result.restored).toEqual(['keep.txt']);
    expect(result.skipped).toEqual(['touched.txt']);
    expect(repo.git('show', ':keep.txt')).toBe('k2\n');
    expect(repo.git('show', ':touched.txt')).toBe('l1\nl2\nl3\n');
    expect(fs.readFileSync(path.join(repo.root, 'touched.txt'), 'utf8')).toBe('l1\nl2\nL3 staged\n');
  });

  it('has nothing to keep when nothing is staged', async () => {
    const { repo } = history();
    fs.writeFileSync(path.join(repo.root, 'keep.txt'), 'unstaged only\n');
    expect(await readStaged(git, repo.root)).toBeUndefined();
  });
});

describe('resetKeepStaged — the undo of a history edit', () => {
  it('moves HEAD back and keeps staged and unstaged changes', async () => {
    const { repo } = history();
    const before = repo.head();
    repo.git('commit', '-q', '--amend', '-m', 'top, reworded');
    const reworded = repo.head();
    expect(reworded).not.toBe(before);
    stageWork(repo);
    const expected = status(repo);

    const result = await resetKeepStaged(git, repo.root, before);
    expect(repo.head()).toBe(before);
    expect(result.skipped).toEqual([]);
    expect(status(repo)).toEqual(expected);
  });

  it('refuses, changing nothing, when a file the undo must change has local changes', async () => {
    const { repo, dropme } = history();
    const before = repo.head();
    repo.git('rebase', '--onto', `${dropme}^`, dropme);
    const after = repo.head();
    // touched.txt differs between the two heads and is edited locally.
    fs.writeFileSync(path.join(repo.root, 'touched.txt'), 'local edit\n');
    fs.writeFileSync(path.join(repo.root, 'keep.txt'), 'k2\n');
    repo.git('add', 'keep.txt');
    const expected = status(repo);

    await expect(resetKeepStaged(git, repo.root, before)).rejects.toThrow();
    expect(repo.head()).toBe(after);
    expect(status(repo)).toEqual(expected);
    expect(fs.readFileSync(path.join(repo.root, 'touched.txt'), 'utf8')).toBe('local edit\n');
  });
});
