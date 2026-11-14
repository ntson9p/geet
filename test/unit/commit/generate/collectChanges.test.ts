/**
 * POST-P14cj, Generate Commit Message: what a commit would hold, read from
 * real git: the ticked files, a file committed in part, new files, the staging
 * area, and with Amend the last commit's own changes. Read-only throughout.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_DIFF_LIMITS } from '../../../../src/commit/generate/changeDiff';
import {
  CollectCancelled,
  collectChanges,
  MAX_NEW_FILE_BYTES,
  type CollectRequest,
} from '../../../../src/commit/generate/collectChanges';
import { changeLine } from '../../../../src/commit/generate/prompt';
import { GitExecutorImpl } from '../../../../src/core/git/executor';
import { computeLineChanges } from '../../../../src/core/patch/lineDiff';
import { buildPatch } from '../../../../src/core/patch/patchBuilder';
import { CancellationSource } from '../../../../src/core/util/cancellation';
import { FixtureRepo } from '../../../fixtures/fixtureRepo';

const git = new GitExecutorImpl({ gitPath: 'git', version: '2.43.0' });
/** Real git, several runs a test: well clear of the 5 s default on a busy machine. */
const SLOW = 60_000;

const repos: FixtureRepo[] = [];
afterEach(() => {
  for (const r of repos.splice(0)) r.dispose();
});

const A_BASE = 'one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\n';
const A_HEAD = `${A_BASE}nine\n`;
const A_WORK = 'one\nTWO\nthree\nfour\nfive\nsix\nSEVEN\neight\nnine\n';

/**
 * Two commits, then a working tree with a modified file, a deleted one, a
 * binary one, new ones, and a name git would read as a pattern: `[id].tsx`,
 * with a changed `i.tsx` beside it that the pattern matches and nobody ticked.
 */
function dirty(): FixtureRepo {
  const repo = FixtureRepo.create({ prefix: 'gittree-generate-' });
  repos.push(repo);
  repo.commit('base', {
    'a.txt': A_BASE,
    'gone.txt': 'bye\n',
    'old name.txt': 'same content here\nand here\nand more of it\n',
    '[id].tsx': 'export const id = 1;\n',
    'i.tsx': 'decoy\n',
    'bin.dat': 'a\0b',
    'untouched.txt': 'as it was\n',
  });
  repo.commit('second', { 'b.txt': 'b1\n', 'a.txt': A_HEAD });
  repo.writeFiles({
    'a.txt': A_WORK,
    'new file.txt': 'hello\nworld',
    '[id].tsx': 'export const id = 2;\n',
    'i.tsx': 'decoy, changed and not ticked\n',
    'bin.dat': 'a\0c',
    'empty.txt': '',
    'untouched.txt': 'changed, and not ticked\n',
  });
  fs.rmSync(path.join(repo.root, 'gone.txt'));
  return repo;
}

const lists = (over: Partial<CollectRequest>): CollectRequest => ({
  mode: 'changelists',
  amend: false,
  unborn: false,
  wholePaths: [],
  untrackedPaths: [],
  partials: [],
  ...over,
});
const staged = (over: Partial<CollectRequest> = {}): CollectRequest => ({
  mode: 'staged',
  amend: false,
  unborn: false,
  wholePaths: [],
  untrackedPaths: [],
  partials: [],
  ...over,
});

