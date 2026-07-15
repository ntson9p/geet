/**
 * Revert & Cherry-Pick flows (P5-T4). Multi-select aware (`git revert
 * <shas…>` / `git cherry-pick <shas…>` oldest-first through one sequencer),
 * merge reverts via `-m 1` behind an explainer modal, clean picks
 * auto-commit, `-x` behind gittree.cherryPick.recordOrigin, and a
 * Continue/Skip/Abort pause flow with per-commit progress until the P6
 * conflicts view takes over. GIT_EDITOR never opens (--no-edit / env guard).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { Core, RepoHandle } from '../core/core';
import { canonicalKey } from '../core/repoDiscovery';
import { SNAPSHOT_LABELS } from '../localHistory/hooks';
import { confirmModal } from '../ui/confirm';

export type SequenceKind = 'revert' | 'cherry-pick';

export interface SequenceOutcome {
  status: 'completed' | 'paused' | 'failed' | 'refused';
  stderr?: string;
  /** Newly created commits (oldest first), set when completed. */
  newShas?: string[];
  /** 1-based index of the stopped commit and the sequence total, when paused. */
  step?: number;
  total?: number;
}

interface Session {
  kind: SequenceKind;
  preHead: string;
  total: number;
}

export class RevertCherryPickService {
  /** Active sequence per repo — survives pauses for progress + new-sha math. */
  private readonly sessions = new Map<string, Session>();

  constructor(private readonly core: Core) {}

  // ---- entry points --------------------------------------------------------

  async revert(repo: RepoHandle, shas: readonly string[]): Promise<SequenceOutcome> {
    const ordered = await this.orderOldestFirst(repo, shas);
    if (ordered.length === 0) return { status: 'refused' };

    const mergeFlags = await Promise.all(ordered.map((s) => this.isMerge(repo, s)));
    const mergeCount = mergeFlags.filter(Boolean).length;
    if (mergeCount > 0 && mergeCount < ordered.length) {
      void vscode.window.showErrorMessage(
        vscode.l10n.t(
          'The selection mixes merge and non-merge commits — revert merges separately (-m applies to the whole revert).',
        ),
      );
      return { status: 'refused' };
    }
    if (mergeCount > 0) {
      const ok = await confirmModal(
        vscode.l10n.t('Revert a merge commit?'),
        vscode.l10n.t(
          'Reverting a merge undoes every change the merged branch brought in. The first parent (-m 1 — the branch that was merged into) is kept as mainline.',
        ),
        vscode.l10n.t('Revert Merge'),
      );
      if (!ok) return { status: 'refused' };
    }

    const args = ['revert', '--no-edit'];
    if (mergeCount > 0) args.push('-m', '1');
    args.push(...ordered);
    return this.runSequence(repo, 'revert', SNAPSHOT_LABELS.revert, args, ordered.length);
  }

  async cherryPick(repo: RepoHandle, shas: readonly string[]): Promise<SequenceOutcome> {
    const ordered = await this.orderOldestFirst(repo, shas);
    if (ordered.length === 0) return { status: 'refused' };
    const recordOrigin = vscode.workspace
      .getConfiguration('gittree.cherryPick')
      .get<boolean>('recordOrigin', false);
    const args = ['cherry-pick'];
    if (recordOrigin) args.push('-x');
    args.push(...ordered);
    return this.runSequence(repo, 'cherry-pick', SNAPSHOT_LABELS.cherryPick, args, ordered.length);
  }

  // ---- pause lifecycle (interim UI until P6) -------------------------------

  async continueSequence(repo: RepoHandle, kind: SequenceKind): Promise<SequenceOutcome> {
    const unresolved = await this.read(repo, ['diff', '--name-only', '--diff-filter=U']);
    const conflicted = unresolved.split('\n').filter((l) => l.trim().length > 0);
    if (conflicted.length > 0) {
      void vscode.window.showWarningMessage(
        vscode.l10n.t(
          'Resolve {0} conflicted file(s) and stage the results before continuing.',
          conflicted.length,
        ),
      );
      return { status: 'paused', ...(await this.progress(repo)) };
    }
    return this.runStep(repo, kind, [kind, '--continue']);
  }

  async skipSequence(repo: RepoHandle, kind: SequenceKind): Promise<SequenceOutcome> {
    return this.runStep(repo, kind, [kind, '--skip']);
  }

