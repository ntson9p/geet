/**
 * Commit flow orchestration (P3-T8): resolve paradigm-aware target files →
 * guards → CheckPipeline → executor → post-actions (clear input, message
 * history, optional push offer, refresh). One progress notification with
 * step names; `gittree.commit` keeps its P1 id.
 */
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { Core, RepoHandle } from '../core/core';
import { isStaged } from '../core/model/statusEntry';
import { CancellationSource } from '../core/util/cancellation';
import { confirmModal } from '../ui/confirm';
import { UNVERSIONED_ID, type ChangelistService } from './changelists/changelistService';
import type { CheckPipeline } from './checks/pipeline';
import { CommitService, describeGpgFailure } from './commitService';
import type { CommitMessageBox } from './messageBox';
import type { MessageHistory } from './messageHistory';
import type { ParadigmManager } from './paradigmManager';
import { GitError } from '../core/git/errors';
import { canonicalKey } from '../core/repoDiscovery';
import { computeFileDiff, planPartialCommit, type PartialPlan } from './window/fileDiff';
import type { InclusionModel } from './window/inclusion';

export interface CommitFlowDeps {
  core: Core;
  paradigm: ParadigmManager;
  commitService: CommitService;
  pipeline: CheckPipeline;
  history: MessageHistory;
  changelistsFor: (repo: RepoHandle) => ChangelistService;
  /** P11-T2: widened from SourceControlInputBox so the commit window can own it. */
  inputBoxFor: (repo: RepoHandle) => CommitMessageBox | undefined;
  /** P11-T3: per-change inclusion. Absent = every ticked file commits whole. */
  inclusion?: InclusionModel;
}

interface CommitTarget {
  /** Tracked paths for --only (changelists) or [] (staged). */
  relPaths: string[];
  untrackedRelPaths: string[];
  /** Absolute uris fed to the check pipeline. */
  uris: vscode.Uri[];
  mode: 'changelists' | 'staged';
}

function resolveTarget(deps: CommitFlowDeps, repo: RepoHandle, listId?: string): CommitTarget | undefined {
  if (deps.paradigm.paradigm === 'changelists') {
    const service = deps.changelistsFor(repo);
    const lists = service.getLists().filter((l) => (listId === undefined ? true : l.id === listId));
    // P11-T3: ticked unversioned files join a whole-repo commit, but never a
    // "commit this changelist" — they belong to no list.
    const unversioned =
      listId === undefined || listId === UNVERSIONED_ID ? service.unversionedCheckedPaths() : [];
    const checked = [...lists.flatMap((l) => l.checked), ...unversioned];
    if (checked.length === 0) return undefined;
    const untracked = checked.filter((p) => service.isUntrackedPath(p));
    return {
      relPaths: checked,
      untrackedRelPaths: untracked,
      uris: checked.map((p) => vscode.Uri.file(path.join(repo.root, p))),
      mode: 'changelists',
    };
  }
  const staged = repo.model.snapshot.statusEntries.filter(isStaged);
  if (staged.length === 0) return undefined;
  return {
    relPaths: [],
    untrackedRelPaths: [],
    uris: staged.map((e) => vscode.Uri.file(path.join(repo.root, e.path))),
    mode: 'staged',
  };
}

/**
 * Splits the ticked paths into whole-file and partial commits. With no live
 * per-change selection this is a pure copy and costs no git calls, so the
 * ordinary commit path stays exactly what P3-T5 shipped.
 */
async function planCommit(
  deps: CommitFlowDeps,
  repo: RepoHandle,
  target: CommitTarget,
): Promise<PartialPlan> {
  const { inclusion } = deps;
  const key = canonicalKey(repo.root);
  if (!inclusion || inclusion.entries(key).length === 0) {
    return { wholePaths: [...target.relPaths], partials: [], skipped: [], stale: [] };
  }
  return planPartialCommit(target.relPaths, {
    readDiff: (relPath) => computeFileDiff(repo, relPath),
    resolveIncluded: (relPath, changes) => inclusion.resolve(key, relPath, changes),
    hasSelection: (relPath) => inclusion.get(key, relPath) !== undefined,
  });
}