describe('collectChanges, with changelists', () => {
  it(
    'reads the ticked files and no others: modified, deleted, binary, new, and a name that looks like a pattern',
    async () => {
      const repo = dirty();
      const changes = await collectChanges(
        git,
        repo.root,
        lists({
          wholePaths: ['a.txt', 'gone.txt', 'new file.txt', '[id].tsx', 'bin.dat', 'empty.txt'],
          untrackedPaths: ['new file.txt', 'empty.txt'],
        }),
      );
      expect(changes.map(changeLine)).toEqual([
        'M [id].tsx (+1 -1)',
        'M a.txt (+2 -2)',
        'M bin.dat (binary or too large to show)',
        'D gone.txt (-1)',
        'A new file.txt (+2)',
        'A empty.txt',
      ]);
      // Git itself reads the name as a pattern, and finds i.tsx with it.
      expect(repo.git('diff', '--name-only', 'HEAD', '--', '[id].tsx').trim().split('\n')).toEqual(['[id].tsx', 'i.tsx']);
      const a = changes.find((c) => c.path === 'a.txt');
      expect(a?.diff).toContain('@@ -1,9 +1,9 @@\n one\n-two\n+TWO\n three');
      expect(changes.find((c) => c.path === 'new file.txt')?.diff).toContain(
        '--- /dev/null\n+++ b/new file.txt\n@@ -0,0 +1,2 @@\n+hello\n+world\n\\ No newline at end of file',
      );
    },
    SLOW,
  );

  it(
    'reads a file committed in part as the patch the commit applies, and marks it',
    async () => {
      const repo = dirty();
      const all = computeLineChanges(A_HEAD, A_WORK);
      expect(all).toHaveLength(2);
      const patch = buildPatch({ relPath: 'a.txt', originalText: A_HEAD, modifiedText: A_WORK, changes: [all[0]!] });
      const changes = await collectChanges(git, repo.root, lists({ wholePaths: ['gone.txt'], partials: [{ relPath: 'a.txt', patch }] }));
      expect(changes.map(changeLine)).toEqual(['D gone.txt (-1)', 'M a.txt (+1 -1; only part of its changes)']);
      const part = changes[1];
      expect(part?.diff).toContain('-two\n+TWO');
      expect(part?.diff).not.toContain('SEVEN');
      // The patch's own last line break is not one more line.
      expect(part?.diff.endsWith('\n')).toBe(false);
    },
    SLOW,
  );

  it(
    'with Amend, compares against the commit before, and adds what the last commit changed besides',
    async () => {
      const repo = dirty();
      const changes = await collectChanges(git, repo.root, lists({ amend: true, wholePaths: ['a.txt'] }));
      expect(changes.map(changeLine)).toEqual([
        // The last commit's `nine` and the working tree's two changes, together.
        'M a.txt (+3 -2)',
        'A b.txt (+1; already in the commit being amended)',
      ]);
      expect(changes[0]?.diff).toContain('@@ -1,8 +1,9 @@');
      expect(changes[0]?.diff).toContain(' eight\n+nine');
    },
    SLOW,
  );

  it(
    'with Amend and a file committed in part, shows the last commit’s change to that file as well',
    async () => {
      const repo = dirty();
      const all = computeLineChanges(A_HEAD, A_WORK);
      const patch = buildPatch({ relPath: 'a.txt', originalText: A_HEAD, modifiedText: A_WORK, changes: [all[0]!] });
      const changes = await collectChanges(git, repo.root, lists({ amend: true, partials: [{ relPath: 'a.txt', patch }] }));
      expect(changes.map(changeLine)).toEqual([
        'M a.txt (+1 -1; only part of its changes)',
        'M a.txt (+1; already in the commit being amended)',
        'A b.txt (+1; already in the commit being amended)',
      ]);
    },
    SLOW,
  );

  it(
    'names a new file too large to read, and leaves out one that is gone since it was ticked',
    async () => {
      const repo = dirty();
      fs.writeFileSync(path.join(repo.root, 'huge.txt'), 'x'.repeat(MAX_NEW_FILE_BYTES + 1));
      const changes = await collectChanges(
        git,
        repo.root,
        lists({ wholePaths: ['huge.txt', 'vanished.txt'], untrackedPaths: ['huge.txt', 'vanished.txt'] }),
      );
      expect(changes.map(changeLine)).toEqual(['A huge.txt (binary or too large to show)']);
    },
    SLOW,
  );

  it(
    'keeps each diff within the limits it is given',
    async () => {
      const repo = dirty();
      const changes = await collectChanges(git, repo.root, lists({ wholePaths: ['a.txt'] }), {
        ...DEFAULT_DIFF_LIMITS,
        maxFileLines: 6,
      });
      expect(changes[0]?.diff.split('\n')).toHaveLength(6);
      expect(changes[0]?.cutLines).toBe(10);
      // The counts are of the whole diff.
      expect(changes[0]).toMatchObject({ added: 2, deleted: 2 });
    },
    SLOW,
  );
});

