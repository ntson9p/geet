import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createGitExecutor, type GitExecutorImpl } from '../../../src/core/git/executor';
import { RepositoryModel } from '../../../src/core/model/repositoryModel';
import { OperationQueue } from '../../../src/core/ops/operationQueue';
import type { RepoHandle } from '../../../src/core/core';
import { LogService, PAGE_SIZE } from '../../../src/log/logService';
import { branchy, FixtureRepo } from '../../fixtures/fixtureRepo';

const cleanups: Array<() => void> = [];
afterAll(() => {
  while (cleanups.length) cleanups.pop()?.();
});

async function handleFor(repo: FixtureRepo): Promise<RepoHandle> {
  const git = await createGitExecutor({});
  if (!git) throw new Error('git missing');
  const model = new RepositoryModel(repo.root);
  const queue = new OperationQueue(repo.root, git);
  cleanups.push(() => {
    queue.dispose();
    model.dispose();
    repo.dispose();
  });
  // LogService only touches root/model/queue — structural RepoHandle.
  return { id: repo.root, root: repo.root, model, queue } as RepoHandle;
}

describe('LogService (real git)', () => {
  it('pages branchy(2k): correct row count, parents, and warm-cache < 150 ms', async () => {
    const fixture = branchy(2600); // > one page so page 1 is non-empty
    const handle = await handleFor(fixture);
    const service = new LogService(handle);

    const chunks: number[] = [];
    const page0 = await service.getPage({ sort: 'topo', refs: 'ALL' }, 0, (rows) =>
      chunks.push(rows.length),
    );
    expect(page0.rows.length).toBe(PAGE_SIZE);
    expect(page0.eof).toBe(false);
    expect(chunks.reduce((a, b) => a + b, 0)).toBe(PAGE_SIZE);
    // Merge commits carry two parents.
    expect(page0.rows.some((r) => r.parents.length === 2)).toBe(true);

    const t0 = Date.now();
    const cached = await service.getPage({ sort: 'topo', refs: 'ALL' }, 0);
    const warmMs = Date.now() - t0;
    expect(cached.rows.length).toBe(PAGE_SIZE);
    expect(warmMs).toBeLessThan(150);

    const page1 = await service.getPage({ sort: 'topo', refs: 'ALL' }, 1);
    expect(page1.rows.length).toBeGreaterThan(0);
    expect(page1.rows[0]!.sha).not.toBe(page0.rows[0]!.sha);
  }, 120_000);

  it('range mode marks sides', async () => {
    const fixture = FixtureRepo.create();
    const handle = await handleFor(fixture);
    fixture.commit('base', { 'f.txt': 'base\n' });
    fixture.branch('side', { checkout: true });
    fixture.commit('on side', { 's.txt': 's\n' });
    fixture.checkout('main');
    fixture.commit('on main', { 'm.txt': 'm\n' });

    const service = new LogService(handle);
    const page = await service.getPage({ sort: 'topo', range: { a: 'side', b: 'main' } }, 0);
    const sides = new Map(page.rows.map((r) => [r.subject, r.side]));
    expect(sides.get('on side')).toBe('left');
    expect(sides.get('on main')).toBe('right');
  }, 60_000);

  // POST-P14bh: Paths ▾ · Roots keeps the Branch selection, so a branch picked
  // in one repository reaches another that may not have it.
  it('leaves out a branch the repository lacks, and reads nothing when it has none', async () => {
    const fixture = FixtureRepo.create();
    const handle = await handleFor(fixture);
    fixture.commit('base', { 'f.txt': 'base\n' });
    fixture.branch('side', { checkout: true });
    fixture.commit('on side', { 's.txt': 's\n' });
    fixture.checkout('main');
    fixture.commit('on main', { 'm.txt': 'm\n' });
    const service = new LogService(handle);

    // git alone would refuse this log outright: "unknown revision".
    const mixed = await service.getPage({ sort: 'topo', refs: ['side', 'elsewhere'] }, 0);
    expect(mixed.missingRefs).toEqual(['elsewhere']);
    expect(mixed.rows.map((r) => r.subject)).toEqual(['on side', 'base']);

    // Nothing the repository has: an empty, finished log — never HEAD's history.
    const none = await service.getPage({ sort: 'topo', refs: ['elsewhere', 'gone/too'] }, 0);
    expect(none.rows).toEqual([]);
    expect(none.eof).toBe(true);
    expect(none.missingRefs).toEqual(['elsewhere', 'gone/too']);

    // A comparison with a missing end has nothing to compare.
    const range = await service.getPage({ sort: 'topo', range: { a: 'side', b: 'elsewhere' } }, 0);
    expect(range.rows).toEqual([]);
    expect(range.missingRefs).toEqual(['elsewhere']);
  }, 60_000);

  it('still reads hashes, ancestry and typed ranges, which are no branch names', async () => {
    const fixture = FixtureRepo.create();
    const handle = await handleFor(fixture);
    fixture.commit('first', { 'f.txt': '1\n' });
    fixture.branch('side');
    fixture.commit('second', { 'f.txt': '2\n' });
    fixture.commit('third', { 'f.txt': '3\n' });
    const service = new LogService(handle);

    const revs = await service.getPage({ sort: 'topo', refs: [fixture.head().slice(0, 9), 'HEAD~1'] }, 0);
    expect(revs.missingRefs).toBeUndefined();
    expect(revs.rows.map((r) => r.subject)).toEqual(['third', 'second', 'first']);

    // "side..main" is a set of commits, handed to git unchecked.
    const typed = await service.getPage({ sort: 'topo', refs: ['side..main'] }, 0);
    expect(typed.missingRefs).toBeUndefined();
    expect(typed.rows.map((r) => r.subject)).toEqual(['third', 'second']);
  }, 60_000);

  it('details of a rename commit expose the R pair', async () => {
    const fixture = FixtureRepo.create();
    const handle = await handleFor(fixture);
    fixture.commit('base', { 'old-name.txt': 'stable content for rename detection\n' });
    fixture.rename('old-name.txt', 'new-name.txt');
    const sha = fixture.head();

    const service = new LogService(handle);
    const details = await service.getCommitDetails(sha);
    expect(details).toBeDefined();
    expect(details!.files).toEqual([
      { status: 'R', path: 'new-name.txt', origPath: 'old-name.txt' },
    ]);
    expect(details!.body.length).toBeGreaterThan(0);
  }, 60_000);

  it('POST-P14x: getCommitMessage returns the whole body, trailing blanks trimmed', async () => {
    const fixture = FixtureRepo.create();
    const handle = await handleFor(fixture);
    // The hover card's whole reason to exist is the part of a message the
    // subject column cannot show.
    const message = 'subject line\n\nbody paragraph one\nbody paragraph two';
    const sha = fixture.commit(message, { 'a.txt': '1\n' });

    const service = new LogService(handle);
    // `%B` pads with the newlines its own format adds; unhandled, the card
    // would carry a blank line under every message it ever shows.
    expect(await service.getCommitMessage(sha)).toBe(message);
    expect(await service.getCommitMessage('not-a-sha')).toBeUndefined();
  }, 60_000);

  it('author autocomplete dedupes and caches by HEAD', async () => {
    const fixture = FixtureRepo.create();
    const handle = await handleFor(fixture);
    fixture.commit('one', { 'a.txt': '1\n' });
    fixture.commit('two', { 'a.txt': '2\n' });
    const service = new LogService(handle);
    const authors = await service.getAuthors();
    expect(authors).toHaveLength(1);
    expect(authors[0]).toContain('Fixture Author');
    // cached call returns the same array
    expect(await service.getAuthors()).toBe(authors);
  }, 60_000);
});

