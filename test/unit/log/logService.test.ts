import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createGitExecutor } from '../../../src/core/git/executor';
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
