/**
 * The Branches panel's New Branch form, carried out (new-way-4): one name, one
 * start point, any number of repositories, checked out or not.
 *
 * Everything that can be known before touching a repository is checked first
 * — a valid name, a name free in every chosen repository, a start point each of
 * them has — so a refusal changes nothing anywhere. Then the repositories are
 * done one at a time, stopping at the first that fails, the way every
 * all-repositories operation in GitTree runs (`runCommonAction`), and the form
 * hears which were already done.
 */
import * as vscode from 'vscode';
import type { Core, RepoHandle } from '../core/core';
import { isValidRefName } from '../core/git/refName';
import { SNAPSHOT_LABELS } from '../localHistory/hooks';
import type { BranchPanelCreateDto, BranchPanelCreateResultDto } from '../shared/protocol';
import { notifySuccess } from '../ui/notify';
import { buildNewBranchArgs } from './newBranchArgs';
import { reposOf } from './panelActions';

/** git's failures are multi-line; the form gets the sentence that matters. */
function firstLine(text: string): string {
  return (
    text
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? ''
  );
}

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

  const done: string[] = [];
  for (const repo of repos) {
    const snap = repo.model.snapshot;
    const args = buildNewBranchArgs({
      name,
      startPoint: from,
      checkout: request.checkout,
      unborn: snap.initial,
      refs: snap.refs,
    });
    try {
      await repo.queue.enqueue({
        label: request.checkout
          ? vscode.l10n.t('Create + checkout {0}', name)
          : vscode.l10n.t('Create branch {0}', name),
        kind: 'mutate',
        ...(request.checkout
          ? { isDestructive: true, snapshotLabel: SNAPSHOT_LABELS.checkoutDirty, snapshotAfter: true }
          : {}),
        run: async (git, token) => {
          await git.exec(repo.root, args, { token });
        },
      });
      done.push(labelOf(repo.root));
    } catch (err) {
      const reason = firstLine(err instanceof Error ? err.message : String(err));
      return {
        ok: false,
        error:
          done.length > 0
            ? vscode.l10n.t('Stopped at {0}: {1} Already created in: {2}.', labelOf(repo.root), reason, done.join(', '))
            : vscode.l10n.t('{0}: {1}', labelOf(repo.root), reason),
      };
    }
  }

  // IntelliJ's words: a branch off where you are "was created"; one off
  // another ref was "checked out from" it.
  const message =
    request.checkout && from !== 'HEAD'
      ? vscode.l10n.t('Checked out new branch {0} from {1}', name, from)
      : vscode.l10n.t('Branch {0} was created', name);
  notifySuccess(
    repos.length > 1 ? vscode.l10n.t('{0} in {1} repositories', message, repos.length) : message,
  );
  return { ok: true };
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
