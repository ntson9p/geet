/**
 * POST-P14ck against real git: every command Geet hands ticked or picked
 * paths to, with `[id].tsx` beside a changed `i.tsx` and `d.tsx` — the names
 * git also matches `[id].tsx` to when it reads it as a pattern. Each case runs
 * the argv Geet builds, through Geet's own builders where it has them,
 * and checks that git touched `[id].tsx` alone. Before the fix every one of
 * them also took the other two: committed them, rolled their changes back,
 * deleted them from disk, resolved their conflicts.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildCommitArgs } from '../../../../src/commit/commitArgs';
import { commitSelection } from '../../../../src/commit/selectionCommit';
import { stageFiles, unstageFiles } from '../../../../src/commit/staging/stageFiles';
import { GitExecutorImpl } from '../../../../src/core/git/executor';
import { literalPathspec, literalPathspecs } from '../../../../src/core/git/pathspec';
import { OperationQueue } from '../../../../src/core/ops/operationQueue';
import { buildLogArgs } from '../../../../src/log/logFilter';
import { planRollback, rollbackCommands } from '../../../../src/scm/dialogs/rollbackPlan';
import { buildStashPushArgs, EMPTY_STASH_PUSH_OPTIONS } from '../../../../src/scm/dialogs/stashArgs';
import { buildDetachArgs, buildReattachArgs } from '../../../../src/scm/dialogs/updateArgs';
import { ShelfStore } from '../../../../src/shelf/shelfStore';
import { FixtureRepo } from '../../../fixtures/fixtureRepo';

/** Real git, several calls a case: generous, as the other real-git suites are. */
const SLOW = 60_000;

const git = new GitExecutorImpl({ gitPath: 'git', version: '2.43.0' });
const plain = { amend: false, sign: false };

const repos: FixtureRepo[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const r of repos.splice(0)) r.dispose();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true, maxRetries: 3 });
});

function bare(): FixtureRepo {
  const repo = FixtureRepo.create({ prefix: 'geet-literal-' });
  repos.push(repo);
  return repo;
}

/** `[id].tsx`, `i.tsx` and `d.tsx` committed, then all three changed. */
function decoys(): FixtureRepo {
  const repo = bare();
  repo.commit('base', { '[id].tsx': 'one\n', 'i.tsx': 'one\n', 'd.tsx': 'one\n' });
  repo.writeFiles({ '[id].tsx': 'one\ntwo\n', 'i.tsx': 'one\ntwo\n', 'd.tsx': 'one\ntwo\n' });
  return repo;
}

const lines = (s: string): string[] =>
  s
    .split(/\0|\n/u)
    .filter((l) => l.length > 0)
    .sort();
/** Changed in the working tree, against the index. */
const changed = (r: FixtureRepo): string[] => lines(r.git('diff', '--name-only'));
const staged = (r: FixtureRepo): string[] => lines(r.git('diff', '--cached', '--name-only'));
const committed = (r: FixtureRepo): string[] => lines(r.git('show', '--name-only', '--format=', 'HEAD'));
const tracked = (r: FixtureRepo): string[] => lines(r.git('ls-files'));
const untracked = (r: FixtureRepo): string[] => lines(r.git('ls-files', '--others', '--exclude-standard'));
const read = (r: FixtureRepo, rel: string): string => fs.readFileSync(path.join(r.root, rel), 'utf8');
const exists = (r: FixtureRepo, rel: string): boolean => fs.existsSync(path.join(r.root, rel));

