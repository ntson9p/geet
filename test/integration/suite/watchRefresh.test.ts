import * as assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createGitExecutor } from '../../../src/core/git/executor';
import { RepositoryModel } from '../../../src/core/model/repositoryModel';
import { OperationQueue } from '../../../src/core/ops/operationQueue';
import { StatusRefresher } from '../../../src/core/ops/statusRefresher';
import { GitDirWatcher, resolveGitDir } from '../../../src/core/watch/gitDirWatcher';

/**
 * P0-T6 acceptance: external CLI changes reflected in the model < 500 ms
 * after the watcher event; no refresh storm during our own mutations.
 */
suite('P0-T6 watchers → refresher → model', () => {
  let repo: string;
  let model: RepositoryModel;
  let queue: OperationQueue;
  let refresher: StatusRefresher;
  let watcher: GitDirWatcher;
  let statusRuns = 0;

  const cli = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });

  suiteSetup(async function () {
    this.timeout(30_000);
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'geet-p0t6-'));
    cli('init');
    cli('config', 'user.email', 't@t.dev');
    cli('config', 'user.name', 'T');
    cli('config', 'commit.gpgsign', 'false');
    fs.writeFileSync(path.join(repo, 'a.txt'), '1\n');
    cli('add', '.');
    cli('commit', '-m', 'initial');

    const inner = await createGitExecutor({});
    assert.ok(inner, 'git not found');
    const counting = Object.create(inner) as typeof inner;
    counting.exec = (r, args, o) => {
      if (args[0] === 'status') statusRuns++;
      return inner.exec(r, args, o);
    };

    const dirs = resolveGitDir(repo);
    assert.ok(dirs, 'git dir not resolved');
    model = new RepositoryModel(repo);
    queue = new OperationQueue(repo, counting);
    refresher = new StatusRefresher({ repo, gitDir: dirs.gitDir, git: counting, model, queue });
    watcher = new GitDirWatcher(dirs);
    watcher.onDidChange((e) => refresher.poke('gitdir', e.ts));
    await refresher.refreshNow();
  });

  suiteTeardown(() => {
    watcher.dispose();
    refresher.dispose();
    queue.dispose();
    model.dispose();
    try {
      fs.rmSync(repo, { recursive: true, force: true, maxRetries: 5 });
    } catch {
      /* scratch */
    }
  });

  async function waitFor(cond: () => boolean, timeoutMs: number): Promise<number> {
    const start = Date.now();
    while (!cond()) {
      if (Date.now() - start > timeoutMs) {
        throw new Error(`condition not met within ${timeoutMs}ms`);
      }
      await new Promise((r) => setTimeout(r, 20));
    }
    return Date.now() - start;
  }

  test('external CLI commit is reflected in the model quickly', async function () {
    this.timeout(15_000);
    const oldSha = model.snapshot.headSha;
    fs.writeFileSync(path.join(repo, 'b.txt'), 'external\n');
    cli('add', '.');

    let eventTs = 0;
    const sub = model.onDidChange(() => {
      if (eventTs === 0) eventTs = Date.now();
    });
    const committedAt = Date.now();
    cli('commit', '-m', 'external commit');
    // <500ms budget from the CLI change to the model reflecting it
    // (200ms debounce + status run included).
    const elapsed = await waitFor(() => model.snapshot.headSha !== oldSha, 5000);
    sub.dispose();
    assert.ok(elapsed < 500, `model updated after ${elapsed}ms (budget 500)`);
    assert.ok(Date.now() - committedAt < 5000);
  });

  test('external branch creation via CLI is reflected', async function () {
    this.timeout(15_000);
    cli('checkout', '-b', 'feature/external');
    await waitFor(() => model.snapshot.headRef === 'feature/external', 5000);
    assert.ok(model.snapshot.refs.some((r) => r.name === 'feature/external'));
  });

  test('no refresh storm during our own commit (≤ 2 status runs)', async function () {
    this.timeout(15_000);
    // Settle any pending refreshes first.
    await new Promise((r) => setTimeout(r, 800));
    statusRuns = 0;
    await queue.enqueue({
      label: 'geet commit',
      kind: 'mutate',
      run: async (g) => {
        fs.writeFileSync(path.join(repo, 'c.txt'), 'ours\n');
        await g.exec(repo, ['add', '.']);
        await g.exec(repo, ['commit', '-m', 'our own commit']);
      },
    });
    // Give watcher events + post-op refresh time to flow.
    await new Promise((r) => setTimeout(r, 1500));
    assert.ok(statusRuns <= 2, `expected ≤2 status runs, saw ${statusRuns}`);
    assert.ok(statusRuns >= 1, 'expected at least the post-op refresh');
  });
});