describe('collectChanges, with the staging area', () => {
  it(
    'reads what is staged, a rename as a rename, and nothing that is not',
    async () => {
      const repo = dirty();
      repo.git('mv', 'old name.txt', 'new name.txt');
      // Literally: as a pattern, `git add` would stage i.tsx with it.
      repo.git('--literal-pathspecs', 'add', '[id].tsx');
      const changes = await collectChanges(git, repo.root, staged());
      expect(changes.map(changeLine)).toEqual(['M [id].tsx (+1 -1)', 'R old name.txt -> new name.txt']);
    },
    SLOW,
  );

  it(
    'with Amend, reads the last commit’s changes and the staged ones together; alone when nothing is staged',
    async () => {
      const repo = dirty();
      expect((await collectChanges(git, repo.root, staged({ amend: true }))).map(changeLine)).toEqual([
        'M a.txt (+1)',
        'A b.txt (+1)',
      ]);
      repo.git('--literal-pathspecs', 'add', '[id].tsx');
      expect((await collectChanges(git, repo.root, staged({ amend: true }))).map(changeLine)).toEqual([
        'M [id].tsx (+1 -1)',
        'M a.txt (+1)',
        'A b.txt (+1)',
      ]);
    },
    SLOW,
  );

  it(
    'reads nothing when nothing is staged',
    async () => {
      const repo = dirty();
      expect(await collectChanges(git, repo.root, staged())).toEqual([]);
    },
    SLOW,
  );
});

describe('collectChanges, at the edges of history', () => {
  it(
    'reads a repository with no commit yet: everything is new, and Amend means nothing',
    async () => {
      const repo = FixtureRepo.create({ prefix: 'gittree-generate-unborn-' });
      repos.push(repo);
      repo.writeFiles({ 'first.txt': 'first\n', 'second.txt': 'second\n' });
      repo.git('add', 'first.txt');
      expect((await collectChanges(git, repo.root, staged({ amend: true, unborn: true }))).map(changeLine)).toEqual([
        'A first.txt (+1)',
      ]);
      const ticked = lists({ unborn: true, wholePaths: ['first.txt', 'second.txt'], untrackedPaths: ['second.txt'] });
      expect((await collectChanges(git, repo.root, ticked)).map(changeLine)).toEqual([
        'A first.txt (+1)',
        'A second.txt (+1)',
      ]);
    },
    SLOW,
  );

  it(
    'amending the first commit compares against nothing',
    async () => {
      const repo = FixtureRepo.create({ prefix: 'gittree-generate-root-' });
      repos.push(repo);
      repo.commit('first', { 'first.txt': 'first\n' });
      expect((await collectChanges(git, repo.root, staged({ amend: true }))).map(changeLine)).toEqual([
        'A first.txt (+1)',
      ]);
    },
    SLOW,
  );
});

describe('collectChanges, as a read', () => {
  it(
    'changes nothing: the index, the working tree and the object store are as they were',
    async () => {
      const repo = dirty();
      const state = (): string =>
        [repo.git('status', '--porcelain'), repo.git('count-objects', '-v'), fs.readdirSync(repo.gitDir).sort().join(',')].join('\n--\n');
      const before = state();
      await collectChanges(
        git,
        repo.root,
        lists({ amend: true, wholePaths: ['a.txt', 'new file.txt', 'gone.txt'], untrackedPaths: ['new file.txt'] }),
      );
      await collectChanges(git, repo.root, staged({ amend: true }));
      expect(state()).toBe(before);
    },
    SLOW,
  );

  it(
    'throws when cancelled, so that a part is never taken for the whole',
    async () => {
      const repo = dirty();
      const source = new CancellationSource();
      source.cancel();
      // Whichever git run would have come first: none of them answers for it.
      for (const request of [
        lists({ wholePaths: ['a.txt'] }),
        lists({ amend: true, wholePaths: ['a.txt'] }),
        staged({ unborn: true }),
      ]) {
        await expect(collectChanges(git, repo.root, request, undefined, source.token)).rejects.toBeInstanceOf(
          CollectCancelled,
        );
      }
    },
    SLOW,
  );
});
