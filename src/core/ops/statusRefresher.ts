/**
 * StatusRefresher (master §4): the single funnel from watcher events to model
 * updates. Debounces 200 ms, coalesces bursts into one refresh, skips
 * self-inflicted events during our own mutations (they fold into the single
 * post-op refresh triggered by onDidFinishMutation), and never runs git
 * outside the OperationQueue reader lane.
 */
import type { GitExecutor, RepoId } from '../git/executor';
import { parseStatusV2 } from '../git/parsers/statusV2';
import { FOR_EACH_REF_FORMAT, FOR_EACH_REF_PATTERNS, parseForEachRef } from '../git/parsers/refs';
import { parseStashList, STASH_LIST_FORMAT } from '../git/parsers/stashList';
import { detectInProgressOp } from '../model/inProgressOp';
import type { RepositoryModel, RepoSnapshot } from '../model/repositoryModel';
import type { Disposable } from '../util/events';
import type { OperationQueue } from './operationQueue';

export interface StatusRefresherDeps {
  repo: RepoId;
  /** Worktree-private git dir (for in-progress op detection). */
  gitDir: string;
  git: GitExecutor;
  model: RepositoryModel;
  queue: OperationQueue;
  debounceMs?: number;
  trace?: (line: string) => void;
}

export type PokeSource = 'gitdir' | 'worktree' | 'manual' | 'post-op';

export class StatusRefresher implements Disposable {
  private readonly debounceMs: number;
  private readonly trace: (line: string) => void;
  private timer: NodeJS.Timeout | undefined;
  private refreshRunning = false;
  private refreshQueuedAgain = false;
  /**
   * `refreshNow` callers waiting for a pass that started after they asked.
   * Taken by the next pass to start, resolved when it ends.
   */
  private nextPassWaiters: Array<() => void> = [];
  private disposed = false;
  private readonly mutationSub: Disposable;
  /** Total refreshes executed (observability + tests). */
  refreshCount = 0;

  constructor(private readonly deps: StatusRefresherDeps) {
    this.debounceMs = deps.debounceMs ?? 200;
    this.trace = deps.trace ?? (() => undefined);
    // The single post-op refresh that self-inflicted events folded into.
    this.mutationSub = deps.queue.onDidFinishMutation(() => this.poke('post-op'));
  }

  /** Watchers call this on every raw event; refreshes are debounced+coalesced. */
  poke(source: PokeSource, ts: number = Date.now()): void {
    if (this.disposed) return;
    if (source !== 'post-op' && source !== 'manual' && this.deps.queue.isSelfInflicted(ts)) {
      this.trace(`suppressed self-inflicted ${source} event`);
      return;
    }
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.runRefresh();
    }, this.debounceMs);
    this.timer.unref?.();
  }

  /**
   * Immediate refresh (activation, manual refresh command). Resolves once a
   * read that **started after this call** has updated the model. With a pass
   * already running it used to resolve at once — the caller then read the
   * snapshot that pass was taking from before its own change: a Refresh that
   * left a stale count, an operation reporting from the old state.
   */
  refreshNow(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (this.disposed) return Promise.resolve();
    const done = new Promise<void>((resolve) => this.nextPassWaiters.push(resolve));
    void this.runRefresh();
    return done;
  }

  private async runRefresh(): Promise<void> {
    if (this.disposed) return;
    if (this.refreshRunning) {
      // Coalesce: one more pass after the current one, however many pokes.
      this.refreshQueuedAgain = true;
      return;
    }
    this.refreshRunning = true;
    // Everyone who asked before this pass began is answered by it.
    const waiters = this.nextPassWaiters;
    this.nextPassWaiters = [];
    try {
      const partial = await this.deps.queue.enqueue({
        label: 'status refresh',
        kind: 'read',
        run: async (git, token) => this.readRepoState(git, token),
      });
      if (partial) {
        this.refreshCount++;
        this.deps.model.update(partial);
      }
    } catch (err) {
      this.trace(`status refresh failed: ${String(err)}`);
    } finally {
      this.refreshRunning = false;
      for (const resolve of waiters) resolve();
      if ((this.refreshQueuedAgain || this.nextPassWaiters.length > 0) && !this.disposed) {
        this.refreshQueuedAgain = false;
        void this.runRefresh();
      }
    }
  }

  private async readRepoState(
    git: GitExecutor,
    token: { isCancellationRequested: boolean },
  ): Promise<Partial<RepoSnapshot> | undefined> {
    const { repo, gitDir } = this.deps;

    // Three independent read-only spawns — run concurrently so the refresh
    // latency is the slowest of them, not their sum (P0-T6's <500ms budget).
    const [statusResult, refsResult, stashResult] = await Promise.all([
      git.exec(repo, ['status', '--porcelain=v2', '-z', '--branch', '--untracked-files=all'], {
        structured: true,
        noOptionalLocks: true,
      }),
      git.exec(repo, ['for-each-ref', `--format=${FOR_EACH_REF_FORMAT}`, ...FOR_EACH_REF_PATTERNS], {
        structured: true,
        noOptionalLocks: true,
      }),
      git.exec(repo, ['stash', 'list', `--format=${STASH_LIST_FORMAT}`], {
        structured: true,
        noOptionalLocks: true,
        allowNonZeroExit: true, // empty/odd stash states must not fail the refresh
      }),
    ]);
    if (token.isCancellationRequested) return undefined;

    const { header, entries } = parseStatusV2(statusResult.stdout);
    const refs = parseForEachRef(refsResult.stdout);
    const stashes = stashResult.exitCode === 0 ? parseStashList(stashResult.stdout) : [];
    const op = detectInProgressOp(gitDir);

    const partial: Partial<RepoSnapshot> = {
      detached: header.detached,
      initial: header.initial,
      upstreamGone: header.upstreamGone,
      refs,
      statusEntries: entries,
      stashes,
      headRef: header.head,
      headSha: header.oid,
      upstream: header.upstream,
      ahead: header.ahead,
      behind: header.behind,
      inProgressOp: op,
    };
    return partial;
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.mutationSub.dispose();
    // Nobody waits forever on a repository that has gone.
    for (const resolve of this.nextPassWaiters) resolve();
    this.nextPassWaiters = [];
  }
}
