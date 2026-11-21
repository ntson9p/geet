/**
 * Local History hooks (P9-T2): the safety net that makes history rewriting
 * shippable. Subscribes to OperationQueue.onWillRunDestructive and snapshots
 * the dirty worktree BEFORE the mutation runs (the queue's waitUntil blocks
 * until the snapshot lands); worktree-mutating ops get a paired "After: …"
 * snapshot on success. Task-end labels and optional save snapshots are wired
 * by the phase registration (vscode side) through the same class.
 *
 * vscode-free: model/queue/store are injected; register.ts adds the vscode
 * event sources.
 */
import type { RepositoryModel } from '../core/model/repositoryModel';
import { isDirty } from '../core/model/statusEntry';
import type { FinishedMutationEvent, OperationQueue } from '../core/ops/operationQueue';
import type { Disposable } from '../core/util/events';
import * as path from 'node:path';
import type { SnapshotStore } from './snapshotStore';

/**
 * Canonical snapshot labels for every destructive operation (master §10
 * coverage matrix). Later phases MUST use these when declaring
 * isDestructive ops so the table-driven tests stay binding.
 */
export const SNAPSHOT_LABELS = {
  checkoutDirty: 'Before: checkout (dirty worktree)',
  forceCheckout: 'Before: force checkout',
  reset: 'Before: reset',
  rebaseStart: 'Before: rebase',
  rebaseContinue: 'Before: rebase continue',
  rebaseSkip: 'Before: rebase skip',
  rebaseAbort: 'Before: rebase abort',
  merge: 'Before: merge',
  cherryPick: 'Before: cherry-pick',
  revert: 'Before: revert',
  stashPop: 'Before: stash pop',
  stashApply: 'Before: stash apply',
  stashDrop: 'Before: stash drop',
  stashClear: 'Before: stash clear',
  unshelve: 'Before: unshelve',
  unshelveWithRemove: 'Before: unshelve (remove)',
  shelveWithRemove: 'Before: shelve (remove)',
  rollback: 'Before: rollback',
  cleanUntracked: 'Before: clean untracked',
  branchForceDelete: 'Before: branch force-delete',
  smartCheckoutStash: 'Before: smart checkout (stash)',
} as const;

export type SnapshotLabelKey = keyof typeof SNAPSHOT_LABELS;

export interface LocalHistoryHooksDeps {
  repoRoot: string;
  model: RepositoryModel;
  queue: OperationQueue;
  store: SnapshotStore;
  /** Kill switch: geet.localHistory.enabled. */
  isEnabled: () => boolean;
  /** geet.localHistory.taskLabels (default on). */
  taskLabelsEnabled?: () => boolean;
  /** Called once when a snapshot write fails (warn, never block). */
  onStoreFailure?: (error: unknown) => void;
  /** Called when a snapshot covers a very large file set (progress UX). */
  onLargeSnapshot?: (fileCount: number) => void;
  trace?: (line: string) => void;
}

export const LARGE_SNAPSHOT_THRESHOLD = 2000;

export class LocalHistoryHooks implements Disposable {
  private readonly subs: Disposable[] = [];
  private warnedFailure = false;
  private readonly trace: (line: string) => void;

  constructor(private readonly deps: LocalHistoryHooksDeps) {
    this.trace = deps.trace ?? (() => undefined);

    this.subs.push(
      deps.queue.onWillRunDestructive((e) => {
        if (!deps.isEnabled()) return;
        const label = e.snapshotLabel ?? `Before: ${e.label}`;
        e.waitUntil(this.takeSnapshot(label, e.extraPaths));
      }),
    );

    this.subs.push(
      deps.queue.onDidFinishMutation((e) => {
        if (!deps.isEnabled()) return;
        if (!this.shouldSnapshotAfter(e)) return;
        // Post-op: fire-and-forget; the op already succeeded.
        void this.takeSnapshot(afterLabel(e)).catch(() => undefined);
      }),
    );
  }

  private shouldSnapshotAfter(e: FinishedMutationEvent): boolean {
    return e.isDestructive && e.snapshotAfter && e.succeeded;
  }

  /** Dirty worktree files (status entries minus ignored) ∪ extra paths. */
  collectFiles(extraPaths?: readonly string[]): string[] {
    const files = new Set<string>();
    for (const entry of this.deps.model.snapshot.statusEntries) {
      if (!isDirty(entry)) continue;
      files.add(path.join(this.deps.repoRoot, entry.path));
      if (entry.origPath !== undefined) files.add(path.join(this.deps.repoRoot, entry.origPath));
    }
    for (const p of extraPaths ?? []) files.add(p);
    return [...files];
  }

  private async takeSnapshot(label: string, extraPaths?: readonly string[]): Promise<void> {
    try {
      const files = this.collectFiles(extraPaths);
      if (files.length === 0) {
        this.trace(`local history: nothing dirty for "${label}"`);
        return;
      }
      if (files.length > LARGE_SNAPSHOT_THRESHOLD) {
        this.deps.onLargeSnapshot?.(files.length);
      }
      // Missing means deleted here: the files are the dirty set, and a
      // deletion is work an operation can undo as surely as an edit.
      await this.deps.store.snapshot(label, 'operation', files, { recordMissing: true });
    } catch (err) {
      // Never block the git operation on a broken store — warn once.
      this.trace(`local history snapshot failed: ${String(err)}`);
      if (!this.warnedFailure) {
        this.warnedFailure = true;
        this.deps.onStoreFailure?.(err);
      }
    }
  }

  /** Task-end label snapshots (wired to tasks.onDidEndTaskProcess by register.ts). */
  async onTaskEnded(taskName: string, isTestOrBuild: boolean): Promise<void> {
    if (!this.deps.isEnabled()) return;
    if (!(this.deps.taskLabelsEnabled?.() ?? true)) return;
    if (!isTestOrBuild) return;
    try {
      await this.deps.store.snapshot(`After task: ${taskName}`, 'task', this.collectFiles(), {
        recordMissing: true,
      });
    } catch (err) {
      this.trace(`task snapshot failed: ${String(err)}`);
    }
  }

  /** Debounced save snapshots (wired by register.ts; default-off setting). */
  async onFileSaved(absPath: string): Promise<void> {
    if (!this.deps.isEnabled()) return;
    try {
      await this.deps.store.snapshot(`Save: ${path.basename(absPath)}`, 'save', [absPath]);
    } catch (err) {
      this.trace(`save snapshot failed: ${String(err)}`);
    }
  }

  dispose(): void {
    for (const s of this.subs) s.dispose();
    this.subs.length = 0;
  }
}

function afterLabel(e: FinishedMutationEvent): string {
  const base = e.snapshotLabel ?? `Before: ${e.label}`;
  return base.startsWith('Before: ') ? `After: ${base.slice('Before: '.length)}` : `After: ${e.label}`;
}
