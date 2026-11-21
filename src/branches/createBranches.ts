/**
 * The Branches panel's New Branch form, carried out (new-way-4): one name, one
 * start point, any number of repositories, checked out or not.
 *
 * Everything that can be known before touching a repository is checked first
 * — a valid name, a name free in every chosen repository, a start point each of
 * them has, nothing mid-merge or mid-conflict — so a refusal changes nothing
 * anywhere.
 *
 * POST-P14ax: then each repository gets the branch in turn, and one that fails
 * no longer stops the rest, as Update Project's run does not either. A
 * repository whose local changes are in the way of Check it out gets the branch
 * all the same, not checked out yet; once every repository has had its turn,
 * one question covers all of those — Smart Checkout, Force Checkout, or leave
 * them — as a checkout across repositories asks it. One notification says
 * what happened everywhere.
 */
import * as vscode from 'vscode';
import type { Core, RepoHandle } from '../core/core';
import { GitError } from '../core/git/errors';
import { isValidRefName } from '../core/git/refName';
import { repoBusyReason } from '../core/model/repoBusy';
import { SNAPSHOT_LABELS } from '../localHistory/hooks';
import type { BranchPanelCreateDto, BranchPanelCreateResultDto } from '../shared/protocol';
import { notifySuccess, notifyWarning, type NotificationAction } from '../ui/notify';
import { askAboutLocalChanges, reasonOf } from './checkoutAcross';
import { summarizeNewBranch, type CreateResult } from './createBranchesModel';
import { buildNewBranchArgs } from './newBranchArgs';
import { reposOf } from './panelActions';
import { parseBlockingFiles } from './parsing';
import { RestoreFailedError, setAsideAround } from './smartCheckout';