describe('LogService fixture sanity', () => {
  it('branchy fixture really is a merge-bearing history', () => {
    const fixture = branchy(300);
    cleanups.push(() => fixture.dispose());
    const merges = execFileSync('git', ['rev-list', '--count', '--merges', 'HEAD'], {
      cwd: fixture.root,
      encoding: 'utf8',
    });
    expect(Number.parseInt(merges, 10)).toBeGreaterThan(10);
    expect(fs.existsSync(path.join(fixture.root, 'main.txt'))).toBe(true);
  });
});

describe('LogService commit-graph maintenance', () => {
  const isGraphWrite = (args: readonly string[]): boolean => args[0] === 'commit-graph';

  async function setup(commitGraph = true) {
    const fixture = FixtureRepo.create();
    fixture.commit('one', { 'a.txt': '1\n' });
    fixture.commit('two', { 'a.txt': '2\n' });
    const inner = await createGitExecutor({});
    if (!inner) throw new Error('git missing');
    // What the maintenance itself runs, kept apart from the queue's reads.
    const calls: string[][] = [];
    const git: GitExecutorImpl = Object.create(inner) as GitExecutorImpl;
    git.exec = (r, args, o) => {
      calls.push(args);
      return inner.exec(r, args, o);
    };
    const model = new RepositoryModel(fixture.root);
    model.update({ capabilities: { ...inner.caps, commitGraph } });
    const queue = new OperationQueue(fixture.root, inner);
    const values = new Map<string, unknown>();
    const storage = {
      get: <T,>(key: string): T | undefined => values.get(key) as T | undefined,
      update: (key: string, value: unknown): void => {
        values.set(key, value);
      },
    };
    const handle = { id: fixture.root, root: fixture.root, model, queue } as RepoHandle;
    const service = new LogService(handle, storage);
    cleanups.push(() => {
      service.dispose();
      queue.dispose();
      model.dispose();
      fixture.dispose();
    });
    const writes = (): number => calls.filter(isGraphWrite).length;
    return { fixture, git, queue, service, values, writes, key: `gittree.commitGraph.${fixture.root}` };
  }

  it('waits out the opening, holds up no read, then writes the commit-graph', async () => {
    const { fixture, git, queue, service, values, writes, key } = await setup();
    let finished = false;
    const done = service.maybeMaintain(git, { delayMs: 2000, retryMs: 20 }).then(() => {
      finished = true;
    });

    // The first page is read at once: nothing on the mutation lane, nothing
    // cancelled, nothing written yet.
    const page = await service.getPage({ sort: 'topo', refs: 'HEAD' }, 0);
    expect(page.rows).toHaveLength(2);
    expect(queue.isMutationActive).toBe(false);
    expect(finished).toBe(false);
    expect(writes()).toBe(0);
    expect(values.has(key)).toBe(false);

    await done;
    expect(writes()).toBe(1);
    const info = path.join(fixture.gitDir, 'objects', 'info');
    expect(
      fs.existsSync(path.join(info, 'commit-graph')) || fs.existsSync(path.join(info, 'commit-graphs')),
    ).toBe(true);
    expect(values.get(key)).toEqual(expect.any(Number));
  }, 60_000);

  it('steps aside while a git operation runs', async () => {
    const { git, queue, service, writes } = await setup();
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const mutation = queue.enqueue({ label: 'held', kind: 'mutate', run: () => held });
    const done = service.maybeMaintain(git, { delayMs: 10, retryMs: 20 });

    await new Promise((r) => setTimeout(r, 250));
    expect(writes()).toBe(0);

    release();
    await mutation;
    await done;
    expect(writes()).toBe(1);
  }, 60_000);

  it('runs once at a time, and once a day', async () => {
    const { git, service, writes } = await setup();
    const first = service.maybeMaintain(git, { delayMs: 10 });
    expect(service.maybeMaintain(git, { delayMs: 10 })).toBe(first);
    await first;
    await service.maybeMaintain(git, { delayMs: 10 });
    expect(writes()).toBe(1);
  }, 60_000);

  it('a repository that goes away during the wait is not written to', async () => {
    const { git, service, values, writes, key } = await setup();
    const done = service.maybeMaintain(git, { delayMs: 60_000 });
    service.dispose();
    await done;
    expect(writes()).toBe(0);
    // The day's write is still owed: the next window does it.
    expect(values.has(key)).toBe(false);
  }, 60_000);

  it('does nothing where git cannot write a commit-graph', async () => {
    const { git, service, writes } = await setup(false);
    await service.maybeMaintain(git, { delayMs: 10 });
    expect(writes()).toBe(0);
  }, 60_000);
});