describe('the changelist commit (commit --only)', () => {
  it('commits a ticked [id].tsx alone', { timeout: SLOW }, async () => {
    const r = decoys();
    await git.exec(r.root, buildCommitArgs('only', 'ticked', plain, ['[id].tsx']));
    expect(committed(r)).toEqual(['[id].tsx']);
    expect(changed(r)).toEqual(['d.tsx', 'i.tsx']);
  });

  it('commits a ticked deletion alone', { timeout: SLOW }, async () => {
    const r = decoys();
    fs.rmSync(path.join(r.root, '[id].tsx'));
    fs.rmSync(path.join(r.root, 'i.tsx'));
    await git.exec(r.root, buildCommitArgs('only', 'gone', plain, ['[id].tsx']));
    expect(committed(r)).toEqual(['[id].tsx']);
    expect(lines(r.git('ls-files', '--deleted'))).toEqual(['i.tsx']);
  });

  it('commits a new [new].tsx alone, through its intent-to-add', { timeout: SLOW }, async () => {
    const r = decoys();
    r.writeFiles({ '[new].tsx': 'n\n', 'n.tsx': 'n\n' });
    // CommitService's own two steps for a new file.
    await git.exec(r.root, ['add', '-N', '--', ...literalPathspecs(['[new].tsx'])]);
    await git.exec(r.root, buildCommitArgs('only', 'new', plain, ['[new].tsx']));
    expect(committed(r)).toEqual(['[new].tsx']);
    expect(untracked(r)).toEqual(['n.tsx']);
  });

  it('makes a Fixup commit of a ticked [id].tsx alone', { timeout: SLOW }, async () => {
    const r = decoys();
    await git.exec(r.root, ['commit', '--fixup=HEAD', '--only', '--', ...literalPathspecs(['[id].tsx'])]);
    expect(committed(r)).toEqual(['[id].tsx']);
    expect(r.git('log', '-1', '--format=%s').trim()).toBe('fixup! base');
  });

  it('commits a selection through the scratch index, and leaves a staged i.tsx staged', { timeout: SLOW }, async () => {
    const r = decoys();
    r.git('add', 'i.tsx');
    await commitSelection(git, r.root, r.gitDir, ['[id].tsx'], [], 'ticked', plain);
    expect(committed(r)).toEqual(['[id].tsx']);
    expect(staged(r)).toEqual(['i.tsx']);
    expect(changed(r)).toEqual(['d.tsx']);
  });
});

describe('Stage, Unstage and Add to VCS', () => {
  it('stages and unstages [id].tsx alone', { timeout: SLOW }, async () => {
    const r = decoys();
    await stageFiles(git, r.root, ['[id].tsx']);
    expect(staged(r)).toEqual(['[id].tsx']);
    r.git('add', '-A');
    await unstageFiles(git, r.root, ['[id].tsx']);
    expect(staged(r)).toEqual(['d.tsx', 'i.tsx']);
  });

  it('unstages [id].tsx alone before the first commit', { timeout: SLOW }, async () => {
    const r = bare();
    r.writeFiles({ '[id].tsx': 'one\n', 'i.tsx': 'one\n' });
    r.git('add', '-A');
    await unstageFiles(git, r.root, ['[id].tsx']);
    expect(tracked(r)).toEqual(['i.tsx']);
  });

  it("unstages [id].tsx alone from a row's menu (restore --staged)", { timeout: SLOW }, async () => {
    const r = decoys();
    r.git('add', '-A');
    await git.exec(r.root, ['restore', '--staged', '--', ...literalPathspecs(['[id].tsx'])]);
    expect(staged(r)).toEqual(['d.tsx', 'i.tsx']);
  });

  it('adds [n].txt alone to VCS', { timeout: SLOW }, async () => {
    const r = decoys();
    r.writeFiles({ '[n].txt': 'n\n', 'n.txt': 'n\n' });
    await git.exec(r.root, ['add', '-N', '--', ...literalPathspecs(['[n].txt'])]);
    expect(tracked(r)).toEqual(['[id].tsx', '[n].txt', 'd.tsx', 'i.tsx']);
  });
});