export async function runCommitFlow(
  deps: CommitFlowDeps,
  repo: RepoHandle,
  options: { listId?: string; andPush?: boolean } = {},
): Promise<boolean> {
  const inputBox = deps.inputBoxFor(repo);
  const message = inputBox?.value.trim() ?? '';
  const amend = deps.commitService.isAmend(repo);
  if (message.length === 0 && !amend) {
    void vscode.window.showWarningMessage(vscode.l10n.t('Enter a commit message first.'));
    return false;
  }

  let target = resolveTarget(deps, repo, options.listId);
  let commitAll = false;
  if (!target) {
    if (deps.paradigm.paradigm === 'changelists') {
      void vscode.window.showInformationMessage(vscode.l10n.t('No checked files to commit.'));
      return false;
    }
    // Staging paradigm with an empty index: offer commit-all (P1 behavior).
    const trackedDirty = repo.model.snapshot.statusEntries.filter(
      (e) => e.kind !== 'untracked' && e.kind !== 'ignored',
    );
    if (trackedDirty.length === 0 && !amend) {
      void vscode.window.showInformationMessage(vscode.l10n.t('No changes to commit.'));
      return false;
    }
    if (trackedDirty.length > 0) {
      const ok = await confirmModal(
        vscode.l10n.t('Nothing is staged. Commit all tracked changes?'),
        '',
        vscode.l10n.t('Commit All'),
      );
      if (!ok) return false;
    }
    commitAll = true;
    // Commit-all still runs the check pipeline over the affected files.
    target = {
      relPaths: [],
      untrackedRelPaths: [],
      uris: trackedDirty.map((e) => vscode.Uri.file(path.join(repo.root, e.path))),
      mode: 'staged',
    };
  }

  const sign = await deps.commitService.isSignEnabled(repo);

  const committed = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: vscode.l10n.t('Committing…'),
      cancellable: true,
    },
    async (progress, token) => {
      const source = new CancellationSource();
      const tokenSub = token.onCancellationRequested(() => source.cancel());
      try {
        const outcome = await deps.pipeline.run({
          repo,
          files: target.uris,
          token: source.token,
          progress: (step) => progress.report({ message: step }),
        });
        if (!outcome.proceed) return false;

        progress.report({ message: vscode.l10n.t('Running git commit') });
        try {
          if (target.mode === 'changelists') {
            // Built here, after the checks: reformat rewrites files and
            // renumbers every change, so a patch planned earlier would describe
            // lines that have since moved.
            const plan = await planCommit(deps, repo, target);
            if (plan.wholePaths.length === 0 && plan.partials.length === 0) {
              void vscode.window.showInformationMessage(
                vscode.l10n.t('Every change in the ticked files was excluded — nothing to commit.'),
              );
              return false;
            }
            if (plan.stale.length > 0) {
              void vscode.window.showWarningMessage(
                vscode.l10n.t(
                  'Committing {0} whole: its changes moved since they were selected.',
                  plan.stale.join(', '),
                ),
              );
            }
            const untracked = target.untrackedRelPaths.filter((p) => plan.wholePaths.includes(p));
            if (plan.partials.length > 0) {
              await deps.commitService.commitChangelistPartial(
                repo,
                plan.wholePaths,
                plan.partials,
                message,
                { amend, sign },
              );
            } else {
              await deps.commitService.commitChangelist(
                repo,
                plan.wholePaths,
                untracked,
                message,
                { amend, sign },
              );
            }
          } else {
            await deps.commitService.commitStaged(repo, message, { amend, sign }, commitAll);
          }
        } catch (err) {
          if (err instanceof GitError) {
            const gpg = describeGpgFailure(err.stderr);
            if (gpg !== undefined) {
              void vscode.window.showErrorMessage(gpg);
              return false;
            }
          }
          throw err;
        }
        return true;
      } finally {
        tokenSub.dispose();
        source.dispose();
      }
    },
  );

  if (committed) await postCommit(deps, repo, message, options.andPush === true);
  return committed;
}

async function postCommit(
  deps: CommitFlowDeps,
  repo: RepoHandle,
  message: string,
  andPush: boolean,
): Promise<void> {
  const inputBox = deps.inputBoxFor(repo);
  if (inputBox) inputBox.value = '';
  await deps.history.push(repo, message);
  await repo.refresher.refreshNow();
  if (andPush) {
    await vscode.commands.executeCommand('gittree.push', repo.root);
  }
}
