/**
 * Commit executors (P3-T5): changelist commits bypass the index via
 * `git commit --only -- <paths>` (untracked members get `git add -N` first),
 * staged commits run plain `git commit`; amend and GPG-sign toggles with a
 * pushed-HEAD guard. Replaces the P1-T7 MVP internals; command ids stable.
 */
import * as vscode from 'vscode';
import type { Core, RepoHandle } from '../core/core';
import { GitError } from '../core/git/errors';
import { literalPathspecs } from '../core/git/pathspec';
import { Emitter, type Event } from '../core/util/events';
import { confirmModal } from '../ui/confirm';
import { buildCommitArgs, type CommitOptions } from './commitArgs';
import { commitSelection, type SelectionPatch } from './selectionCommit';
export { buildCommitArgs, type CommitOptions } from './commitArgs';

/**
 * POST-QA: a commit runs through a conflict pause's hold on the mutation lane
 * (P6-T7). It is how a merge — or a cherry-pick, the Commit window's way —
 * ends, and the hold lifts only when the operation does, so a held commit
 * waited for itself forever. Nothing unresolved can slip through: the commit
 * flow refuses while a conflict is left, and git refuses to commit unmerged
 * files besides.
 */
const COMMIT_ENDS_A_PAUSE = true;

export interface CommitResult {
  repo: RepoHandle;
  message: string;
  sha: string;
}

export class CommitService {
  private readonly _onDidCommit = new Emitter<CommitResult>();
  readonly onDidCommit: Event<CommitResult> = this._onDidCommit.event;
  private readonly amendRepos = new Set<string>();
  private signOverride: boolean | undefined;

  constructor(private readonly core: Core) {}

  isAmend(repo: RepoHandle): boolean {
    return this.amendRepos.has(repo.root);
  }

  async toggleAmend(repo: RepoHandle): Promise<{ amend: boolean; previousMessage?: string }> {
    if (this.amendRepos.has(repo.root)) {
      this.amendRepos.delete(repo.root);
      await vscode.commands.executeCommand('setContext', 'gittree.amend', false);
      return { amend: false };
    }
    // Guard: amending a pushed HEAD rewrites shared history.
    const pushed = await this.isHeadPushed(repo);
    if (pushed) {
      const ok = await confirmModal(
        vscode.l10n.t('HEAD is already pushed to {0}.', repo.model.snapshot.upstream ?? 'upstream'),
        vscode.l10n.t('Amending will rewrite published history and require a force push.'),
        vscode.l10n.t('Amend Anyway'),
      );
      if (!ok) return { amend: false };
    }
    this.amendRepos.add(repo.root);
    await vscode.commands.executeCommand('setContext', 'gittree.amend', true);
    const lastMessage = await repo.queue.enqueue({
      label: 'read HEAD message',
      kind: 'read',
      run: (git, token) =>
        git.exec(repo.root, ['log', '-1', '--format=%B'], {
          structured: true,
          noOptionalLocks: true,
          allowNonZeroExit: true,
          token,
        }),
    });
    return {
      amend: true,
      ...(lastMessage.exitCode === 0 ? { previousMessage: lastMessage.stdout.replace(/\n+$/, '') } : {}),
    };
  }

  async isHeadPushed(repo: RepoHandle): Promise<boolean> {
    if (repo.model.snapshot.upstream === undefined || repo.model.snapshot.upstreamGone) return false;
    const result = await repo.queue.enqueue({
      label: 'check pushed',
      kind: 'read',
      run: (git, token) =>
        git.exec(repo.root, ['merge-base', '--is-ancestor', 'HEAD', '@{u}'], {
          structured: true,
          noOptionalLocks: true,
          allowNonZeroExit: true,
          token,
        }),
    });
    return result.exitCode === 0;
  }

  /** Sign default follows commit.gpgsign; the toggle overrides per session. */
  async isSignEnabled(repo: RepoHandle): Promise<boolean> {
    if (this.signOverride !== undefined) return this.signOverride;
    const result = await repo.queue.enqueue({
      label: 'read commit.gpgsign',
      kind: 'read',
      run: (git, token) =>
        git.exec(repo.root, ['config', '--type=bool', '--get', 'commit.gpgsign'], {
          structured: true,
          noOptionalLocks: true,
          allowNonZeroExit: true,
          token,
        }),
    });
    return result.exitCode === 0 && result.stdout.trim() === 'true';
  }

