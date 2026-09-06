/**
 * OperationQueue (master §4/§8): per repo, one serialized mutation lane and a
 * bounded reader pool. Readers in flight are cancelled and requeued when a
 * mutation arrives. index.lock contention retries with exponential backoff.
 * Destructive mutations announce themselves first (P9 snapshots hook in via
 * onWillRunDestructive.waitUntil), and a suppression window around mutations
 * lets the watchers fold self-inflicted events into one post-op refresh.
 */
import type { CancelToken, GitExecutor, RepoId } from '../git/executor';
import { GitError, type GitErrorKind } from '../git/errors';
import { CancellationSource } from '../util/cancellation';
import { Emitter, type Event } from '../util/events';

export interface Operation<T> {
  label: string;
  kind: 'read' | 'mutate';
  isDestructive?: boolean;
  snapshotLabel?: string;
  /** Extra absolute paths the P9 snapshot must include (e.g. rollback targets). */
  snapshotPaths?: readonly string[];
  /** Take a paired "After: …" snapshot on success (worktree-mutating ops). */
  snapshotAfter?: boolean;
  /** P6-T7: runs even while the mutation lane is held (conflict-resolution
   *  ops — accept/stage/continue/abort — must not queue behind themselves). */
  bypassHold?: boolean;
  /**
   * Skip the progress adapter for this mutation. The caller owns the reporting
   * instead — a fan-out across N repositories wants one "Fetching 7
   * repositories…" notification, not N of them escalating separately, and
   * auto-fetch wants none at all. Everything else about the mutation is
   * unchanged: it still serializes, still fires onDidFinishMutation, and its
   * cancellation still runs off the queue's own token.
   */
  quietProgress?: boolean;
  run(git: GitExecutor, token: CancelToken): Promise<T>;
}

export interface DestructiveOpEvent {
  repo: RepoId;
  label: string;
  snapshotLabel?: string;
  extraPaths?: readonly string[];
  /** Delays the operation until the thenable settles (P9 snapshot hook). */
  waitUntil(t: Promise<unknown>): void;
}

export interface FinishedMutationEvent {
  label: string;
  isDestructive: boolean;
  snapshotLabel?: string;
  snapshotAfter: boolean;
  succeeded: boolean;
  /** Classified kind when the mutation failed with a GitError (P6-T7 routes
   *  'merge-conflict' into conflict-session creation). */
  errorKind?: GitErrorKind;
  /** P10-T4: wall time of the mutation (telemetry duration histograms). */
  durationMs?: number;
}

/** Injected by the bootstrap; wraps mutations in vscode progress UI. */
export type ProgressAdapter = <T>(
  op: { label: string; repo: RepoId },
  run: (token: CancelToken) => Promise<T>,
) => Promise<T>;

export interface OperationQueueOptions {
  /** Max concurrent readers (default 4). */
  readerConcurrency?: number;
  /** index.lock retry backoff base in ms (default 50; tests shrink it). */
  lockRetryBaseMs?: number;
  /** Max index.lock attempts (default 6 = 1 initial + 5 retries). */
  lockMaxAttempts?: number;
  /** Suppression grace after a mutation ends, ms (default 1000). */
  suppressionGraceMs?: number;
  progress?: ProgressAdapter;
  trace?: (line: string) => void;
}

interface Job<T> {
  op: Operation<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
  source: CancellationSource;
  /** Set when the queue cancelled a reader to make way for a mutation. */
  requeued: boolean;
}

const defaultProgress: ProgressAdapter = (_op, run) => run(new CancellationSource().token);

export class OperationQueue {
  private readonly readerConcurrency: number;
  private readonly lockRetryBaseMs: number;
  private readonly lockMaxAttempts: number;
  private readonly suppressionGraceMs: number;
  private readonly progress: ProgressAdapter;
  private readonly trace: (line: string) => void;

  private readonly mutationQueue: Job<unknown>[] = [];
  private readonly readerQueue: Job<unknown>[] = [];
  private readonly runningReaders = new Set<Job<unknown>>();
  private readonly holds = new Set<symbol>();
  private mutationRunning = false;
  private mutationSince: number | undefined;
  private lastMutationEnd = 0;
  private disposed = false;

  private readonly _onWillRunDestructive = new Emitter<DestructiveOpEvent>();
  readonly onWillRunDestructive: Event<DestructiveOpEvent> = this._onWillRunDestructive.event;