describe('Rollback and deleting new files', () => {
  it("rolls back [id].tsx alone — i.tsx's and d.tsx's changes stay", { timeout: SLOW }, async () => {
    const r = decoys();
    for (const args of rollbackCommands(planRollback([{ path: '[id].tsx', kind: 'restore' }], true))) {
      await git.exec(r.root, args);
    }
    expect(changed(r)).toEqual(['d.tsx', 'i.tsx']);
    expect(read(r, '[id].tsx')).toBe('one\n');
  });

  it('unstages an added [n].txt alone', { timeout: SLOW }, async () => {
    const r = decoys();
    r.writeFiles({ '[n].txt': 'n\n', 'n.txt': 'n\n' });
    r.git('add', '[n].txt', 'n.txt');
    for (const args of rollbackCommands(planRollback([{ path: '[n].txt', kind: 'added' }], false))) {
      await git.exec(r.root, args);
    }
    expect(staged(r)).toEqual(['n.txt']);
  });

  it("brings a deleted [id].tsx back alone from a row's menu", { timeout: SLOW }, async () => {
    const r = decoys();
    fs.rmSync(path.join(r.root, '[id].tsx'));
    fs.rmSync(path.join(r.root, 'i.tsx'));
    await git.exec(r.root, [
      'restore',
      '--source=HEAD',
      '--worktree',
      '--staged',
      '--',
      ...literalPathspecs(['[id].tsx']),
    ]);
    expect(exists(r, '[id].tsx')).toBe(true);
    expect(exists(r, 'i.tsx')).toBe(false);
  });

  it('cleans an untracked [x].txt and leaves an untracked x.txt on disk', { timeout: SLOW }, async () => {
    const r = decoys();
    r.writeFiles({ '[x].txt': 'u\n', 'x.txt': 'u\n' });
    await git.exec(r.root, ['clean', '-f', '-q', '--', ...literalPathspecs(['[x].txt'])]);
    expect(exists(r, '[x].txt')).toBe(false);
    expect(exists(r, 'x.txt')).toBe(true);
  });
});

describe('Stash and Update Project', () => {
  it('stashes [id].tsx alone', { timeout: SLOW }, async () => {
    const r = decoys();
    await git.exec(
      r.root,
      buildStashPushArgs({ ...EMPTY_STASH_PUSH_OPTIONS, includeUntracked: false, message: 'one', paths: ['[id].tsx'] }),
    );
    expect(lines(r.git('stash', 'show', '--name-only', 'stash@{0}'))).toEqual(['[id].tsx']);
    expect(changed(r)).toEqual(['d.tsx', 'i.tsx']);
  });

  it('stashes an untracked [u].txt alone, leaving u.txt on disk', { timeout: SLOW }, async () => {
    const r = decoys();
    r.writeFiles({ '[u].txt': 'u\n', 'u.txt': 'u\n' });
    await git.exec(r.root, buildStashPushArgs({ ...EMPTY_STASH_PUSH_OPTIONS, paths: ['[u].txt'] }));
    expect(exists(r, '[u].txt')).toBe(false);
    expect(exists(r, 'u.txt')).toBe(true);
  });

  it('sets a new [n].txt aside and back alone', { timeout: SLOW }, async () => {
    const r = decoys();
    r.writeFiles({ '[n].txt': 'n\n', 'n.txt': 'n\n' });
    r.git('add', '-N', '[n].txt', 'n.txt');
    await git.exec(r.root, buildDetachArgs(['[n].txt']));
    expect(tracked(r)).toEqual(['[id].tsx', 'd.tsx', 'i.tsx', 'n.txt']);
    await git.exec(r.root, buildReattachArgs(['[n].txt']));
    expect(tracked(r)).toEqual(['[id].tsx', '[n].txt', 'd.tsx', 'i.tsx', 'n.txt']);
  });
});

describe('a conflict', () => {
  it('accepts theirs for [id].tsx alone — i.tsx stays in conflict', { timeout: SLOW }, async () => {
    const r = bare();
    r.commit('base', { '[id].tsx': 'a\n', 'i.tsx': 'a\n' });
    r.branch('other', { checkout: true });
    r.commit('theirs', { '[id].tsx': 'theirs\n', 'i.tsx': 'theirs\n' });
    r.checkout(r.defaultBranch);
    r.commit('ours', { '[id].tsx': 'ours\n', 'i.tsx': 'ours\n' });
    expect(r.merge('other')).toBe(false);
    // ConflictSession.acceptSide's two steps.
    await git.exec(r.root, ['checkout', '--theirs', '--', ...literalPathspecs(['[id].tsx'])]);
    await git.exec(r.root, ['add', '--', ...literalPathspecs(['[id].tsx'])]);
    expect(lines(r.git('diff', '--name-only', '--diff-filter=U'))).toEqual(['i.tsx']);
    expect(read(r, '[id].tsx')).toBe('theirs\n');
  });

  it('keeps the deletion of [id].tsx alone: i.tsx and d.tsx stay on disk', { timeout: SLOW }, async () => {
    const r = bare();
    r.commit('base', { '[id].tsx': 'a\n', 'i.tsx': 'a\n', 'd.tsx': 'a\n' });
    await git.exec(r.root, ['rm', '--', literalPathspec('[id].tsx')]);
    expect(exists(r, '[id].tsx')).toBe(false);
    expect(exists(r, 'i.tsx')).toBe(true);
    expect(exists(r, 'd.tsx')).toBe(true);
  });
});