  async abortSequence(repo: RepoHandle, kind: SequenceKind): Promise<void> {
    await repo.queue.enqueue({
      label: vscode.l10n.t('{0}: abort', kind),
      kind: 'mutate',
      isDestructive: true,
      bypassHold: true,
      snapshotLabel: kind === 'revert' ? SNAPSHOT_LABELS.revert : SNAPSHOT_LABELS.cherryPick,
      run: async (git, token) => {
        await git.exec(repo.root, [kind, '--abort'], { token });
      },
    });
    this.sessions.delete(canonicalKey(repo.root));
    await repo.refresher.refreshNow();
  }

  // ---- internals -----------------------------------------------------------

  private async runSequence(
    repo: RepoHandle,
    kind: SequenceKind,
    snapshotLabel: string,
    args: string[],
    total: number,
  ): Promise<SequenceOutcome> {
    const preHead = await this.revParseHead(repo);
    if (preHead === undefined) return { status: 'failed' };
    this.sessions.set(canonicalKey(repo.root), { kind, preHead, total });
    return this.execAndClassify(repo, kind, snapshotLabel, args);
  }

  private async runStep(repo: RepoHandle, kind: SequenceKind, args: string[]): Promise<SequenceOutcome> {
    const label = kind === 'revert' ? SNAPSHOT_LABELS.revert : SNAPSHOT_LABELS.cherryPick;
    return this.execAndClassify(repo, kind, label, args);
  }

  private async execAndClassify(
    repo: RepoHandle,
    kind: SequenceKind,
    snapshotLabel: string,
    args: string[],
  ): Promise<SequenceOutcome> {
    const result = await repo.queue.enqueue({
      label: vscode.l10n.t('{0} ({1})', kind === 'revert' ? 'Revert' : 'Cherry-pick', args.length - 1),
      kind: 'mutate',
      isDestructive: true,
      // P6-T7: --continue/--skip resolve the pause that holds the lane.
      bypassHold: true,
      snapshotLabel,
      snapshotAfter: true,
      run: (git, token) =>
        git.exec(repo.root, args, {
          env: { GIT_EDITOR: 'true' },
          allowNonZeroExit: true,
          token,
        }),
    });

    if (result.exitCode === 0) {
      const outcome = await this.completed(repo, kind);
      return outcome;
    }
    if (this.inSequence(repo, kind)) {
      const prog = await this.progress(repo);
      void this.pauseToast(repo, kind, prog);
      return { status: 'paused', stderr: result.stderr, ...prog };
    }
    this.sessions.delete(canonicalKey(repo.root));
    const first = result.stderr.split('\n').find((l) => l.trim().length > 0) ?? '';
    void vscode.window.showErrorMessage(
      vscode.l10n.t('{0} failed: {1}', kind === 'revert' ? 'Revert' : 'Cherry-pick', first),
    );
    return { status: 'failed', stderr: result.stderr };
  }

  private async completed(repo: RepoHandle, kind: SequenceKind): Promise<SequenceOutcome> {
    const key = canonicalKey(repo.root);
    const session = this.sessions.get(key);
    this.sessions.delete(key);
    let newShas: string[] = [];
    if (session) {
      const raw = await this.read(repo, ['rev-list', '--reverse', `${session.preHead}..HEAD`]);
      newShas = raw.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
    }
    const shortList = newShas.map((s) => s.slice(0, 7)).join(', ');
    void vscode.window.showInformationMessage(
      kind === 'revert'
        ? vscode.l10n.t('Reverted — new commit(s): {0}', shortList)
        : vscode.l10n.t('Cherry-picked {0} commit(s): {1}', newShas.length, shortList),
    );
    await repo.refresher.refreshNow();
    return { status: 'completed', newShas };
  }

  /**
   * `k/n` while paused. The sequencer's todo file is not reliably pruned of
   * completed entries at stop time, so count what actually landed instead:
   * the stopped commit is one past the commits created since the sequence
   * began.
   */
  private async progress(repo: RepoHandle): Promise<{ step?: number; total?: number }> {
    const session = this.sessions.get(canonicalKey(repo.root));
    if (!session) return {};
    const raw = await this.read(repo, ['rev-list', '--count', `${session.preHead}..HEAD`]);
    const done = Number.parseInt(raw.trim(), 10);
    if (!Number.isFinite(done)) return { total: session.total };
    return { step: Math.min(done + 1, session.total), total: session.total };
  }

