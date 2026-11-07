/**
 * Undo of a history edit — Drop, Squash, Edit Commit Message (POST-QA F4).
 *
 * IntelliJ's `GitCommitEditingOperationResult.Complete.undo()`: allowed only
 * while HEAD is still the commit the edit produced, refused when the edit's
 * commits are already on a protected remote branch, and done with
 * `git reset --keep` — which moves HEAD back and updates the files the edit
 * changed, and refuses rather than overwrite a local change to one of them.
 * GitTree had `reset --hard`, which threw away every uncommitted change in the
 * working tree, and checked nothing, so an Undo clicked later from the
 * notification centre also discarded the commits made since.
 *
 * `reset --keep` still empties the staging area, so it runs through
 * `resetKeepStaged`, which puts the staged changes back.
 */
import * as vscode from 'vscode';
import type { RepoHandle } from '../core/core';
import { GitError } from '../core/git/errors';
import { resetKeepStaged } from '../core/ops/keepStaged';
import { SNAPSHOT_LABELS } from '../localHistory/hooks';
import { DEFAULT_PROTECTED_BRANCHES, isBranchProtected } from '../scm/dialogs/pushModel';

export type HistoryEditKind = 'drop' | 'squash' | 'reword';

/** HEAD before and after an edit: what Undo goes back to, and what it requires. */
export interface HistoryEdit {
  readonly preHead: string;
  readonly postHead: string;
}

function cannotUndo(kind: HistoryEditKind, reason: string): string {
  switch (kind) {
    case 'drop':
      return vscode.l10n.t('Cannot undo drop: {0}', reason);
    case 'squash':
      return vscode.l10n.t('Cannot undo squash: {0}', reason);
    case 'reword':
      return vscode.l10n.t('Cannot undo commit message edit: {0}', reason);
  }
}

function undoFailed(kind: HistoryEditKind, detail: string): string {
  switch (kind) {
    case 'drop':
      return vscode.l10n.t('Undo drop failed: {0}', detail);
    case 'squash':
      return vscode.l10n.t('Undo squash failed: {0}', detail);
    case 'reword':
      return vscode.l10n.t('Undo commit message edit failed: {0}', detail);
  }
}

async function read(repo: RepoHandle, args: string[]): Promise<{ stdout: string; exitCode: number }> {
  return repo.queue.enqueue({
    label: 'undo edit read',
    kind: 'read',
    run: (git, token) =>
      git.exec(repo.root, args, { structured: true, noOptionalLocks: true, allowNonZeroExit: true, token }),
  });
}

/**
 * The protected remote branch that already holds the first commit the edit
 * created, if any: undoing then would leave a protected branch with commits
 * the local branch no longer has.
 */
async function protectedHolder(repo: RepoHandle, edit: HistoryEdit): Promise<string | undefined> {
  const created = await read(repo, ['rev-list', '--reverse', `${edit.preHead}..${edit.postHead}`]);
  const first = created.stdout.split('\n').map((l) => l.trim()).find((l) => l.length > 0);
  if (first === undefined) return undefined;
  const holders = await read(repo, ['branch', '-r', '--contains', first, '--format=%(refname:short)']);
  const patterns = vscode.workspace
    .getConfiguration('gittree')
    .get<string[]>('protectedBranches', [...DEFAULT_PROTECTED_BRANCHES]);
  for (const ref of holders.stdout.split('\n').map((l) => l.trim())) {
    const slash = ref.indexOf('/');
    if (slash <= 0) continue;
    if (isBranchProtected(ref.slice(slash + 1), patterns)) return ref;
  }
  return undefined;
}

/** True when the repository is back where it was before the edit. */
export async function undoHistoryEdit(repo: RepoHandle, edit: HistoryEdit, kind: HistoryEditKind): Promise<boolean> {
  const head = await read(repo, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']);
  if (head.exitCode !== 0 || head.stdout.trim() !== edit.postHead) {
    void vscode.window.showWarningMessage(cannotUndo(kind, vscode.l10n.t('the repository has already been changed.')));
    return false;
  }
  const holder = await protectedHolder(repo, edit);
  if (holder !== undefined) {
    void vscode.window.showWarningMessage(
      cannotUndo(
        kind,
        vscode.l10n.t('commits from the current branch have already been pushed to protected branch {0}.', holder),
      ),
    );
    return false;
  }
  try {
    const result = await repo.queue.enqueue({
      label: vscode.l10n.t('Undo (reset to {0})', edit.preHead.slice(0, 7)),
      kind: 'mutate',
      isDestructive: true,
      snapshotLabel: SNAPSHOT_LABELS.reset,
      run: (git, token) => resetKeepStaged(git, repo.root, edit.preHead, token),
    });
    if (result.skipped.length > 0) {
      void vscode.window.showWarningMessage(
        vscode.l10n.t(
          'Undone. {0} staged file(s) changed with the undo and are now unstaged: {1}',
          result.skipped.length,
          result.skipped.join(', '),
        ),
      );
    }
  } catch (err) {
    const detail =
      err instanceof GitError
        ? describeKeepRefusal(err.stderr) ?? err.message
        : err instanceof Error
          ? err.message
          : String(err);
    void vscode.window.showErrorMessage(undoFailed(kind, detail));
    return false;
  } finally {
    await repo.refresher.refreshNow();
  }
  return true;
}

/** `reset --keep` refusing over a local change, said in the user's terms. */
export function describeKeepRefusal(stderr: string): string | undefined {
  const paths = [...stderr.matchAll(/Entry '([^']+)' (?:not uptodate|would be overwritten)/gu)].map((m) => m[1]);
  if (paths.length === 0) return undefined;
  return vscode.l10n.t(
    'your local changes to {0} would be overwritten. Commit, shelve or roll them back, then undo again.',
    paths.join(', '),
  );
}