describe('the log', () => {
  function history(): FixtureRepo {
    const r = bare();
    r.commit('base', { '[id].tsx': 'a\n', 'i.tsx': 'a\n', 'd.tsx': 'a\n' });
    r.commit('i only', { 'i.tsx': 'b\n' });
    r.commit('id only', { '[id].tsx': 'b\n' });
    return r;
  }
  const page = { skip: 0, maxCount: 100 };

  it("shows [id].tsx's own history, as File History opens it", { timeout: SLOW }, async () => {
    const r = history();
    const out = await git.exec(
      r.root,
      buildLogArgs({ sort: 'topo', refs: 'HEAD', paths: [literalPathspec('[id].tsx')], follow: true }, '%s', page),
    );
    expect(out.stdout.trim().split('\n')).toEqual(['id only', 'base']);
  });

  it('keeps a typed pattern a pattern: [id].tsx typed matches i.tsx too', { timeout: SLOW }, async () => {
    const r = history();
    const out = await git.exec(r.root, buildLogArgs({ sort: 'topo', refs: 'HEAD', paths: ['[id].tsx'] }, '%s', page));
    expect(out.stdout.trim().split('\n')).toEqual(['id only', 'i only', 'base']);
  });

  it('compares two versions over a picked [id].tsx alone', { timeout: SLOW }, async () => {
    const r = history();
    const out = await git.exec(r.root, [
      'diff',
      '--name-status',
      '-z',
      '-M',
      'HEAD~2',
      'HEAD',
      '--',
      literalPathspec('[id].tsx'),
    ]);
    expect(out.stdout.split('\0').filter((s) => s.length > 0)).toEqual(['M', '[id].tsx']);
  });
});

describe('reading trees and files', () => {
  it("lists a revision's app/[locale]/ folder by its name", { timeout: SLOW }, async () => {
    const r = bare();
    r.commit('base', { 'app/[locale]/page.tsx': 'p\n', 'app/l': 'tracked\n' });
    const out = await git.exec(r.root, ['ls-tree', '-z', '--long', 'HEAD', '--', literalPathspec('app/[locale]/')]);
    expect(
      out.stdout
        .split('\0')
        .filter((s) => s.length > 0)
        .map((l) => l.split('\t')[1]),
    ).toEqual(['app/[locale]/page.tsx']);
  });

  it('finds nothing tracked in a new folder app/[x] beside a tracked app/x', { timeout: SLOW }, async () => {
    const r = bare();
    r.commit('base', { 'app/x': 'tracked\n' });
    r.writeFiles({ 'app/[x]/new.txt': 'u\n' });
    // Add to .gitignore's question before it writes one rule for the folder.
    const literal = await git.exec(r.root, ['ls-files', '-z', '--', literalPathspec('app/[x]')]);
    expect(literal.stdout).toBe('');
    const pattern = await git.exec(r.root, ['ls-files', '-z', '--', 'app/[x]']);
    expect(pattern.stdout.split('\0').filter((s) => s.length > 0)).toEqual(['app/x']);
  });

  it('blames [id].tsx by its plain name, which blame takes literally — and would not with the prefix', { timeout: SLOW }, async () => {
    const r = bare();
    r.commit('base', { '[id].tsx': 'a\n', 'i.tsx': 'a\n' });
    const named = await git.exec(r.root, ['blame', '--incremental', '--', '[id].tsx'], { allowNonZeroExit: true });
    expect(named.exitCode).toBe(0);
    expect(named.stdout.split('\n').filter((l) => l.startsWith('filename '))).toEqual(['filename [id].tsx']);
    const prefixed = await git.exec(r.root, ['blame', '--incremental', '--', literalPathspec('[id].tsx')], {
      allowNonZeroExit: true,
    });
    expect(prefixed.exitCode).not.toBe(0);
    expect(prefixed.stderr).toMatch(/no such path/u);
  });
});

