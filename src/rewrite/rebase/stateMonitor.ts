/**
 * Rebase state monitor (P5-T1 step 5): turns model transitions into rebase
 * lifecycle events — progress (k/n), pause-on-conflict (with the stopped sha
 * and conflicted paths; P6 consumes this, T1 ships an interim toast), and
 * end-of-rebase. Reads `.git/rebase-merge/stopped-sha` directly; everything
 * else comes from the RepositoryModel, never from git invocations.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { RepoHandle } from '../../core/core';
import { Emitter, type Event } from '../../core/util/events';

export interface RebasePausedEvent {
  repo: RepoHandle;
  step?: number;
  total?: number;
  /**
   * Sha of the commit git stopped at (`.git/rebase-merge/stopped-sha`).
   * Git writes a unique *abbreviation*, not the full oid — prefix-match or
   * rev-parse before comparing.
   */
  stoppedSha?: string;
  /** Repo-relative unmerged paths at the time of the pause. */
  conflictedPaths: string[];
}

export interface RebaseProgressEvent {
  repo: RepoHandle;
  step?: number;
  total?: number;
}

export class RebaseStateMonitor {
  private readonly _onDidPause = new Emitter<RebasePausedEvent>();
  readonly onDidPause: Event<RebasePausedEvent> = this._onDidPause.event;
  private readonly _onDidChangeProgress = new Emitter<RebaseProgressEvent>();
  readonly onDidChangeProgress: Event<RebaseProgressEvent> = this._onDidChangeProgress.event;
  private readonly _onDidEnd = new Emitter<void>();
  readonly onDidEnd: Event<void> = this._onDidEnd.event;

  private wasRebasing = false;
  private lastProgressKey = '';
  private lastPauseKey = '';
  private readonly sub: { dispose(): void };

  constructor(private readonly repo: RepoHandle) {
    this.sub = repo.model.onDidChange((sections) => {
      if (sections.has('op') || sections.has('status')) this.evaluate();
    });
    this.evaluate();
  }

  get isRebasing(): boolean {
    const kind = this.repo.model.snapshot.inProgressOp?.kind;
    return kind === 'rebase-interactive' || kind === 'rebase-apply';
  }

  private evaluate(): void {
    const snap = this.repo.model.snapshot;
    const rebasing = this.isRebasing;

    if (!rebasing) {
      if (this.wasRebasing) {
        this.wasRebasing = false;
        this.lastProgressKey = '';
        this.lastPauseKey = '';
        this._onDidEnd.fire();
      }
      return;
    }
    this.wasRebasing = true;

    const op = snap.inProgressOp;
    const progressKey = `${op?.step ?? ''}/${op?.total ?? ''}`;
    if (progressKey !== this.lastProgressKey) {
      this.lastProgressKey = progressKey;
      const evt: RebaseProgressEvent = { repo: this.repo };
      if (op?.step !== undefined) evt.step = op.step;
      if (op?.total !== undefined) evt.total = op.total;
      this._onDidChangeProgress.fire(evt);
    }

    const conflicted = snap.statusEntries.filter((e) => e.kind === 'unmerged').map((e) => e.path);
    if (conflicted.length === 0) return;
    const stoppedSha = this.readStoppedSha();
    const pauseKey = stoppedSha ?? `step:${op?.step ?? '?'}`;
    if (pauseKey === this.lastPauseKey) return;
    this.lastPauseKey = pauseKey;
    const evt: RebasePausedEvent = { repo: this.repo, conflictedPaths: conflicted };
    if (op?.step !== undefined) evt.step = op.step;
    if (op?.total !== undefined) evt.total = op.total;
    if (stoppedSha !== undefined) evt.stoppedSha = stoppedSha;
    this._onDidPause.fire(evt);
  }

  private readStoppedSha(): string | undefined {
    try {
      const text = fs
        .readFileSync(path.join(this.repo.dirs.gitDir, 'rebase-merge', 'stopped-sha'), 'utf8')
        .trim();
      return text.length > 0 ? text : undefined;
    } catch {
      return undefined;
    }
  }

  dispose(): void {
    this.sub.dispose();
    this._onDidPause.dispose();
    this._onDidChangeProgress.dispose();
    this._onDidEnd.dispose();
  }
}
