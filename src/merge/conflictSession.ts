/**
 * Conflict session model (P6-T1): one per repo while unmerged paths exist.
 * Classifies porcelain-v2 unmerged entries, tracks the resolved set, and
 * owns the accept-side / continue / abort plumbing. The view (conflictsView)
 * and the tri-editor (T3) render it; T7 routes producer operations into it.
 */
import * as vscode from 'vscode';
import { filesCount } from '../ui/counts';
import { notifySuccess } from '../ui/notify';
import type { RepoHandle } from '../core/core';
import { GitError } from '../core/git/errors';
import { literalPathspec, literalPathspecs } from '../core/git/pathspec';
import { isRebasing } from '../core/model/inProgressOp';
import {
  classifyConflict,
  gitSideFlag,
  userConflictKind,
  type ConflictFile,
  type ConflictSource,
} from './conflictKinds';

export {
  classifyConflict,
  gitSideFlag,
  isSpecialConflict,
  userConflictKind,
  type ConflictFile,
  type ConflictKind,
  type ConflictSource,
} from './conflictKinds';
import { Emitter, type Event } from '../core/util/events';
import { SNAPSHOT_LABELS } from '../localHistory/hooks';
import { showInfo } from '../ui/notices';

export class ConflictSession {
  private readonly _onDidChange = new Emitter<void>();
  readonly onDidChange: Event<void> = this._onDidChange.event;
  private readonly _onDidResolveAll = new Emitter<void>();
  readonly onDidResolveAll: Event<void> = this._onDidResolveAll.event;
  /** Paths seen unmerged in this session that have since left that state. */
  readonly resolved = new Set<string>();
  /** Ended: a notification's button from back then has nothing left to act on. */
  ended = false;
  /** T6: native merge UI was requested but unavailable — the tri-editor
   *  served instead. Surfaced in the trace log only, never in UI. */
  usedTriEditorFallback = false;
  private readonly seen = new Set<string>();
  private readonly sub: { dispose(): void };
  private lastRemaining = -1;

  constructor(
    readonly repo: RepoHandle,
    readonly source: ConflictSource,
  ) {
    for (const f of this.files()) this.seen.add(f.path);
    this.lastRemaining = this.seen.size;
    this.sub = repo.model.onDidChange((sections) => {
      if (!sections.has('status')) return;
      this.reconcile();
    });
  }

  /**
   * Yours and Theirs follow the user (POST-QA F7): mid-rebase they are git's
   * stages 3 and 2, the other way round from a merge, cherry-pick or unstash.
   * Read from the git dir each time — a session outlives the step it began in.
   */
  get reversed(): boolean {
    return isRebasing(this.repo.dirs.gitDir);
  }

  /** Live unmerged files with classification, from the user's side. */
  files(): ConflictFile[] {
    const reversed = this.reversed;
    return this.repo.model.snapshot.statusEntries
      .filter((e) => e.kind === 'unmerged')
      .map((e) => ({ path: e.path, kind: userConflictKind(classifyConflict(e), reversed) }));
  }

  get remaining(): number {
    return this.files().length;
  }

  get canContinue(): boolean {
    return this.remaining === 0;
  }

  private reconcile(): void {
    const current = new Set(this.files().map((f) => f.path));
    for (const p of current) this.seen.add(p);
    for (const p of this.seen) {
      if (!current.has(p)) this.resolved.add(p);
      else this.resolved.delete(p);
    }
    const remaining = current.size;
    if (remaining !== this.lastRemaining) {
      this.lastRemaining = remaining;
      this._onDidChange.fire();
      if (remaining === 0) this._onDidResolveAll.fire();
    }
  }

  /**
   * Accept one side wholesale for text conflicts:
   * `git checkout --ours|--theirs -- <p>` + `git add`.
   */
  async acceptSide(paths: readonly string[], side: 'ours' | 'theirs'): Promise<void> {
    if (paths.length === 0) return;
    await this.repo.queue.enqueue({
      label:
        side === 'ours'
          ? vscode.l10n.t('Accept yours ({0})', filesCount(paths.length))
          : vscode.l10n.t('Accept theirs ({0})', filesCount(paths.length)),
      kind: 'mutate',
      bypassHold: true,
      isDestructive: true,
      snapshotLabel: SNAPSHOT_LABELS.rollback,
      snapshotPaths: paths.map((p) => vscode.Uri.joinPath(vscode.Uri.file(this.repo.root), p).fsPath),
      run: async (git, token) => {
        // Literal pathspecs (POST-P14ck): as a pattern, accepting a side for
        // `[id].tsx` also resolved a conflicted `i.tsx` the same way.
        await git.exec(
          this.repo.root,
          ['checkout', gitSideFlag(side, this.reversed), '--', ...literalPathspecs(paths)],
          { token },
        );
        await git.exec(this.repo.root, ['add', '--', ...literalPathspecs(paths)], { token });
      },
    });
    await this.repo.refresher.refreshNow();
  }