  private async pauseToast(
    repo: RepoHandle,
    kind: SequenceKind,
    prog: { step?: number; total?: number },
  ): Promise<void> {
    const cont = vscode.l10n.t('Continue');
    const skip = vscode.l10n.t('Skip Commit');
    const abort = vscode.l10n.t('Abort');
    const at =
      prog.step !== undefined && prog.total !== undefined && prog.total > 1
        ? ` (${prog.step}/${prog.total})`
        : '';
    const verb = kind === 'revert' ? vscode.l10n.t('Revert') : vscode.l10n.t('Cherry-pick');
    const choice = await vscode.window.showWarningMessage(
      vscode.l10n.t('{0} paused on conflicts{1}. Resolve and stage them, then continue.', verb, at),
      cont,
      skip,
      abort,
    );
    if (choice === cont) {
      const outcome = await this.continueSequence(repo, kind);
      if (outcome.status === 'paused') void this.pauseToast(repo, kind, await this.progress(repo));
    } else if (choice === skip) {
      const outcome = await this.skipSequence(repo, kind);
      if (outcome.status === 'paused') void this.pauseToast(repo, kind, await this.progress(repo));
    } else if (choice === abort) {
      await this.abortSequence(repo, kind);
    }
  }

  private inSequence(repo: RepoHandle, kind: SequenceKind): boolean {
    const marker = kind === 'revert' ? 'REVERT_HEAD' : 'CHERRY_PICK_HEAD';
    if (this.isFile(path.join(repo.dirs.gitDir, marker))) return true;
    return this.isFile(path.join(repo.dirs.gitDir, 'sequencer', 'todo'));
  }

  private isFile(p: string): boolean {
    try {
      return fs.statSync(p).isFile();
    } catch {
      return false;
    }
  }

  /** Sorts full shas oldest-first regardless of selection order. */
  /**
   * `rev-list --no-walk` sorts by commit time, which is ambiguous for
   * same-second commits (rapid or scripted histories) — the tie-break is
   * unstable and can scramble a chain. Order by ancestry instead: insert each
   * sha before its first descendant already placed (an entry never precedes
   * its ancestor, by induction). Unrelated commits keep their input order.
   * O(n²) merge-base calls, fine for log-view-sized selections.
   */
  private async orderOldestFirst(repo: RepoHandle, shas: readonly string[]): Promise<string[]> {
    const unique = [...new Set(shas)];
    if (unique.length <= 1) return unique;
    const ordered: string[] = [];
    for (const sha of unique) {
      let at = ordered.length;
      for (const [i, placed] of ordered.entries()) {
        if (await this.isAncestor(repo, sha, placed)) {
          at = i;
          break;
        }
      }
      ordered.splice(at, 0, sha);
    }
    return ordered;
  }

  private async isAncestor(repo: RepoHandle, ancestor: string, descendant: string): Promise<boolean> {
    const result = await repo.queue.enqueue({
      label: 'revert/cherry-pick read',
      kind: 'read',
      run: (git, token) =>
        git.exec(repo.root, ['merge-base', '--is-ancestor', ancestor, descendant], {
          structured: true,
          noOptionalLocks: true,
          allowNonZeroExit: true,
          token,
        }),
    });
    return result.exitCode === 0;
  }

  private async isMerge(repo: RepoHandle, sha: string): Promise<boolean> {
    const raw = await this.read(repo, ['rev-list', '--parents', '-n', '1', sha]);
    return raw.trim().split(/\s+/).length > 2;
  }

  private async revParseHead(repo: RepoHandle): Promise<string | undefined> {
    const raw = await this.read(repo, ['rev-parse', '--verify', 'HEAD']);
    const sha = raw.trim();
    return /^[0-9a-f]{40,64}$/.test(sha) ? sha : undefined;
  }

  private async read(repo: RepoHandle, args: string[]): Promise<string> {
    const result = await repo.queue.enqueue({
      label: 'revert/cherry-pick read',
      kind: 'read',
      run: (git, token) =>
        git.exec(repo.root, args, {
          structured: true,
          noOptionalLocks: true,
          allowNonZeroExit: true,
          token,
        }),
    });
    return result.exitCode === 0 ? result.stdout : '';
  }
}
