/**
 * Branch operations service (P2-T3): every §2 context action, all through
 * the OperationQueue with l10n'd labels, progress, and P9 snapshot flags on
 * the destructive ones.
 */
import * as vscode from 'vscode';
import type { Core, RepoHandle } from '../core/core';
import { GitError } from '../core/git/errors';
import { SNAPSHOT_LABELS } from '../localHistory/hooks';
import { confirmModal } from '../ui/confirm';
import { checkoutWithSmart } from './smartCheckout';

export class BranchOps {
  constructor(private readonly core: Core) {}

  /** Checkout with the Smart Checkout interceptor (T4). */
  async checkout(repo: RepoHandle, branch: string): Promise<void> {
    await checkoutWithSmart(this.core, repo, branch);
  }

  /** Remote branch → tracking local (name validated, pre-filled). */
  async checkoutRemote(repo: RepoHandle, remoteBranch: string): Promise<void> {
    const remote = repo.model.snapshot.refs.find(
      (r) => r.type === 'remote' && r.name === remoteBranch,
    );
    const defaultName = remote?.remote !== undefined
      ? remoteBranch.slice(remote.remote.length + 1)
      : remoteBranch.replace(/^[^/]+\//, '');
    const name = await this.promptBranchName(repo, defaultName, vscode.l10n.t('Local branch name'));
    if (name === undefined) return;
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
    if (mode === checkoutItem) {
      await repo.queue.enqueue({
        label: vscode.l10n.t('Create + checkout {0}', name),
        kind: 'mutate',
        isDestructive: true,
        snapshotLabel: SNAPSHOT_LABELS.checkoutDirty,
        snapshotAfter: true,
        run: async (git, token) => {
          await git.exec(repo.root, ['checkout', '-b', name, startPoint], { token });
        },
      });
    } else {
      await repo.queue.enqueue({
        label: vscode.l10n.t('Create branch {0}', name),
        kind: 'mutate',
        run: async (git, token) => {
          await git.exec(repo.root, ['branch', '--', name, startPoint], { token });
        },
      });
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
    if (ref?.upstream !== undefined && !ref.upstreamGone) {
      const pushNew = vscode.l10n.t('Push "{0}" and delete "{1}" on the remote', newName, branch);
      const choice = await vscode.window.showInformationMessage(
        vscode.l10n.t('"{0}" tracked {1}. Update the remote?', branch, ref.upstream),
        pushNew,
      );
      if (choice === pushNew) {
        const remote = ref.upstream.split('/')[0] ?? 'origin';
        const oldRemoteName = ref.upstream.slice(remote.length + 1);
        await repo.queue.enqueue({
          label: vscode.l10n.t('Update remote after rename'),
          kind: 'mutate',
          run: async (git, token) => {
            await git.exec(repo.root, ['push', '-u', remote, newName], { token });
            await git.exec(repo.root, ['push', remote, '--delete', oldRemoteName], {
              token,
              allowNonZeroExit: true, // already gone is fine
            });
          },
        });
      }
    }
  }

  async deleteBranch(repo: RepoHandle, branch: string): Promise<void> {
    const ref = repo.model.snapshot.refs.find((r) => r.type === 'head' && r.name === branch);
    if (ref?.isHead) {
      void vscode.window.showWarningMessage(
        vscode.l10n.t('Cannot delete the checked-out branch.'),
      );
      return;
    }
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
    }
    if (ref?.upstream !== undefined && !ref.upstreamGone) {
      const delRemote = vscode.l10n.t('Delete {0} too', ref.upstream);
      const choice = await vscode.window.showInformationMessage(
        vscode.l10n.t('Also delete the remote branch {0}?', ref.upstream),
        delRemote,
      );
      if (choice === delRemote) {
        const remote = ref.upstream.split('/')[0] ?? 'origin';
        const remoteName = ref.upstream.slice(remote.length + 1);
        await repo.queue.enqueue({
          label: vscode.l10n.t('Delete remote branch {0}', ref.upstream),
          kind: 'mutate',
          run: async (git, token) => {
            await git.exec(repo.root, ['push', remote, '--delete', remoteName], { token });
          },
        });
      }
    }
  }

  async pushBranch(repo: RepoHandle, branch: string): Promise<void> {
    const ref = repo.model.snapshot.refs.find((r) => r.type === 'head' && r.name === branch);
    const args =
      ref?.upstream !== undefined && !ref.upstreamGone
        ? ['push', 'origin', `${branch}:${ref.upstream.replace(/^[^/]+\//, '')}`]
        : ['push', '-u', 'origin', branch];
    await repo.queue.enqueue({
      label: vscode.l10n.t('Push {0}', branch),
      kind: 'mutate',
      run: async (git, token) => {
        await git.exec(repo.root, args, { token });
      },
    });
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
    try {
      await repo.queue.enqueue({
        label: vscode.l10n.t('Merge {0}', branch),
        kind: 'mutate',
        isDestructive: true,
        snapshotLabel: SNAPSHOT_LABELS.merge,
        snapshotAfter: true,
        run: async (git, token) => {
          await git.exec(repo.root, ['merge', '--', branch], { token });
        },
      });
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

  /** `Pull into '<current>' Using Merge` on a remote branch row (P13-T5). */
  async pullRemoteIntoCurrent(repo: RepoHandle, remoteBranch: string): Promise<void> {
    const slash = remoteBranch.indexOf('/');
    if (slash <= 0) {
      void vscode.window.showWarningMessage(
        vscode.l10n.t('"{0}" is not a remote-tracking branch.', remoteBranch),
      );
      return;
    }
    const remote = remoteBranch.slice(0, slash);
    const branch = remoteBranch.slice(slash + 1);
    try {
      await repo.queue.enqueue({
        label: vscode.l10n.t('Pull {0}', remoteBranch),
        kind: 'mutate',
        isDestructive: true,
        snapshotLabel: SNAPSHOT_LABELS.merge,
        run: async (git, token) => {
          await git.exec(repo.root, ['pull', '--no-rebase', remote, branch], { token });
        },
      });
    } catch (err) {
      if (err instanceof GitError && err.kind === 'merge-conflict') {
        void vscode.window.showWarningMessage(
          vscode.l10n.t('Pull of "{0}" produced conflicts — resolve them, then commit.', remoteBranch),
        );
        return;
      }
      throw err;
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
