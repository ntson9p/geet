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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'geet-refresh-'));
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

/** Polls until `ready()` or `ms` have passed; the test then asserts what it waited for. */
async function waitFor(ready: () => boolean, ms: number): Promise<void> {
  const until = Date.now() + ms;
  while (!ready() && Date.now() < until) await new Promise((r) => setTimeout(r, 10));
}

async function makeStack(
  debounceMs = 30,
  opts: { maxWaitMs?: number; suppressionGraceMs?: number } = {},
): Promise<{
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
  const queue = new OperationQueue(repo, counting, { suppressionGraceMs: opts.suppressionGraceMs ?? 150 });
  const refresher = new StatusRefresher({
    repo,
    gitDir: path.join(repo, '.git'),
    git: counting,
    model,
    queue,
    debounceMs,
    ...(opts.maxWaitMs !== undefined ? { maxWaitMs: opts.maxWaitMs } : {}),
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

  it('refreshNow during a running refresh waits for a pass that sees the change', async () => {
    const { repo, model, refresher, statusRuns } = await makeStack(10);
    // A refresh is already under way when the file appears…
    const first = refresher.refreshNow();
    fs.writeFileSync(path.join(repo, 'late.txt'), 'late\n');
    // …so the second caller must not be answered by it.
    await refresher.refreshNow();
    expect(model.snapshot.statusEntries.map((e) => e.path)).toContain('late.txt');
    expect(statusRuns()).toBeGreaterThanOrEqual(2);
    await first;
  });

  it('refreshNow resolves when the refresher is disposed', async () => {
    const { refresher } = await makeStack(10);
    void refresher.refreshNow();
    const waiting = refresher.refreshNow();
    refresher.dispose();
    await expect(waiting).resolves.toBeUndefined();
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

  it('a steady stream of events never holds a refresh off past maxWaitMs', async () => {
    const { repo, model, refresher } = await makeStack(50, { maxWaitMs: 300 });
    await refresher.refreshNow();
    const before = model.snapshot.headSha;
    // Something writes a file in the workspace every 20 ms (a dev server's
    // log, a test run): the debounce restarts on each one. It used to restart
    // for as long as the writing went on, so a commit made in a terminal
    // meanwhile reached neither the model nor the log.
    const noise = setInterval(() => refresher.poke('worktree'), 20);
    try {
      execFileSync('git', ['commit', '--allow-empty', '-m', 'from a terminal'], { cwd: repo });
      refresher.poke('gitdir');
      await waitFor(() => model.snapshot.headSha !== before, 2000);
      expect(model.snapshot.headSha).not.toBe(before);
    } finally {
      clearInterval(noise);
    }
  });

  it('a commit made from outside just after our own operation still reaches the model', async () => {
    // A long window, so a slow machine cannot step out of it before the commit.
    const { repo, queue, model, refresher, statusRuns } = await makeStack(20, { suppressionGraceMs: 5000 });
    await queue.enqueue({ label: 'our own operation', kind: 'mutate', run: () => Promise.resolve() });
    // The post-op refresh reads, and is done…
    await waitFor(() => statusRuns() >= 1, 2000);
    await new Promise((r) => setTimeout(r, 50));
    const before = model.snapshot.headSha;
    // …and then a commit lands from a terminal, inside the window in which the
    // queue calls every event ours. It used to be dropped as such, with no
    // refresh left to read it.
    execFileSync('git', ['commit', '--allow-empty', '-m', 'from a terminal'], { cwd: repo });
    expect(queue.isSelfInflicted(Date.now())).toBe(true);
    refresher.poke('gitdir');
    await waitFor(() => model.snapshot.headSha !== before, 2000);
    expect(model.snapshot.headSha).not.toBe(before);
  });

  it('our own late events still fold into the post-op refresh waiting for them', async () => {
    const { queue, refresher, statusRuns } = await makeStack(40, { suppressionGraceMs: 1000 });
    await queue.enqueue({ label: 'our own operation', kind: 'mutate', run: () => Promise.resolve() });
    // The post-op refresh is waiting out its debounce: the watchers' events
    // about what the operation did, arriving after it ended, add nothing.
    refresher.poke('worktree');
    refresher.poke('gitdir');
    refresher.poke('worktree');
    await new Promise((r) => setTimeout(r, 400));
    expect(statusRuns()).toBe(1);
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