  /** Fires after each mutation settles — post-op refresh + P9 After-snapshots. */
  private readonly _onDidFinishMutation = new Emitter<FinishedMutationEvent>();
  readonly onDidFinishMutation: Event<FinishedMutationEvent> = this._onDidFinishMutation.event;

  constructor(
    readonly repo: RepoId,
    private readonly git: GitExecutor,
    options: OperationQueueOptions = {},
  ) {
    this.readerConcurrency = options.readerConcurrency ?? 4;
    this.lockRetryBaseMs = options.lockRetryBaseMs ?? 50;
    this.lockMaxAttempts = options.lockMaxAttempts ?? 6;
    this.suppressionGraceMs = options.suppressionGraceMs ?? 1000;
    this.progress = options.progress ?? defaultProgress;
    this.trace = options.trace ?? (() => undefined);
  }

  enqueue<T>(op: Operation<T>): Promise<T> {
    if (this.disposed) return Promise.reject(new Error('OperationQueue disposed'));
    return new Promise<T>((resolve, reject) => {
      const job: Job<T> = { op, resolve, reject, source: new CancellationSource(), requeued: false };
      if (op.kind === 'mutate') {
        this.mutationQueue.push(job as Job<unknown>);
        // Make way: cancel in-flight readers; they requeue at the front.
        for (const reader of this.runningReaders) {
          reader.requeued = true;
          reader.source.cancel();
        }
      } else {
        this.readerQueue.push(job as Job<unknown>);
      }
      this.pump();
    });
  }

  /** True while a mutation is executing. */
  get isMutationActive(): boolean {
    return this.mutationRunning;
  }

  /**
   * P6-T7: hold the mutation lane while a conflict pause is being resolved.
   * Non-bypass mutations queue behind the hold; readers keep flowing, and
   * resolution ops (`bypassHold`) run so the pause can actually end.
   */
  holdMutations(label: string): { dispose(): void } {
    const token = Symbol(label);
    this.holds.add(token);
    this.trace(`mutation lane held: ${label}`);
    return {
      dispose: (): void => {
        if (this.holds.delete(token)) {
          this.trace(`mutation lane released: ${label}`);
          this.pump();
        }
      },
    };
  }

  /**
   * Watcher suppression test (master §4): events timestamped inside a
   * mutation, or within the grace window after one, are self-inflicted.
   */
  isSelfInflicted(ts: number): boolean {
    if (this.mutationRunning && this.mutationSince !== undefined && ts >= this.mutationSince) {
      return true;
    }
    return ts <= this.lastMutationEnd + this.suppressionGraceMs && ts >= (this.mutationSince ?? 0);
  }

  private pump(): void {
    if (this.disposed) return;
    if (this.mutationRunning) return;

    // While the lane is held (P6-T7 conflict pause), only bypass-flagged
    // mutations are eligible; everything else waits, FIFO among eligible.
    const at =
      this.holds.size === 0
        ? this.mutationQueue.length > 0
          ? 0
          : -1
        : this.mutationQueue.findIndex((j) => j.op.bypassHold === true);
    if (at >= 0) {
      // Wait for the reader pool to drain (they were cancelled on enqueue).
      if (this.runningReaders.size > 0) return;
      const [mutation] = this.mutationQueue.splice(at, 1);
      this.mutationRunning = true;
      this.mutationSince = Date.now();
      void this.runMutation(mutation as Job<unknown>).finally(() => this.pump());
      return;
    }

    while (this.runningReaders.size < this.readerConcurrency && this.readerQueue.length > 0) {
      const job = this.readerQueue.shift() as Job<unknown>;
      // A fresh token per attempt: the previous one may be spent.
      if (job.source.isCancellationRequested) {
        job.source.dispose();
        job.source = new CancellationSource();
      }
      job.requeued = false;
      this.runningReaders.add(job);
      void this.runReader(job).finally(() => this.pump());
    }
  }

  /** State must be settled before the caller's promise resolves — callers may
   *  synchronously inspect isMutationActive/isSelfInflicted in their
   *  continuation. */
  private finishMutation(): void {
    this.mutationRunning = false;
    this.lastMutationEnd = Date.now();
  }