  async toggleSign(repo: RepoHandle): Promise<boolean> {
    const current = await this.isSignEnabled(repo);
    this.signOverride = !current;
    await vscode.commands.executeCommand('setContext', 'gittree.sign', this.signOverride);
    return this.signOverride;
  }

  /** Changelist commit: index-bypassing `--only` over the checked paths. */
  async commitChangelist(
    repo: RepoHandle,
    relPaths: readonly string[],
    untrackedRelPaths: readonly string[],
    message: string,
    options: CommitOptions,
  ): Promise<void> {
    await repo.queue.enqueue({
      label: options.amend ? vscode.l10n.t('Commit changelist (amend)') : vscode.l10n.t('Commit changelist'),
      kind: 'mutate',
      bypassHold: COMMIT_ENDS_A_PAUSE,
      run: async (git, token) => {
        if (untrackedRelPaths.length > 0) {
          // Intent-to-add so --only can see brand-new files.
          await git.exec(repo.root, ['add', '-N', '--', ...literalPathspecs(untrackedRelPaths)], { token });
        }
        try {
          await git.exec(repo.root, buildCommitArgs('only', message, options, relPaths), { token });
        } catch (err) {
          // Some git builds refuse --only with intent-to-add entries: fall
          // back to a real add of just the untracked members, then retry.
          if (
            err instanceof GitError &&
            untrackedRelPaths.length > 0 &&
            /intent to add|ita entries|not possible because you have unmerged|pathspec/.test(err.stderr)
          ) {
            await git.exec(repo.root, ['add', '--', ...literalPathspecs(untrackedRelPaths)], { token });
            await git.exec(repo.root, buildCommitArgs('only', message, options, relPaths), { token });
          } else {
            throw err;
          }
        }
      },
    });
    await this.afterCommit(repo, message);
  }

  /**
   * Changelist commit of HEAD plus a selection — a file contributing only some
   * of its changes (P11-T3), or any selection during a merge, where git
   * refuses `commit --only` (POST-QA). See `commitSelection`.
   */
  async commitChangelistPartial(
    repo: RepoHandle,
    wholeRelPaths: readonly string[],
    partials: readonly SelectionPatch[],
    message: string,
    options: CommitOptions,
  ): Promise<void> {
    await repo.queue.enqueue({
      label: options.amend
        ? vscode.l10n.t('Commit selected changes (amend)')
        : vscode.l10n.t('Commit selected changes'),
      kind: 'mutate',
      bypassHold: COMMIT_ENDS_A_PAUSE,
      run: (git, token) =>
        commitSelection(git, repo.root, repo.dirs.gitDir, wholeRelPaths, partials, message, options, token),
    });
    await this.afterCommit(repo, message);
  }

  async commitStaged(repo: RepoHandle, message: string, options: CommitOptions, all = false): Promise<void> {
    await repo.queue.enqueue({
      label: options.amend ? vscode.l10n.t('Commit (amend)') : vscode.l10n.t('Commit'),
      kind: 'mutate',
      bypassHold: COMMIT_ENDS_A_PAUSE,
      run: async (git, token) => {
        await git.exec(repo.root, buildCommitArgs(all ? 'all' : 'staged', message, options), { token });
      },
    });
    await this.afterCommit(repo, message);
  }

  private async afterCommit(repo: RepoHandle, message: string): Promise<void> {
    this.amendRepos.delete(repo.root);
    this.signOverride = undefined;
    await vscode.commands.executeCommand('setContext', 'gittree.amend', false);
    const sha = await repo.queue.enqueue({
      label: 'read new HEAD',
      kind: 'read',
      run: (git, token) =>
        git.exec(repo.root, ['rev-parse', 'HEAD'], {
          structured: true,
          noOptionalLocks: true,
          allowNonZeroExit: true,
          token,
        }),
    });
    this._onDidCommit.fire({
      repo,
      message,
      sha: sha.exitCode === 0 ? sha.stdout.trim() : '',
    });
  }

  dispose(): void {
    this._onDidCommit.dispose();
  }
}

/** GPG failure classification for friendlier errors (P3-T5 step 4). */
export function describeGpgFailure(stderr: string): string | undefined {
  if (/gpg failed to sign|gpg: signing failed|cannot open .*pinentry|Inappropriate ioctl/.test(stderr)) {
    return vscode.l10n.t(
      'GPG signing failed. Check that a signing key is configured (user.signingkey) and pinentry works — on Windows, install Gpg4win and set gpg.program.',
    );
  }
  if (/secret key not available|No secret key/.test(stderr)) {
    return vscode.l10n.t('No GPG secret key available for signing (user.signingkey).');
  }
  return undefined;
}
