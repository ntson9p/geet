/**
 * Branch operations service (P2-T3): every §2 context action, all through
 * the OperationQueue with l10n'd labels, progress, and P9 snapshot flags on
 * the destructive ones.
 */
import * as vscode from 'vscode';
import type { Core, RepoHandle } from '../core/core';
import { GitError } from '../core/git/errors';
import { SNAPSHOT_LABELS } from '../localHistory/hooks';
import { splitUpstream } from '../scm/dialogs/pushArgs';
import { buildUpdateFetchArgs } from '../scm/dialogs/updateArgs';
import { countPulled } from '../scm/dialogs/updateDialog';
import { pullResultMessage } from '../scm/resultMessages';
import { confirmModal } from '../ui/confirm';
import { notifySuccess, type NotificationAction } from '../ui/notify';
import { checkoutAcross, type CheckoutAcrossOutcome } from './checkoutAcross';
import type { CheckoutTarget } from './checkoutAcrossModel';
import { buildNewBranchArgs, remoteNamesOf } from './newBranchArgs';
import { checkoutWithSmart } from './smartCheckout';
import {
  buildAheadBehindArgs,
  buildFastForwardArgs,
  parseAheadBehind,
} from './updateBranchArgs';

/** git's failures are multi-line; notifications get the sentence that matters. */
function firstLine(text: string): string {
  const line = text
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  return line ?? '';
}

export class BranchOps {
  constructor(private readonly core: Core) {}

  /** Checkout with the Smart Checkout interceptor (T4). */
  async checkout(repo: RepoHandle, branch: string): Promise<void> {
    await checkoutWithSmart(this.core, repo, branch);
  }

  /**
   * POST-P14ax: one branch, or tag, checked out in every repository of `repos`
   * that has it — the local branch where there is one, else a new one tracking
   * the remote branch of that name — with one question for local changes in
   * the way and one summary.
   */
  checkoutAcross(repos: readonly RepoHandle[], target: CheckoutTarget): Promise<CheckoutAcrossOutcome> {
    return checkoutAcross(this.core, repos, target);
  }