  private async runReader(job: Job<unknown>): Promise<void> {
    try {
      const result = await this.withLockRetry(job.op, job.source.token);
      this.runningReaders.delete(job);
      job.source.dispose();
      job.resolve(result);
    } catch (err) {
      this.runningReaders.delete(job);
      if (job.requeued) {
        // Cancelled by a mutation — reschedule at the front, keep the caller's
        // promise pending.
        this.trace(`read "${job.op.label}" requeued for mutation`);
        this.readerQueue.unshift(job);
        return;
      }
      job.source.dispose();
      job.reject(err);
    }
  }

  private async runMutation(job: Job<unknown>): Promise<void> {
    const startedAt = Date.now();
    try {
      if (job.op.isDestructive) {
        const waits: Promise<unknown>[] = [];
        const evt: DestructiveOpEvent = {
          repo: this.repo,
          label: job.op.label,
          waitUntil: (t) => waits.push(t),
        };
        if (job.op.snapshotLabel !== undefined) evt.snapshotLabel = job.op.snapshotLabel;
        if (job.op.snapshotPaths !== undefined) evt.extraPaths = job.op.snapshotPaths;
        this._onWillRunDestructive.fire(evt);
        // A failed snapshot hook must not block the user's operation — the
        // failure is logged; the op proceeds without its safety net.
        const results = await Promise.allSettled(waits);
        for (const r of results) {
          if (r.status === 'rejected') {
            this.trace(`onWillRunDestructive hook failed for "${job.op.label}": ${String(r.reason)}`);
          }
        }
      }
      const result =
        job.op.quietProgress === true
          ? await this.withLockRetry(job.op, job.source.token)
          : await this.progress({ label: job.op.label, repo: this.repo }, (progressToken) => {
              const sub = progressToken.onCancellationRequested(() => job.source.cancel());
              return this.withLockRetry(job.op, job.source.token).finally(() => sub.dispose());
            });
      this.finishMutation();
      job.source.dispose();
      job.resolve(result);
      this._onDidFinishMutation.fire(finishedEvent(job.op, true, Date.now() - startedAt));
    } catch (err) {
      this.finishMutation();
      job.source.dispose();
      job.reject(err);
      this._onDidFinishMutation.fire(
        finishedEvent(
          job.op,
          false,
          Date.now() - startedAt,
          err instanceof GitError ? err.kind : undefined,
        ),
      );
    }
  }

  private async withLockRetry(op: Operation<unknown>, token: CancelToken): Promise<unknown> {
    let attempt = 0;
    // 50 → 100 → 200 → 400 → 800 (+ jitter), then surface.
    for (;;) {
      try {
        return await op.run(this.git, token);
      } catch (err) {
        attempt++;
        const retryable =
          err instanceof GitError &&
          err.kind === 'index-lock' &&
          attempt < this.lockMaxAttempts &&
          !token.isCancellationRequested;
        if (!retryable) throw err;
        const delay =
          Math.min(this.lockRetryBaseMs * 2 ** (attempt - 1), this.lockRetryBaseMs * 16) +
          Math.random() * this.lockRetryBaseMs;
        this.trace(`index.lock busy for "${op.label}", retry ${attempt} in ${Math.round(delay)}ms`);
        await sleep(delay);
      }
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const job of [...this.mutationQueue, ...this.readerQueue]) {
      job.source.cancel();
      job.reject(new Error('OperationQueue disposed'));
    }
    this.mutationQueue.length = 0;
    this.readerQueue.length = 0;
    for (const job of this.runningReaders) {
      job.requeued = false; // make cancellation final, not a requeue
      job.source.cancel();
    }
    this._onWillRunDestructive.dispose();
    this._onDidFinishMutation.dispose();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function finishedEvent(
  op: Operation<unknown>,
  succeeded: boolean,
  durationMs?: number,
  errorKind?: GitErrorKind,
): FinishedMutationEvent {
  const evt: FinishedMutationEvent = {
    label: op.label,
    isDestructive: op.isDestructive === true,
    snapshotAfter: op.snapshotAfter === true,
    succeeded,
  };
  if (op.snapshotLabel !== undefined) evt.snapshotLabel = op.snapshotLabel;
  if (errorKind !== undefined) evt.errorKind = errorKind;
  if (durationMs !== undefined) evt.durationMs = durationMs;
  return evt;
}
