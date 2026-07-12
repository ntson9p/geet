import { afterAll, describe, expect, it } from 'vitest';
import { createGitExecutor } from '../../../src/core/git/executor';
import { RepositoryModel } from '../../../src/core/model/repositoryModel';
import { OperationQueue } from '../../../src/core/ops/operationQueue';
import type { RepoHandle } from '../../../src/core/core';
import { BlameService } from '../../../src/log/blame/blameService';
import { FixtureRepo } from '../../fixtures/fixtureRepo';
import * as path from 'node:path';

const cleanups: Array<() => void> = [];
afterAll(() => {
  while (cleanups.length) cleanups.pop()?.();
});

async function rig(): Promise<{ fixture: FixtureRepo; service: BlameService }> {
  const fixture = FixtureRepo.create();
  const git = await createGitExecutor({});
  if (!git) throw new Error('git missing');
  const model = new RepositoryModel(fixture.root);
  const queue = new OperationQueue(fixture.root, git);
  cleanups.push(() => {
    queue.dispose();
    model.dispose();
    fixture.dispose();
  });
  const handle = { id: fixture.root, root: fixture.root, model, queue } as RepoHandle;
  return { fixture, service: new BlameService(handle) };
}

describe('BlameService (real git)', () => {
  it('maps clean files to real shas with authors and summaries', async () => {
    const { fixture, service } = await rig();
    fixture.commit('first', { 'code.ts': 'line one\nline two\n' });
    const first = fixture.head();
    fixture.commit('second', { 'code.ts': 'line one\nline two CHANGED\nline three\n' });
    const second = fixture.head();

    const abs = path.join(fixture.root, 'code.ts');
    const content = 'line one\nline two CHANGED\nline three\n';
    const blame = await service.blameFile(abs, content, false, 1, 3);
    expect(blame).toBeDefined();
    expect(blame!.lines[0]!.sha).toBe(first);
    expect(blame!.lines[1]!.sha).toBe(second);
    expect(blame!.lines[2]!.sha).toBe(second);
    expect(blame!.lines[0]!.author).toBe('Fixture Author');
    expect(blame!.lines[0]!.summary).toBe('first');
    expect(blame!.lines.every((l) => !l.isUncommitted)).toBe(true);
  }, 60_000);

  it('dirty buffers blame edited lines as Uncommitted via --contents -', async () => {
    const { fixture, service } = await rig();
    fixture.commit('base', { 'doc.md': 'alpha\nbeta\ngamma\n' });
    const base = fixture.head();

    // Buffer edit: middle line changed + a new line appended — NOT saved.
    const dirty = 'alpha\nbeta EDITED\ngamma\nfresh line\n';
    const abs = path.join(fixture.root, 'doc.md');
    const blame = await service.blameFile(abs, dirty, true, 2, 4);
    expect(blame).toBeDefined();
    expect(blame!.lines[0]!.sha).toBe(base); // unchanged line keeps its commit
    expect(blame!.lines[1]!.isUncommitted).toBe(true);
    expect(blame!.lines[1]!.author).toBe('Uncommitted');
    expect(blame!.lines[2]!.sha).toBe(base);
    expect(blame!.lines[3]!.isUncommitted).toBe(true);
  }, 60_000);

  it('caches by (path, version) and answers getCommitForLine', async () => {
    const { fixture, service } = await rig();
    fixture.commit('only', { 'x.txt': 'a\nb\n' });
    const abs = path.join(fixture.root, 'x.txt');
    const first = await service.blameFile(abs, 'a\nb\n', false, 7, 2);
    const again = await service.blameFile(abs, 'a\nb\n', false, 7, 2);
    expect(again).toBe(first); // cache hit, same object
    expect(service.getCommitForLine(abs, 1)?.sha).toBe(fixture.head());
  }, 60_000);

  it('returns undefined for untracked files', async () => {
    const { fixture, service } = await rig();
    fixture.commit('seed', { 'seed.txt': 's\n' });
    fixture.writeFiles({ 'untracked.txt': 'nope\n' });
    const abs = path.join(fixture.root, 'untracked.txt');
    expect(await service.blameFile(abs, 'nope\n', false, 1, 1)).toBeUndefined();
  }, 60_000);
});