  /**
   * Remote branch → tracking local, **without asking for a name**.
   *
   * IntelliJ's `Checkout` on a remote branch creates the local branch named
   * after it and switches to it, in one gesture. GitTree used to open an input
   * box pre-filled with that very name, so the overwhelmingly common answer was
   * to press Enter on a name the user had not chosen and did not need to see.
   * The name is still reachable when it is actually wanted: `New Branch from
   * 'origin/x'…` is a separate row in the same menu, and that one does prompt.
   *
   * A local branch of that name already existing is not a conflict — it is the
   * branch you were asking for. IntelliJ checks it out rather than refusing, so
   * a second `Checkout` on `origin/develop` lands on `develop` instead of
   * failing with "already exists".
   */
  async checkoutRemote(repo: RepoHandle, remoteBranch: string): Promise<void> {
    const remote = repo.model.snapshot.refs.find(
      (r) => r.type === 'remote' && r.name === remoteBranch,
    );
    const name =
      remote?.remote !== undefined
        ? remoteBranch.slice(remote.remote.length + 1)
        : remoteBranch.replace(/^[^/]+\//, '');
    if (name.length === 0) return;
    const existing = repo.model.snapshot.refs.some((r) => r.type === 'head' && r.name === name);
    if (existing) {
      // Straight through Smart Checkout, so uncommitted work is handled the
      // same way it is for any other local branch.
      await this.checkout(repo, name);
      return;
    }
    await repo.queue.enqueue({
      label: vscode.l10n.t('Checkout {0} tracking {1}', name, remoteBranch),
      kind: 'mutate',
      isDestructive: true,
      snapshotLabel: SNAPSHOT_LABELS.checkoutDirty,
      snapshotAfter: true,
      run: async (git, token) => {
        await git.exec(repo.root, ['checkout', '-b', name, '--track', remoteBranch], { token });
      },
    });
    notifySuccess(vscode.l10n.t('Checked out new branch {0} from {1}', name, remoteBranch));
  }

  /** New branch from a start point; optionally checked out. */
  async newBranchFrom(repo: RepoHandle, startPoint: string): Promise<void> {
    const name = await this.promptBranchName(repo, '', vscode.l10n.t('New branch from {0}', startPoint));
    if (name === undefined) return;
    const checkoutItem = vscode.l10n.t('Create and Checkout');
    const createItem = vscode.l10n.t('Create');
    const testMode = process.env['GITTREE_TEST_BRANCH_MODE'];
    const mode =
      testMode === 'checkout'
        ? checkoutItem
        : testMode === 'create'
          ? createItem
          : await vscode.window.showQuickPick([checkoutItem, createItem], {
              placeHolder: vscode.l10n.t('Create "{0}" from {1}', name, startPoint),
            });
    if (mode === undefined) return;
    const snap = repo.model.snapshot;
    const args = buildNewBranchArgs({
      name,
      startPoint,
      checkout: mode === checkoutItem,
      unborn: snap.initial,
      refs: snap.refs,
    });
    if (mode === checkoutItem) {
      await repo.queue.enqueue({
        label: vscode.l10n.t('Create + checkout {0}', name),
        kind: 'mutate',
        isDestructive: true,
        snapshotLabel: SNAPSHOT_LABELS.checkoutDirty,
        snapshotAfter: true,
        run: async (git, token) => {
          await git.exec(repo.root, args, { token });
        },
      });
      // IntelliJ's words: a new branch off where you are "was created"
      // (`GitCheckoutNewBranchOperation`); one off another ref was checked out
      // from it (`GitCheckoutOperation`).
      notifySuccess(
        startPoint === 'HEAD'
          ? vscode.l10n.t('Branch {0} was created', name)
          : vscode.l10n.t('Checked out new branch {0} from {1}', name, startPoint),
      );
    } else {
      await repo.queue.enqueue({
        label: vscode.l10n.t('Create branch {0}', name),
        kind: 'mutate',
        run: async (git, token) => {
          await git.exec(repo.root, args, { token });
        },
      });
      notifySuccess(vscode.l10n.t('Branch {0} was created', name));
    }
  }

  async renameBranch(repo: RepoHandle, branch: string): Promise<void> {
    const ref = repo.model.snapshot.refs.find((r) => r.type === 'head' && r.name === branch);
    const newName = await this.promptBranchName(repo, branch, vscode.l10n.t('Rename "{0}" to', branch));
    if (newName === undefined || newName === branch) return;
    await repo.queue.enqueue({
      label: vscode.l10n.t('Rename {0} → {1}', branch, newName),
      kind: 'mutate',
      run: async (git, token) => {
        await git.exec(repo.root, ['branch', '-m', '--', branch, newName], { token });
      },
    });
    const upstream = ref?.upstream !== undefined && !ref.upstreamGone ? ref.upstream : undefined;
    if (upstream === undefined) {
      notifySuccess(vscode.l10n.t('Branch {0} was renamed to {1}', branch, newName));
      return;
    }
    // A rename keeps the link, so the next push still goes to the old remote branch.
    const actions: NotificationAction[] = [];
    const remoteBranch = splitUpstream(upstream, remoteNamesOf(repo.model.snapshot.refs));
    // Only a remote branch carrying the old name is the branch being renamed.
    // Any other is someone else's: `mine` tracking `origin/develop` must never
    // offer to delete `develop`.
    if (remoteBranch?.branch === branch) {
      actions.push({
        title: vscode.l10n.t('Push "{0}" and delete "{1}" on the remote', newName, branch),
        run: () => this.renameOnRemote(repo, remoteBranch.remote, branch, newName),
      });
    }
    actions.push({
      title: vscode.l10n.t('Stop Tracking {0}', upstream),
      run: () => this.unsetUpstream(repo, newName, upstream, false),
    });
    notifySuccess(
      vscode.l10n.t('Branch {0} was renamed to {1}. It still tracks {2}.', branch, newName, upstream),
      ...actions,
    );
  }

  /** The rename's follow-up: the new name on the remote, tracked, and the old one gone. */
  private async renameOnRemote(
    repo: RepoHandle,
    remote: string,
    oldName: string,
    newName: string,
  ): Promise<void> {
    await repo.queue.enqueue({
      label: vscode.l10n.t('Update remote after rename'),
      kind: 'mutate',
      run: async (git, token) => {
        await git.exec(repo.root, ['push', '-u', remote, newName], { token });
        await git.exec(repo.root, ['push', remote, '--delete', oldName], {
          token,
          allowNonZeroExit: true, // already gone is fine
        });
      },
    });
    notifySuccess(
      vscode.l10n.t('Pushed {0} to {1} and deleted {2} on the remote', newName, remote, oldName),
    );
  }

  /**
   * `Stop Tracking`: the branch keeps its commits and the remote keeps its
   * branch; only the link between them goes, so the next push offers a branch
   * of the branch's own name again. `Undo` puts the link back while the remote
   * branch still exists.
   */
  async stopTracking(repo: RepoHandle, branch: string): Promise<void> {
    const ref = repo.model.snapshot.refs.find((r) => r.type === 'head' && r.name === branch);
    await this.unsetUpstream(repo, branch, ref?.upstream, ref?.upstreamGone === true);
  }

  private async unsetUpstream(
    repo: RepoHandle,
    branch: string,
    upstream: string | undefined,
    gone: boolean,
  ): Promise<void> {
    await repo.queue.enqueue({
      label: vscode.l10n.t('Stop tracking for {0}', branch),
      kind: 'mutate',
      run: async (git, token) => {
        await git.exec(repo.root, ['branch', '--unset-upstream', '--', branch], { token });
      },
    });
    await repo.refresher.refreshNow();
    const undo: NotificationAction[] =
      upstream !== undefined && !gone
        ? [{ title: vscode.l10n.t('Undo'), run: () => this.setUpstream(repo, branch, upstream) }]
        : [];
    notifySuccess(
      vscode.l10n.t('Branch {0} no longer tracks {1}', branch, upstream ?? vscode.l10n.t('its remote branch')),
      ...undo,
    );
  }

  /** `Undo` on `Stop Tracking`. */
  private async setUpstream(repo: RepoHandle, branch: string, upstream: string): Promise<void> {
    await repo.queue.enqueue({
      label: vscode.l10n.t('Track {0} on {1}', upstream, branch),
      kind: 'mutate',
      run: async (git, token) => {
        await git.exec(repo.root, ['branch', `--set-upstream-to=${upstream}`, '--', branch], { token });
      },
    });
    await repo.refresher.refreshNow();
    notifySuccess(vscode.l10n.t('Branch {0} tracks {1} again', branch, upstream));
  }

  /**
   * Delete, then IntelliJ's notification (`GitDeleteBranchOperation`):
   * *Deleted branch X* — *Unmerged commits were discarded* when it had to be
   * forced — with `Restore`, which puts the branch back where it was (its
   * upstream too), and `Delete Tracked Branch` while it tracked one.
   */
  async deleteBranch(repo: RepoHandle, branch: string): Promise<void> {
    const ref = repo.model.snapshot.refs.find((r) => r.type === 'head' && r.name === branch);
    if (ref?.isHead) {
      void vscode.window.showWarningMessage(
        vscode.l10n.t('Cannot delete the checked-out branch.'),
      );
      return;
    }
    let forced = false;
    try {
      await repo.queue.enqueue({
        label: vscode.l10n.t('Delete branch {0}', branch),
        kind: 'mutate',
        run: async (git, token) => {
          await git.exec(repo.root, ['branch', '-d', '--', branch], { token });
        },
      });
    } catch (err) {
      const stderr = err instanceof GitError ? err.stderr : '';
      if (!stderr.includes('not fully merged')) throw err;
      const ok = await confirmModal(
        vscode.l10n.t('"{0}" is not fully merged.', branch),
        vscode.l10n.t(
          'Its commits are not reachable from any other branch and may be lost (recoverable from Local History / reflog for a while).',
        ),
        vscode.l10n.t('Force Delete'),
      );
      if (!ok) return;
      await repo.queue.enqueue({
        label: vscode.l10n.t('Force delete branch {0}', branch),
        kind: 'mutate',
        isDestructive: true,
        snapshotLabel: SNAPSHOT_LABELS.branchForceDelete,
        run: async (git, token) => {
          await git.exec(repo.root, ['branch', '-D', '--', branch], { token });
        },
      });
      forced = true;
    }
    const actions: NotificationAction[] = [];
    const sha = ref?.sha;
    const upstream = ref?.upstream !== undefined && !ref.upstreamGone ? ref.upstream : undefined;
    if (sha !== undefined && sha.length > 0) {
      actions.push({
        title: vscode.l10n.t('Restore'),
        run: () => this.restoreBranch(repo, branch, sha, ref?.upstream),
      });
    }
    if (upstream !== undefined) {
      actions.push({
        title: vscode.l10n.t('Delete Tracked Branch'),
        run: () => this.deleteTrackedBranch(repo, upstream),
      });
    }
    notifySuccess(
      forced
        ? vscode.l10n.t('Deleted branch {0}. Unmerged commits were discarded.', branch)
        : vscode.l10n.t('Deleted branch {0}', branch),
      ...actions,
    );
  }

  /** `Restore` on a deleted branch: the branch at its old tip, tracking what it tracked. */
  private async restoreBranch(
    repo: RepoHandle,
    branch: string,
    sha: string,
    upstream: string | undefined,
  ): Promise<void> {
    await repo.queue.enqueue({
      label: vscode.l10n.t('Restore branch {0}', branch),
      kind: 'mutate',
      run: async (git, token) => {
        await git.exec(repo.root, ['branch', '--', branch, sha], { token });
        if (upstream !== undefined) {
          // The remote branch may be gone by now; the branch itself is back either way.
          await git.exec(repo.root, ['branch', `--set-upstream-to=${upstream}`, branch], {
            token,
            allowNonZeroExit: true,
          });
        }
      },
    });
    await repo.refresher.refreshNow();
    notifySuccess(vscode.l10n.t('Restored branch {0}', branch));
  }

  /** `Delete Tracked Branch` on a deleted branch's notification. */
  private async deleteTrackedBranch(repo: RepoHandle, upstream: string): Promise<void> {
    const remote = upstream.split('/')[0] ?? 'origin';
    const remoteName = upstream.slice(remote.length + 1);
    await repo.queue.enqueue({
      label: vscode.l10n.t('Delete remote branch {0}', upstream),
      kind: 'mutate',
      run: async (git, token) => {
        await git.exec(repo.root, ['push', remote, '--delete', remoteName], { token });
      },
    });
    await repo.refresher.refreshNow();
    notifySuccess(vscode.l10n.t('Deleted remote branch {0}', upstream));
  }

  /**
   * IntelliJ's `Push…` on a branch (`GitPushBranchAction`): the Push dialog for
   * that branch, in `repos` — the one row, or every repository a common branch
   * is in, in one dialog. Resolves once the dialog has closed.
   */
  async pushBranch(repos: RepoHandle | readonly RepoHandle[], branch: string): Promise<void> {
    const roots = (Array.isArray(repos) ? repos : [repos]).map((r: RepoHandle) => r.root);
    await vscode.commands.executeCommand('gittree.push.branch', roots, branch);
  }

  /** `git rebase <current> <sel>`: checks out sel and rebases it onto current. */
  async checkoutAndRebaseOntoCurrent(repo: RepoHandle, branch: string): Promise<void> {
    const current = repo.model.snapshot.headRef;
    if (current === undefined) {
      void vscode.window.showWarningMessage(vscode.l10n.t('Not on a branch.'));
      return;
    }
    try {
      await repo.queue.enqueue({
        label: vscode.l10n.t('Rebase {0} onto {1}', branch, current),
        kind: 'mutate',
        isDestructive: true,
        snapshotLabel: SNAPSHOT_LABELS.rebaseStart,
        snapshotAfter: true,
        run: async (git, token) => {
          await git.exec(repo.root, ['rebase', current, branch], { token });
        },
      });
      notifySuccess(vscode.l10n.t('Checked out {0} and rebased it on {1}', branch, current));
    } catch (err) {
      if (err instanceof GitError && err.kind === 'merge-conflict') {
        // P6 conflicts session takes over once shipped; guide until then.
        void vscode.window.showWarningMessage(
          vscode.l10n.t(
            'Rebase of "{0}" stopped on conflicts. Resolve the conflicted files, then continue or abort the rebase.',
            branch,
          ),
        );
        return;
      }
      throw err;
    }
  }

  /** Merge another branch into the current one (Branches view drag flow). */
  async mergeIntoCurrent(repo: RepoHandle, branch: string): Promise<void> {
    const current = repo.model.snapshot.headRef ?? 'HEAD';
    try {
      const output = await repo.queue.enqueue({
        label: vscode.l10n.t('Merge {0}', branch),
        kind: 'mutate',
        isDestructive: true,
        snapshotLabel: SNAPSHOT_LABELS.merge,
        snapshotAfter: true,
        run: async (git, token) => {
          const res = await git.exec(repo.root, ['merge', '--', branch], { token });
          return res.stdout;
        },
      });
      // IntelliJ's `GitMergeOperation`: *Merged X to Y*, or *Already up to date*.
      notifySuccess(
        /Already up[ -]to[ -]date/i.test(output)
          ? vscode.l10n.t('Already up to date')
          : vscode.l10n.t('Merged {0} to {1}', branch, current),
      );
    } catch (err) {
      if (err instanceof GitError && err.kind === 'merge-conflict') {
        void vscode.window.showWarningMessage(
          vscode.l10n.t('Merge of "{0}" produced conflicts — resolve them, then commit.', branch),
        );
        return;
      }
      throw err;
    }
  }

  /**
   * `git rebase <sel>` — rebase the CURRENT branch onto the selected one. The
   * mirror of `checkoutAndRebaseOntoCurrent`, and a separate verb in IntelliJ's
   * branch submenu (`Rebase '<current>' onto 'X'`). P13-T5.
   */
  async rebaseCurrentOnto(repo: RepoHandle, branch: string): Promise<void> {
    const current = repo.model.snapshot.headRef;
    if (current === undefined) {
      void vscode.window.showWarningMessage(vscode.l10n.t('Not on a branch.'));
      return;
    }
    try {
      await repo.queue.enqueue({
        label: vscode.l10n.t('Rebase {0} onto {1}', current, branch),
        kind: 'mutate',
        isDestructive: true,
        snapshotLabel: SNAPSHOT_LABELS.rebaseStart,
        snapshotAfter: true,
        run: async (git, token) => {
          await git.exec(repo.root, ['rebase', branch], { token });
        },
      });
      notifySuccess(vscode.l10n.t('Rebased {0} on {1}', current, branch));
    } catch (err) {
      if (err instanceof GitError && err.kind === 'merge-conflict') {
        void vscode.window.showWarningMessage(
          vscode.l10n.t(
            'Rebase of "{0}" stopped on conflicts. Resolve the conflicted files, then continue or abort the rebase.',
            current,
          ),
        );
        return;
      }
      throw err;
    }
  }

  /**
   * `Pull into '<current>' Using Merge` / `… Using Rebase` on a remote branch
   * row (P13-T5; the rebase half added with the Tracked Branch submenu). The
   * strategy is always explicit — `git pull` on its own obeys `pull.rebase`,
   * so a menu row promising "Using Merge" could silently rebase.
   */
  async pullRemoteIntoCurrent(
    repo: RepoHandle,
    remoteBranch: string,
    strategy: 'merge' | 'rebase' = 'merge',
  ): Promise<void> {
    const slash = remoteBranch.indexOf('/');
    if (slash <= 0) {
      void vscode.window.showWarningMessage(
        vscode.l10n.t('"{0}" is not a remote-tracking branch.', remoteBranch),
      );
      return;
    }
    const remote = remoteBranch.slice(0, slash);
    const branch = remoteBranch.slice(slash + 1);
    const headOf = async (): Promise<string> => {
      const res = await this.core.git.exec(repo.root, ['rev-parse', '--verify', '--quiet', 'HEAD'], {
        structured: true,
        allowNonZeroExit: true,
      });
      return res.exitCode === 0 ? res.stdout.trim() : '';
    };
    const before = await headOf();
    try {
      await repo.queue.enqueue({
        label: vscode.l10n.t('Pull {0}', remoteBranch),
        kind: 'mutate',
        isDestructive: true,
        snapshotLabel: strategy === 'rebase' ? SNAPSHOT_LABELS.rebaseStart : SNAPSHOT_LABELS.merge,
        run: async (git, token) => {
          const flag = strategy === 'rebase' ? '--rebase' : '--no-rebase';
          await git.exec(repo.root, ['pull', flag, remote, branch], { token });
        },
      });
      // Pull fetched the branch into its remote-tracking ref first.
      const counted = await countPulled(this.core, repo, before, `refs/remotes/${remoteBranch}`);
      notifySuccess(pullResultMessage(counted.commits, counted.files, remoteBranch));
    } catch (err) {
      if (err instanceof GitError && err.kind === 'merge-conflict') {
        void vscode.window.showWarningMessage(
          strategy === 'rebase'
            ? vscode.l10n.t(
                'Pull of "{0}" stopped on conflicts. Resolve the conflicted files, then continue or abort the rebase.',
                remoteBranch,
              )
            : vscode.l10n.t('Pull of "{0}" produced conflicts — resolve them, then commit.', remoteBranch),
        );
        return;
      }
      throw err;
    }
  }

  /**
   * `Update` on a branch row. On the checked-out branch this *is* Update
   * Project — same fetch, same merge/rebase, same `Show in Log` follow-up —
   * so it delegates instead of growing a second implementation that could
   * answer differently. It delegates to the half that **does not ask**
   * (POST-P14ad): IntelliJ's branch `Update` runs with the saved update
   * method, and only `Update Project…` puts the question. Picking a branch
   * and `Update` already said what to do.
   *
   * Any other branch cannot be integrated without checking it out, so GitTree
   * does what IntelliJ does and moves the ref in place, fast-forward only. The
   * refusal is git's own (see `updateBranchArgs.ts`); a diverged branch is
   * reported with its counts rather than rewritten, because the user cannot
   * see what they would lose from a branch that is not in front of them.
   *
   * Resolves `true` when the branch is now level with its upstream, `false`
   * when it is not — every outcome is already reported to the user either
   * way. The all-repositories fan-out stops on `false`.
   */
  async updateBranch(repo: RepoHandle, branch: string, isCurrent: boolean): Promise<boolean> {
    if (isCurrent) {
      const outcome = await vscode.commands.executeCommand<{ ok: boolean } | undefined>(
        'gittree.update.run',
        repo.root,
      );
      return outcome?.ok === true;
    }
    const ref = repo.model.snapshot.refs.find((r) => r.type === 'head' && r.name === branch);
    const upstream = ref?.upstreamGone === true ? undefined : ref?.upstream;
    if (upstream === undefined) {
      void vscode.window.showWarningMessage(
        vscode.l10n.t('"{0}" has no upstream branch to update from.', branch),
      );
      return false;
    }
    const remoteList = await this.core.git.exec(repo.root, ['remote'], { structured: true });
    const remotes = remoteList.stdout
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    const remote = splitUpstream(upstream, remotes)?.remote;

    type Outcome =
      | { kind: 'upToDate' }
      | { kind: 'diverged'; ahead: number; behind: number }
      | { kind: 'updated'; commits: number }
      | { kind: 'failed'; message: string };

    // One queue entry, not three: the fetch, the count and the fast-forward
    // are one user-visible operation, and interleaving another mutation
    // between the count and the ref move would act on stale numbers.
    const outcome = await repo.queue.enqueue<Outcome>({
      label: vscode.l10n.t('Update {0}', branch),
      kind: 'mutate',
      run: async (git, token): Promise<Outcome> => {
        try {
          await git.exec(repo.root, buildUpdateFetchArgs(remote), { token });
        } catch (err) {
          // An unreachable remote is an outcome to report, not a stack trace:
          // the rest of this operation is meaningless without the fetch, and
          // the counts below would silently describe the pre-fetch world.
          return {
            kind: 'failed',
            message: err instanceof GitError ? firstLine(err.stderr) : String(err),
          };
        }
        const counted = await git.exec(repo.root, buildAheadBehindArgs(branch, upstream), {
          structured: true,
          noOptionalLocks: true,
          allowNonZeroExit: true,
          token,
        });
        if (counted.exitCode !== 0) {
          return { kind: 'failed', message: firstLine(counted.stderr) };
        }
        const { ahead, behind } = parseAheadBehind(counted.stdout);
        if (behind === 0) return { kind: 'upToDate' };
        if (ahead > 0) return { kind: 'diverged', ahead, behind };
        const ff = await git.exec(repo.root, buildFastForwardArgs(upstream, branch), {
          structured: true,
          allowNonZeroExit: true,
          token,
        });
        return ff.exitCode === 0
          ? { kind: 'updated', commits: behind }
          : { kind: 'failed', message: firstLine(ff.stderr) };
      },
    });
    await repo.refresher.refreshNow();

    switch (outcome.kind) {
      case 'upToDate':
        notifySuccess(vscode.l10n.t('{0} is already up to date with {1}.', branch, upstream));
        return true;
      case 'diverged':
        void vscode.window.showWarningMessage(
          vscode.l10n.t(
            '"{0}" has diverged from {1} ({2} ahead, {3} behind) and cannot be fast-forwarded. Check it out to merge or rebase.',
            branch,
            upstream,
            outcome.ahead,
            outcome.behind,
          ),
        );
        return false;
      case 'updated':
        notifySuccess(
          vscode.l10n.t('Updated {0} to {1}: {2} commit(s).', branch, upstream, outcome.commits),
        );
        return true;
      case 'failed':
        void vscode.window.showErrorMessage(
          vscode.l10n.t('Could not update "{0}": {1}', branch, outcome.message),
        );
        return false;
    }
  }

  /**
   * `Delete 'origin/x' on Remote` — `git push <remote> --delete <branch>`.
   * Behind an explicit confirmation: this is the one branch action that
   * changes something other people can see.
   */
  async deleteRemoteBranch(repo: RepoHandle, remoteBranch: string): Promise<void> {
    const slash = remoteBranch.indexOf('/');
    if (slash <= 0) {
      void vscode.window.showWarningMessage(
        vscode.l10n.t('"{0}" is not a remote-tracking branch.', remoteBranch),
      );
      return;
    }
    const remote = remoteBranch.slice(0, slash);
    const branch = remoteBranch.slice(slash + 1);
    const ok = await confirmModal(
      vscode.l10n.t('Delete "{0}" on the remote?', remoteBranch),
      vscode.l10n.t('This removes the branch for everyone using {0}.', remote),
      vscode.l10n.t('Delete on Remote'),
    );
    if (!ok) return;
    await repo.queue.enqueue({
      label: vscode.l10n.t('Delete {0} on remote', remoteBranch),
      kind: 'mutate',
      run: async (git, token) => {
        await git.exec(repo.root, ['push', remote, '--delete', branch], { token });
      },
    });
    await repo.refresher.refreshNow();
    notifySuccess(vscode.l10n.t('Deleted remote branch {0}', remoteBranch));
  }

  private async promptBranchName(
    repo: RepoHandle,
    initial: string,
    prompt: string,
  ): Promise<string | undefined> {
    // Test seam: native input boxes cannot be driven by the harness.
    const testName = process.env['GITTREE_TEST_BRANCH_NAME'];
    if (testName !== undefined && testName.length > 0) return testName;
    const name = await vscode.window.showInputBox({
      prompt,
      value: initial,
      ignoreFocusOut: true,
      validateInput: async (value) => {
        if (value.trim().length === 0) return vscode.l10n.t('Branch name is required');
        const check = await repo.queue.enqueue({
          label: 'validate branch name',
          kind: 'read',
          run: (git, token) =>
            git.exec(repo.root, ['check-ref-format', '--branch', value], {
              structured: true,
              allowNonZeroExit: true,
              token,
            }),
        });
        if (check.exitCode !== 0) return vscode.l10n.t('Invalid branch name');
        if (repo.model.snapshot.refs.some((r) => r.type === 'head' && r.name === value && value !== initial)) {
          return vscode.l10n.t('Branch already exists');
        }
        return undefined;
      },
    });
    return name?.trim();
  }
}