export async function createBranches(
  core: Core,
  request: BranchPanelCreateDto,
  labelOf: (root: string) => string,
): Promise<BranchPanelCreateResultDto> {
  const name = request.name.trim();
  if (!isValidRefName(name)) {
    return { ok: false, error: vscode.l10n.t('“{0}” is not a valid branch name.', name) };
  }
  const repos = reposOf(core, request.roots);
  if (repos.length === 0) {
    return { ok: false, error: vscode.l10n.t('Choose a repository to create the branch in.') };
  }
  const from = request.from.trim().length > 0 ? request.from.trim() : 'HEAD';

  // git has the last word on the name; ask it in the first repository.
  const format = await repos[0]!.queue.enqueue({
    label: 'validate branch name',
    kind: 'read',
    run: (git, token) =>
      git.exec(repos[0]!.root, ['check-ref-format', '--branch', name], {
        structured: true,
        allowNonZeroExit: true,
        token,
      }),
  });
  if (format.exitCode !== 0) {
    return { ok: false, error: vscode.l10n.t('“{0}” is not a valid branch name.', name) };
  }

  for (const repo of repos) {
    const snap = repo.model.snapshot;
    // POST-P14ax: its mutations are held until its conflicts are resolved, so the
    // branch would wait there, and every repository after it with it.
    const busy = repoBusyReason(snap);
    if (busy !== undefined) {
      return {
        ok: false,
        error: vscode.l10n.t('{0} can’t take a new branch now: {1}.', labelOf(repo.root), busy),
      };
    }
    if (snap.refs.some((r) => r.type === 'head' && r.name === name)) {
      return {
        ok: false,
        error: vscode.l10n.t('{0} already has a branch named “{1}”.', labelOf(repo.root), name),
      };
    }
    if (!request.checkout && snap.initial) {
      return {
        ok: false,
        error: vscode.l10n.t('{0} has no commit yet to start a branch from.', labelOf(repo.root)),
      };
    }
    if (from !== 'HEAD' && !(await resolves(repo, from))) {
      return {
        ok: false,
        error: vscode.l10n.t('{0} has nothing called “{1}” to start from.', labelOf(repo.root), from),
      };
    }
  }

  const results = new Map<string, CreateResult>();
  const blocked: Array<{ repo: RepoHandle; head?: string; files: string[] }> = [];
  for (const repo of repos) {
    const snap = repo.model.snapshot;
    const label = labelOf(repo.root);
    const argsFor = (checkout: boolean): string[] =>
      buildNewBranchArgs({ name, startPoint: from, checkout, unborn: snap.initial, refs: snap.refs });
    try {
      await makeBranch(repo, name, argsFor(request.checkout), request.checkout);
      results.set(repo.root, { kind: 'created', label, checkedOut: request.checkout });
    } catch (err) {
      if (request.checkout && err instanceof GitError && err.kind === 'would-overwrite-checkout') {
        // Made here all the same, not yet checked out: the local changes in the
        // way are asked about once, for every repository they stopped.
        try {
          await makeBranch(repo, name, argsFor(false), false);
          blocked.push({
            repo,
            ...(snap.headRef !== undefined && !snap.detached ? { head: snap.headRef } : {}),
            files: parseBlockingFiles(err.stderr),
          });
        } catch (again) {
          results.set(repo.root, { kind: 'failed', label, reason: reasonOf(again) });
        }
      } else {
        results.set(repo.root, { kind: 'failed', label, reason: reasonOf(err) });
      }
    }
  }

  let restoreConflicts = false;
  if (blocked.length > 0) {
    const choice = await askAboutLocalChanges(
      name,
      blocked.map((b) => ({ label: labelOf(b.repo.root), files: b.files })),
    );
    for (const b of blocked) {
      const label = labelOf(b.repo.root);
      if (choice === 'leave') {
        results.set(b.repo.root, { kind: 'blocked', label, ...(b.head !== undefined ? { head: b.head } : {}), files: b.files });
        continue;
      }
      try {
        if (choice === 'smart') {
          await setAsideAround(b.repo, name, ['checkout', name]);
          results.set(b.repo.root, { kind: 'created', label, checkedOut: true, setAside: 'restored' });
        } else {
          await makeBranch(b.repo, name, ['checkout', '-f', name], true, true);
          results.set(b.repo.root, { kind: 'created', label, checkedOut: true, forced: true });
        }
      } catch (err) {
        if (err instanceof RestoreFailedError) {
          restoreConflicts ||= err.conflicts;
          results.set(b.repo.root, { kind: 'created', label, checkedOut: true, setAside: 'kept' });
        } else {
          // The branch is made; only switching to it failed.
          results.set(b.repo.root, { kind: 'failed', label, reason: reasonOf(err) });
        }
      }
    }
  }

  const ordered = repos.flatMap((r) => {
    const result = results.get(r.root);
    return result !== undefined ? [result] : [];
  });
  // Nothing went through anywhere: the form keeps the reason, and stays open.
  if (ordered.every((r) => r.kind === 'failed')) {
    const failed = ordered.filter((r): r is Extract<CreateResult, { kind: 'failed' }> => r.kind === 'failed');
    const only = failed[0];
    return {
      ok: false,
      error:
        only === undefined
          ? vscode.l10n.t('The branch could not be created.')
          : failed.length === 1
            ? vscode.l10n.t('{0}: {1}', only.label, only.reason)
            : failed.map((f) => `${f.label}: ${f.reason}`).join(' · '),
    };
  }
  const summary = summarizeNewBranch(name, from, ordered);
  const actions: NotificationAction[] = restoreConflicts
    ? [{ title: vscode.l10n.t('Show Conflicts'), run: () => vscode.commands.executeCommand('geet.conflicts.focus') }]
    : [];
  if (summary.kind === 'warning') notifyWarning(summary.message, ...actions);
  else notifySuccess(summary.message, ...actions);
  return { ok: true };
}

/** One repository's branch: made, and checked out when `checkout`. */
async function makeBranch(
  repo: RepoHandle,
  name: string,
  args: readonly string[],
  checkout: boolean,
  force = false,
): Promise<void> {
  await repo.queue.enqueue({
    label: checkout ? vscode.l10n.t('Create + checkout {0}', name) : vscode.l10n.t('Create branch {0}', name),
    kind: 'mutate',
    ...(checkout
      ? {
          isDestructive: true,
          snapshotLabel: force ? SNAPSHOT_LABELS.forceCheckout : SNAPSHOT_LABELS.checkoutDirty,
          snapshotAfter: true,
        }
      : {}),
    run: async (git, token) => {
      await git.exec(repo.root, [...args], { token });
    },
  });
}

async function resolves(repo: RepoHandle, rev: string): Promise<boolean> {
  const res = await repo.queue.enqueue({
    label: `resolve ${rev}`,
    kind: 'read',
    run: (git, token) =>
      git.exec(repo.root, ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`], {
        structured: true,
        noOptionalLocks: true,
        allowNonZeroExit: true,
        token,
      }),
  });
  return res.exitCode === 0;
}
