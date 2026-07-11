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

  /** Immediate refresh (activation, manual refresh command). */
  refreshNow(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    return this.runRefresh();
  }

  private async runRefresh(): Promise<void> {
    if (this.disposed) return;
    if (this.refreshRunning) {
      // Coalesce: one more pass after the current one, however many pokes.
      this.refreshQueuedAgain = true;
      return;
    }
    this.refreshRunning = true;
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
      if (this.refreshQueuedAgain && !this.disposed) {
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

    const statusResult = await git.exec(
      repo,
      ['status', '--porcelain=v2', '-z', '--branch', '--untracked-files=all'],
      { structured: true, noOptionalLocks: true },
    );
    if (token.isCancellationRequested) return undefined;

    const refsResult = await git.exec(
      repo,
      ['for-each-ref', `--format=${FOR_EACH_REF_FORMAT}`, ...FOR_EACH_REF_PATTERNS],
      { structured: true, noOptionalLocks: true },
    );
    if (token.isCancellationRequested) return undefined;

    const stashResult = await git.exec(repo, ['stash', 'list', `--format=${STASH_LIST_FORMAT}`], {
      structured: true,
      noOptionalLocks: true,
      allowNonZeroExit: true, // empty/odd stash states must not fail the refresh
    });
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
  }
}