  /** Delete/mode conflicts: keep the deletion (`git rm`) or the file (`add`). */
  async resolveSpecial(path: string, keep: 'deleted' | 'file', side?: 'ours' | 'theirs'): Promise<void> {
    await this.repo.queue.enqueue({
      label: vscode.l10n.t('Resolve {0}', path),
      kind: 'mutate',
      bypassHold: true,
      isDestructive: true,
      snapshotLabel: SNAPSHOT_LABELS.rollback,
      snapshotPaths: [vscode.Uri.joinPath(vscode.Uri.file(this.repo.root), path).fsPath],
      run: async (git, token) => {
        if (keep === 'deleted') {
          await git.exec(this.repo.root, ['rm', '--', literalPathspec(path)], { token });
        } else {
          if (side !== undefined) {
            await git.exec(
              this.repo.root,
              ['checkout', gitSideFlag(side, this.reversed), '--', literalPathspec(path)],
              { token },
            );
          }
          await git.exec(this.repo.root, ['add', '--', literalPathspec(path)], { token });
        }
      },
    });
    await this.repo.refresher.refreshNow();
  }

  /** Marks an externally resolved path (tri-editor Apply runs its own add). */
  async markResolved(path: string): Promise<void> {
    await this.repo.queue.enqueue({
      label: vscode.l10n.t('Mark {0} resolved', path),
      kind: 'mutate',
      bypassHold: true,
      run: async (git, token) => {
        await git.exec(this.repo.root, ['add', '--', literalPathspec(path)], { token });
      },
    });
    await this.repo.refresher.refreshNow();
  }

  /** `git <op> --continue` (merge commits with the prepared message). */
  async continueOp(): Promise<boolean> {
    if (!this.canContinue) {
      void vscode.window.showWarningMessage(
        this.remaining === 1
          ? vscode.l10n.t('1 conflicted file remains — resolve it first.')
          : vscode.l10n.t('{0} conflicted files remain — resolve them first.', this.remaining),
      );
      return false;
    }
    switch (this.source) {
      case 'rebase':
        await vscode.commands.executeCommand('gittree.rebase.continue', this.repo.root);
        return true;
      case 'stash-pop':
      case 'unshelve':
      case 'checkout-merge':
        // Nothing to continue — resolution itself completes the operation.
        return true;
      case 'merge':
      case 'cherry-pick':
      case 'revert': {
        // A merge finishes with git's prepared message, as IntelliJ's Commit
        // Merge does; a message of one's own is the Commit window's to write.
        const op = this.source === 'merge' ? 'merge' : this.source;
        try {
          await this.repo.queue.enqueue({
            label: vscode.l10n.t('Continue {0}', op),
            kind: 'mutate',
            bypassHold: true,
            run: async (git, token) => {
              await git.exec(this.repo.root, [op, '--continue'], {
                env: { GIT_EDITOR: 'true' },
                token,
              });
            },
          });
        } catch (err) {
          // The sequence went on, and its next commit stopped on conflicts
          // of its own: a new stop, which the conflicts dialog takes — not a
          // failure (POST-QA: git's "could not apply" surfaced as an error).
          if (err instanceof GitError && err.kind === 'merge-conflict') {
            await this.repo.refresher.refreshNow();
            return true;
          }
          throw err;
        }
        await this.repo.refresher.refreshNow();
        // IntelliJ's `cherry.pick.continue.successful`, said for each of the three.
        notifySuccess(
          op === 'merge'
            ? vscode.l10n.t('Merge completed')
            : op === 'cherry-pick'
              ? vscode.l10n.t('Cherry-pick continue successful')
              : vscode.l10n.t('Revert continue successful'),
        );
        return true;
      }
    }
  }

  /** Abort the producing operation, restoring the pre-op state. */
  async abortOp(): Promise<void> {
    switch (this.source) {
      case 'rebase':
        await vscode.commands.executeCommand('gittree.rebase.abort', this.repo.root);
        return;
      case 'stash-pop':
      case 'unshelve':
      case 'checkout-merge':
        showInfo(
          vscode.l10n.t(
            'There is no git abort for this operation — use Local History or re-apply the stash after cleaning up.',
          ),
        );
        return;
      case 'merge':
      case 'cherry-pick':
      case 'revert': {
        const op = this.source === 'merge' ? 'merge' : this.source;
        const label =
          this.source === 'cherry-pick'
            ? SNAPSHOT_LABELS.cherryPick
            : this.source === 'revert'
              ? SNAPSHOT_LABELS.revert
              : SNAPSHOT_LABELS.merge;
        await this.repo.queue.enqueue({
          label: vscode.l10n.t('Abort {0}', op),
          kind: 'mutate',
          bypassHold: true,
          isDestructive: true,
          snapshotLabel: label,
          run: async (git, token) => {
            await git.exec(this.repo.root, [op, '--abort'], { token });
          },
        });
        await this.repo.refresher.refreshNow();
        // IntelliJ's `abort.operation.succeeded`.
        notifySuccess(
          op === 'merge'
            ? vscode.l10n.t('Merge abort succeeded')
            : op === 'cherry-pick'
              ? vscode.l10n.t('Cherry-pick abort succeeded')
              : vscode.l10n.t('Revert abort succeeded'),
        );
      }
    }
  }

  dispose(): void {
    this.sub.dispose();
    this._onDidChange.dispose();
    this._onDidResolveAll.dispose();
  }
}