describe('the environment and hooks', () => {
  it('takes the prefix off when GIT_LITERAL_PATHSPECS reads everything literally already', { timeout: SLOW }, async () => {
    const r = decoys();
    const runs: (readonly string[])[] = [];
    const traced = new GitExecutorImpl({ gitPath: 'git', version: '2.43.0', onDidRun: (run) => runs.push(run.argv) });
    await traced.exec(r.root, buildCommitArgs('only', 'env', plain, ['[id].tsx']), {
      env: { GIT_LITERAL_PATHSPECS: '1' },
    });
    expect(committed(r)).toEqual(['[id].tsx']);
    // The Console shows what ran.
    expect(runs[0]).toEqual(['commit', '-m', 'env', '--only', '--', '[id].tsx']);
    // Why: with the variable on, git reads the prefix as part of the name.
    const kept = spawnSync('git', ['commit', '-m', 'x', '--only', '--', ':(literal)[id].tsx'], {
      cwd: r.root,
      env: { ...process.env, GIT_LITERAL_PATHSPECS: '1' },
      encoding: 'utf8',
    });
    expect(kept.status).not.toBe(0);
    expect(kept.stderr).toMatch(/did not match any file/u);
  });

  it("leaves a pre-commit hook's own patterns alone: no GIT_LITERAL_PATHSPECS reaches it", { timeout: SLOW }, async () => {
    const r = decoys();
    fs.mkdirSync(path.join(r.gitDir, 'hooks'), { recursive: true });
    fs.writeFileSync(
      path.join(r.gitDir, 'hooks', 'pre-commit'),
      [
        '#!/bin/sh',
        `printf '%s' "\${GIT_LITERAL_PATHSPECS-unset}" > .git/hook-env`,
        `git diff --cached --name-only -- '*.tsx' > .git/hook-files`,
        '',
      ].join('\n'),
      { mode: 0o755 },
    );
    await git.exec(r.root, buildCommitArgs('only', 'hooked', plain, ['[id].tsx']));
    expect(read(r, '.git/hook-env')).toBe('unset');
    expect(lines(read(r, '.git/hook-files'))).toEqual(['[id].tsx']);
  });
});

describe('the shelf', () => {
  function store(r: FixtureRepo): ShelfStore {
    const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'geet-shelf-literal-'));
    dirs.push(storeDir);
    return new ShelfStore({
      storeDir,
      repoRoot: r.root,
      queue: new OperationQueue(r.root, git, { lockRetryBaseMs: 5 }),
    });
  }

  it('shelves [id].tsx alone and takes only its changes away', { timeout: SLOW }, async () => {
    const r = decoys();
    const result = await store(r).shelve({ name: 'one', paths: ['[id].tsx'], removeFromWorktree: true });
    expect(result.meta.files.map((f) => f.relPath)).toEqual(['[id].tsx']);
    expect(result.removed).toBe(true);
    expect(changed(r)).toEqual(['d.tsx', 'i.tsx']);
    expect(read(r, '[id].tsx')).toBe('one\n');
  });

  it('shelves a selected [id].tsx alone', { timeout: SLOW }, async () => {
    const r = decoys();
    const result = await store(r).shelveSelected({
      name: 'whole',
      wholePaths: ['[id].tsx'],
      partials: [],
      removeFromWorktree: true,
    });
    expect(result.meta.files.map((f) => f.relPath)).toEqual(['[id].tsx']);
    expect(result.removed).toBe(true);
    expect(changed(r)).toEqual(['d.tsx', 'i.tsx']);
  });
});
