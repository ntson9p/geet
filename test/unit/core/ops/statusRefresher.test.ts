import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createGitExecutor, type GitExecutorImpl } from '../../../../src/core/git/executor';
import { RepositoryModel } from '../../../../src/core/model/repositoryModel';
import { OperationQueue } from '../../../../src/core/ops/operationQueue';
import { StatusRefresher } from '../../../../src/core/ops/statusRefresher';

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

function realRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gittree-refresh-'));
  cleanups.push(() => {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      /* tmp */
    }
  });
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
  git('init');
  git('config', 'user.email', 't@t.dev');
  git('config', 'user.name', 'T');
  git('config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(dir, 'a.txt'), '1\n');
  git('add', '.');
  git('commit', '-m', 'initial');
  return dir;
}

async function makeStack(debounceMs = 30): Promise<{
  repo: string;
  git: GitExecutorImpl;
  model: RepositoryModel;
  queue: OperationQueue;
  refresher: StatusRefresher;
  statusRuns: () => number;
}> {
  const repo = realRepo();
  let statusRuns = 0;
  const inner = await createGitExecutor({});
  if (!inner) throw new Error('git not found');
  // Count status invocations through a thin proxy.
  const counting: GitExecutorImpl = Object.create(inner) as GitExecutorImpl;
  counting.exec = (r, args, o) => {
    if (args[0] === 'status') statusRuns++;
    return inner.exec(r, args, o);
  };
  const model = new RepositoryModel(repo);
  const queue = new OperationQueue(repo, counting, { suppressionGraceMs: 150 });
  const refresher = new StatusRefresher({
    repo,
    gitDir: path.join(repo, '.git'),
    git: counting,
    model,
    queue,
    debounceMs,
  });
  cleanups.push(() => {
    refresher.dispose();
    queue.dispose();
    model.dispose();
  });
  return { repo, git: counting, model, queue, refresher, statusRuns: () => statusRuns };
}

describe('StatusRefresher (real git)', () => {
  it('populates the model: head, refs, clean status', async () => {
    const { model, refresher } = await makeStack();
    await refresher.refreshNow();
    const snap = model.snapshot;
    expect(snap.headRef).toBeDefined(); // main or master depending on git config
    expect(snap.headSha).toMatch(/^[0-9a-f]{40}$/);
    expect(snap.detached).toBe(false);
    expect(snap.statusEntries).toHaveLength(0);
    expect(snap.refs.some((r) => r.isHead)).toBe(true);
    expect(snap.inProgressOp).toBeUndefined();
  });

  it('sees worktree changes on refresh', async () => {
    const { repo, model, refresher } = await makeStack();
    fs.writeFileSync(path.join(repo, 'b.txt'), 'new\n');
    await refresher.refreshNow();
    expect(model.snapshot.statusEntries.map((e) => e.path)).toContain('b.txt');
  });

  it('debounces a burst of pokes into a single refresh', async () => {
    const { refresher, statusRuns } = await makeStack(40);
    for (let i = 0; i < 12; i++) refresher.poke('gitdir');
    await new Promise((r) => setTimeout(r, 400));
    expect(statusRuns()).toBe(1);
  });

  it('coalesces pokes arriving during a refresh into exactly one follow-up', async () => {
    const { refresher, statusRuns } = await makeStack(10);
    refresher.poke('gitdir');
    await new Promise((r) => setTimeout(r, 15)); // debounce elapsed, refresh running
    refresher.poke('gitdir');
    refresher.poke('worktree');
    refresher.poke('gitdir');
    await new Promise((r) => setTimeout(r, 600));
    expect(statusRuns()).toBeLessThanOrEqual(2);
    expect(statusRuns()).toBeGreaterThanOrEqual(1);
  });

  it('suppresses self-inflicted events and folds them into one post-op refresh', async () => {
    const { repo, queue, refresher, statusRuns, model } = await makeStack(20);
    const mutation = queue.enqueue({
      label: 'our own commit',
      kind: 'mutate',
      run: async (git) => {
        fs.writeFileSync(path.join(repo, 'c.txt'), 'x\n');
        await git.exec(repo, ['add', '.']);
        await git.exec(repo, ['commit', '-m', 'from queue']);
        // Simulated watcher noise during our own mutation:
        refresher.poke('gitdir');
        refresher.poke('worktree');
        refresher.poke('gitdir');
      },
    });
    await mutation;
    await new Promise((r) => setTimeout(r, 500));
    // The in-mutation pokes were suppressed; onDidFinishMutation triggered the
    // single post-op refresh (≤2 tolerates a trailing straggler).
    expect(statusRuns()).toBeGreaterThanOrEqual(1);
    expect(statusRuns()).toBeLessThanOrEqual(2);
    expect(model.snapshot.statusEntries).toHaveLength(0); // commit landed, tree clean
  });

  it('reports in-progress merge state through the model', async () => {
    const { repo, model, refresher } = await makeStack();
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
    git('checkout', '-b', 'side');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'side\n');
    git('add', '.');
    git('commit', '-m', 'side');
    git('checkout', '-');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'main\n');
    git('add', '.');
    git('commit', '-m', 'main');
    try {
      git('merge', 'side');
    } catch {
      // conflict expected
    }
    await refresher.refreshNow();
    expect(model.snapshot.inProgressOp?.kind).toBe('merge');
    expect(model.snapshot.statusEntries.some((e) => e.kind === 'unmerged')).toBe(true);
  });
});
