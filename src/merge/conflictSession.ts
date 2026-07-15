/**
 * Conflict session model (P6-T1): one per repo while unmerged paths exist.
 * Classifies porcelain-v2 unmerged entries, tracks the resolved set, and
 * owns the accept-side / continue / abort plumbing. The view (conflictsView)
 * and the tri-editor (T3) render it; T7 routes producer operations into it.
 */
import * as vscode from 'vscode';
import type { RepoHandle } from '../core/core';
import type { StatusEntry } from '../core/git/parsers/statusV2';
import { Emitter, type Event } from '../core/util/events';
import { SNAPSHOT_LABELS } from '../localHistory/hooks';

export type ConflictSource =
  | 'merge'
  | 'rebase'
  | 'cherry-pick'
  | 'revert'
  | 'stash-pop'
  | 'unshelve'
  | 'checkout-merge';

export type ConflictKind =
  | 'both-modified'
  | 'added-by-both'
  | 'deleted-by-us'
  | 'deleted-by-them'
  | 'both-deleted'
  | 'mode';

export interface ConflictFile {
  path: string;
  kind: ConflictKind;
}

/** Pure classification from the porcelain-v2 conflict chars + stages. */
export function classifyConflict(entry: StatusEntry): ConflictKind {
  const xy = `${entry.x}${entry.y}`;
  switch (xy) {
    case 'DD':
      return 'both-deleted';
    case 'AA':
      return 'added-by-both';
    case 'DU':
      return 'deleted-by-us';
    case 'UD':
      return 'deleted-by-them';
    case 'AU':
      // Added by us, absent on their side (rename/delete divergence).
      return 'deleted-by-them';
    case 'UA':
      return 'deleted-by-us';
    default: {
      // UU: both modified — or a pure mode conflict when the contents agree
      // but the modes differ (e.g. 100644 vs 100755).
      const s = entry.stages;
      if (s && s.sha2 === s.sha3 && s.sha2 !== '' && s.mode2 !== s.mode3) return 'mode';
      return 'both-modified';
    }
  }
}

/** Kinds resolved via QuickPick instead of the tri-editor. */
export function isSpecialConflict(kind: ConflictKind): boolean {
  return kind !== 'both-modified' && kind !== 'added-by-both';
}

export class ConflictSession {
  private readonly _onDidChange = new Emitter<void>();
  readonly onDidChange: Event<void> = this._onDidChange.event;
  private readonly _onDidResolveAll = new Emitter<void>();
  readonly onDidResolveAll: Event<void> = this._onDidResolveAll.event;
  /** Paths seen unmerged in this session that have since left that state. */
  readonly resolved = new Set<string>();
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

  /** Live unmerged files with classification. */
  files(): ConflictFile[] {
    return this.repo.model.snapshot.statusEntries
      .filter((e) => e.kind === 'unmerged')
      .map((e) => ({ path: e.path, kind: classifyConflict(e) }));
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
          ? vscode.l10n.t('Accept yours ({0} file(s))', paths.length)
          : vscode.l10n.t('Accept theirs ({0} file(s))', paths.length),
      kind: 'mutate',
      isDestructive: true,
      snapshotLabel: SNAPSHOT_LABELS.rollback,
      snapshotPaths: paths.map((p) => vscode.Uri.joinPath(vscode.Uri.file(this.repo.root), p).fsPath),
      run: async (git, token) => {
        await git.exec(this.repo.root, ['checkout', side === 'ours' ? '--ours' : '--theirs', '--', ...paths], {
          token,
        });
        await git.exec(this.repo.root, ['add', '--', ...paths], { token });
      },
    });
    await this.repo.refresher.refreshNow();
  }

  /** Delete/mode conflicts: keep the deletion (`git rm`) or the file (`add`). */
  async resolveSpecial(path: string, keep: 'deleted' | 'file', side?: 'ours' | 'theirs'): Promise<void> {
    await this.repo.queue.enqueue({
      label: vscode.l10n.t('Resolve {0}', path),
      kind: 'mutate',
      isDestructive: true,
      snapshotLabel: SNAPSHOT_LABELS.rollback,
      snapshotPaths: [vscode.Uri.joinPath(vscode.Uri.file(this.repo.root), path).fsPath],
      run: async (git, token) => {
        if (keep === 'deleted') {
          await git.exec(this.repo.root, ['rm', '--', path], { token });
        } else {
          if (side !== undefined) {
            await git.exec(this.repo.root, ['checkout', side === 'ours' ? '--ours' : '--theirs', '--', path], {
              token,
            });
          }
          await git.exec(this.repo.root, ['add', '--', path], { token });
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
      run: async (git, token) => {
        await git.exec(this.repo.root, ['add', '--', path], { token });
      },
    });
    await this.repo.refresher.refreshNow();
  }

  /** `git <op> --continue` (merge commits with the prepared message). */
  async continueOp(): Promise<boolean> {
    if (!this.canContinue) {
      void vscode.window.showWarningMessage(
        vscode.l10n.t('{0} conflicted file(s) remain — resolve them first.', this.remaining),
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
        const op = this.source === 'merge' ? 'merge' : this.source;
        await this.repo.queue.enqueue({
          label: vscode.l10n.t('Continue {0}', op),
          kind: 'mutate',
          run: async (git, token) => {
            await git.exec(this.repo.root, [op, '--continue'], {
              env: { GIT_EDITOR: 'true' },
              token,
            });
          },
        });
        await this.repo.refresher.refreshNow();
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
        void vscode.window.showInformationMessage(
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
          isDestructive: true,
          snapshotLabel: label,
          run: async (git, token) => {
            await git.exec(this.repo.root, [op, '--abort'], { token });
          },
        });
        await this.repo.refresher.refreshNow();
      }
    }
  }

  dispose(): void {
    this.sub.dispose();
    this._onDidChange.dispose();
    this._onDidResolveAll.dispose();
  }
}
