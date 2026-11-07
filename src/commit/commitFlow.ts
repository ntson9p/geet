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
import { committedMessage } from '../scm/resultMessages';
import { confirmModal } from '../ui/confirm';
import { pathListDetail } from '../ui/pathList';
import { excludedFromMergeCommit, hasUnresolvedConflicts } from './mergeCommitChecks';
import { notifySuccess } from '../ui/notify';
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
import { runDeferredChecks, type CommitOptionsStore, type DeferredChecksOutcome } from './window/options';

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
  /** P11-T5: author override + sign-off + deferred-checks mode. */
  options?: CommitOptionsStore;
  /** P11-T5: test seam — hands out the deferred post-commit check run. */
  onDeferredChecks?: (run: Promise<DeferredChecksOutcome | undefined>) => void;
}

interface CommitTarget {
  /** Tracked paths for --only (changelists) or [] (staged). */
  relPaths: string[];
  untrackedRelPaths: string[];
  /** Absolute uris fed to the check pipeline. */
  uris: vscode.Uri[];
  mode: 'changelists' | 'staged';
}

/**
 * The slice of the deps that decides *what* a repository would commit. Narrow
 * on purpose: the commit window needs this much and has no pipeline or
 * history, and `CommitFlowDeps` still satisfies it structurally.
 */
export type CommitScopeDeps = Pick<CommitFlowDeps, 'paradigm' | 'changelistsFor'>;

function resolveTarget(deps: CommitScopeDeps, repo: RepoHandle, listId?: string): CommitTarget | undefined {
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
 * Would committing this repository right now produce a commit? The commit
 * window's button label and the commit path itself both ask through here, so
 * what the button promises and what the flow does cannot drift apart.
 *
 * Cheap by construction — changelist state and the status snapshot are both in
 * memory — so `buildState()` may call it per repo on every push.
 */
export function hasCommittableChanges(
  deps: CommitScopeDeps,
  repo: RepoHandle,
  listId?: string,
): boolean {
  return resolveTarget(deps, repo, listId) !== undefined;
}

/** A merge waiting for its commit (MERGE_HEAD). */
function mergeInProgress(repo: RepoHandle): boolean {
  return repo.model.snapshot.inProgressOp?.kind === 'merge';
}

/**
 * IntelliJ's `GitUnresolvedMergeCheckProvider`, before anything is committed
 * (POST-QA): unresolved conflicts stop the commit — with changelists they are
 * in no list, so nothing else would — and a merge commit that leaves some of
 * the merging repository's changes out asks first.
 */
async function mergeCommitChecks(
  deps: CommitFlowDeps,
  plans: ReadonlyArray<{ repo: RepoHandle; target: CommitTarget }>,
): Promise<boolean> {
  const nameOf = (r: RepoHandle): string => path.basename(r.root);
  const conflicted = plans.filter(({ repo }) => hasUnresolvedConflicts(repo.model.snapshot.statusEntries));
  const first = conflicted[0];
  if (first !== undefined) {
    const resolve = vscode.l10n.t('Resolve Conflicts…');
    const message =
      plans.length > 1
        ? vscode.l10n.t(
            'Cannot commit changes due to unresolved conflicts in {0}.',
            conflicted.map((p) => nameOf(p.repo)).join(', '),
          )
        : vscode.l10n.t('Cannot commit changes due to unresolved conflicts.');
    void vscode.window.showWarningMessage(message, resolve).then((choice) => {
      if (choice === resolve) void vscode.commands.executeCommand('gittree.conflicts.resolve', first.repo.root);
    });
    return false;
  }
  const excluded: string[] = [];
  for (const { repo, target } of plans) {
    if (target.mode !== 'changelists' || !mergeInProgress(repo)) continue;
    const service = deps.changelistsFor(repo);
    const listed = service.getLists().flatMap((l) => l.files);
    for (const p of excludedFromMergeCommit(listed, target.relPaths, (q) => service.isUntrackedPath(q))) {
      excluded.push(plans.length > 1 ? `${nameOf(repo)}: ${p}` : p);
    }
  }
  if (excluded.length === 0) return true;
  return confirmModal(
    vscode.l10n.t('Are you sure you want to exclude these changed files from merge commit?'),
    pathListDetail(excluded, (n) => vscode.l10n.t('… and {0} more', n)),
    vscode.l10n.t('Commit Anyway'),
  );
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

/**
 * What the commit just made holds: its files and its subject — IntelliJ's
 * commit notification counts the one and quotes the other.
 */
async function headCommitSummary(core: Core, repo: RepoHandle): Promise<{ files: number; subject: string }> {
  const opts = { structured: true, allowNonZeroExit: true } as const;
  const subject = await core.git.exec(repo.root, ['log', '-1', '--format=%s', 'HEAD'], opts);
  const parent = await core.git.exec(repo.root, ['rev-parse', '--verify', '--quiet', 'HEAD^1'], opts);
  const files = await core.git.exec(
    repo.root,
    parent.exitCode === 0
      ? ['diff', '--name-only', '-z', 'HEAD^1', 'HEAD']
      : ['diff-tree', '--root', '-r', '--no-commit-id', '--name-only', '-z', 'HEAD'],
    opts,
  );
  return {
    files: files.exitCode === 0 ? files.stdout.split('\0').filter((p) => p.length > 0).length : 0,
    subject: subject.exitCode === 0 ? subject.stdout.trim() : '',
  };
}

export async function runCommitFlow(
  deps: CommitFlowDeps,
  repo: RepoHandle,
  options: {
    listId?: string;
    andPush?: boolean;
    message?: string;
    /**
     * `false` leaves the *N files committed* notification to the caller — the
     * multi-root commit, which says it once for every repository together.
     */
    notify?: boolean;
    /** The commit landed: the files it holds and its subject. */
    onCommitted?: (files: number, subject: string) => void;
    /** The multi-root commit asked the merge checks for every repository at once. */
    mergeChecked?: boolean;
  } = {},
): Promise<boolean> {
  const inputBox = deps.inputBoxFor(repo);
  // `options.message` is the multi-root path handing down the one message the
  // user actually typed. Message boxes are per repo, so without it every
  // repository but the active one would be rejected for having an empty one.
  const message = options.message ?? inputBox?.value.trim() ?? '';
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
  if (options.mergeChecked !== true && !(await mergeCommitChecks(deps, [{ repo, target }]))) return false;

  const sign = await deps.commitService.isSignEnabled(repo);
  // P11-T5: gear-popup options. Advanced checks (Analyze/TODO) move to a
  // post-commit report when deferAdvanced is on — IntelliJ's default shape.
  const author = deps.options?.getAuthor(repo);
  const signoff = deps.options?.isSignoffEnabled() ?? false;
  const deferAdvanced = deps.options?.isDeferAdvancedEnabled() ?? false;
  const commitOptions = { amend, sign, signoff, ...(author !== undefined ? { author } : {}) };

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
        const outcome = await deps.pipeline.run(
          {
            repo,
            files: target.uris,
            token: source.token,
            progress: (step) => progress.report({ message: step }),
          },
          { skipAdvanced: deferAdvanced },
        );
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
            // POST-QA: git refuses `commit --only <paths>` during a merge
            // ("cannot do a partial commit during a merge"), so the window
            // could not finish one. HEAD plus the ticked changes, committed
            // without a pathspec, is the merge commit — MERGE_HEAD its second
            // parent — as IntelliJ commits a merge's included changes.
            if (plan.partials.length > 0 || mergeInProgress(repo)) {
              await deps.commitService.commitChangelistPartial(
                repo,
                plan.wholePaths,
                plan.partials,
                message,
                commitOptions,
              );
            } else {
              await deps.commitService.commitChangelist(
                repo,
                plan.wholePaths,
                untracked,
                message,
                commitOptions,
              );
            }
          } else {
            await deps.commitService.commitStaged(repo, message, commitOptions, commitAll);
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

  if (committed) {
    await postCommit(deps, repo, message);
    // IntelliJ's commit result (`vcs.commit.files.committed`): what went in.
    const summary = await headCommitSummary(deps.core, repo);
    options.onCommitted?.(summary.files, summary.subject);
    if (options.notify !== false) notifySuccess(committedMessage(summary.files, summary.subject));
    if (options.andPush === true) await pushAfterCommit([repo]);
    if (deferAdvanced) {
      // Fire-and-forget by design: the commit is done and the flow must not
      // block on a diagnostics quiesce. The notification carries the findings.
      const run = runDeferredChecks(deps.pipeline, deps.core, repo, target.uris).catch(() => undefined);
      deps.onDeferredChecks?.(run);
    }
  }
  return committed;
}

/**
 * IntelliJ's multi-root commit: one message, one commit per repository that
 * has something to commit.
 *
 * Delegates straight to `runCommitFlow` whenever the answer is a single
 * repository, so the single-root path — every existing caller, command and
 * test — keeps byte-identical behaviour, including the staging paradigm's
 * "nothing staged, commit all?" offer. That offer is deliberately *not*
 * extended across repositories: "commit everything in five repos" is not a
 * question a modal should be asking.
 *
 * `messageRepo` owns the message box and the amend flag — the repo the commit
 * window's editor is currently bound to.
 *
 * `options.lists` narrows the run to one changelist per repository, keyed by
 * canonical root — what "Commit this changelist" means on a group row that
 * stands for the same list in several repositories. Without it every repo with
 * anything ticked takes part.
 */
export async function runCommitAcross(
  deps: CommitFlowDeps,
  messageRepo: RepoHandle,
  options: { andPush?: boolean; lists?: ReadonlyMap<string, string> } = {},
): Promise<boolean> {
  const nameOf = (r: RepoHandle): string => path.basename(r.root);
  const typedMessage = (): string => deps.inputBoxFor(messageRepo)?.value.trim() ?? '';
  const { lists } = options;
  const listOf = (r: RepoHandle): string | undefined => lists?.get(canonicalKey(r.root));
  /** Per-repo flow options. Built explicitly so `lists` never leaks through. */
  const optionsFor = (r: RepoHandle): { andPush?: boolean; listId?: string } => {
    const listId = listOf(r);
    return {
      ...(options.andPush !== undefined ? { andPush: options.andPush } : {}),
      ...(listId !== undefined ? { listId } : {}),
    };
  };

  /**
   * Commits exactly one repository. When it is not the one the editor is bound
   * to, the message the user typed is sitting in `messageRepo`'s box — reading
   * this repo's own would reject the commit for an empty message that is not
   * empty anywhere the user can see. An empty one falls through to
   * `runCommitFlow`'s own diagnostics rather than being second-guessed here.
   */
  const commitOne = async (repo: RepoHandle): Promise<boolean> => {
    const per = optionsFor(repo);
    if (repo === messageRepo) return runCommitFlow(deps, repo, per);
    const typed = typedMessage();
    const ok = await runCommitFlow(deps, repo, typed.length > 0 ? { ...per, message: typed } : per);
    if (ok) clearTypedMessage(deps, messageRepo);
    return ok;
  };

  // Scoped to one changelist per repo, or every repo with anything ticked.
  const candidates =
    lists === undefined
      ? deps.core.repos
      : deps.core.repos.filter((r) => lists.has(canonicalKey(r.root)));
  const participants = candidates.filter((r) => hasCommittableChanges(deps, r, listOf(r)));
  // With none, `messageRepo` reproduces today's diagnostics ("No checked files
  // to commit", the staging commit-all offer, …).
  if (participants.length <= 1) return commitOne(participants[0] ?? messageRepo);

  // Amend stays single-repo. Amending N repositories from one checkbox rewrites
  // N histories on one gesture and has no IntelliJ equivalent — but scoping it
  // silently is the exact trap this work exists to remove.
  //
  // Checked across every participant, not just `messageRepo`: amend is per repo
  // and `gittree.commit.toggleAmend <root>` can arm it on one the editor is not
  // bound to. Without this the spanning loop below would reach that repo with
  // amend still armed and rewrite its history as part of a plain commit.
  const amending = deps.commitService.isAmend(messageRepo)
    ? messageRepo
    : participants.find((r) => deps.commitService.isAmend(r));
  if (amending !== undefined) {
    const others = participants.filter((r) => r !== amending).map(nameOf);
    const ok = await confirmModal(
      vscode.l10n.t('Amend only rewrites {0}.', nameOf(amending)),
      vscode.l10n.t(
        'Ticked changes in {0} will not be committed. Untick Amend to commit every repository instead.',
        others.join(', '),
      ),
      vscode.l10n.t('Amend {0}', nameOf(amending)),
    );
    if (!ok) return false;
    return commitOne(amending);
  }

  const message = typedMessage();
  if (message.length === 0) {
    void vscode.window.showWarningMessage(vscode.l10n.t('Enter a commit message first.'));
    return false;
  }

  // The message-owning repo goes first: if a later one stops the run, the repo
  // the user was actually looking at is the one that made it in.
  const ordered = participants.includes(messageRepo)
    ? [messageRepo, ...participants.filter((r) => r !== messageRepo)]
    : participants;

  // Asked once for every repository, before any of them commits: a conflict
  // in the third must not leave the first two committed (IntelliJ runs its
  // checks over the whole commit).
  const plans = ordered.flatMap((repo) => {
    const target = resolveTarget(deps, repo, listOf(repo));
    return target !== undefined ? [{ repo, target }] : [];
  });
  if (!(await mergeCommitChecks(deps, plans))) return false;

  // POST-P14ah: the push waits for every commit, so that it is one step —
  // IntelliJ's push-after-commit is one Push dialog for all the repositories
  // committed, not a dialog (or a push) per repository as each one lands.
  const andPush = options.andPush === true;
  const landed: RepoHandle[] = [];
  // One notification for the whole commit, as IntelliJ counts every
  // repository's files in one — not one per repository as each lands.
  let filesCommitted = 0;
  for (const repo of ordered) {
    const listId = listOf(repo);
    const ok = await runCommitFlow(deps, repo, {
      ...(listId !== undefined ? { listId } : {}),
      message,
      notify: false,
      mergeChecked: true,
      onCommitted: (files) => {
        filesCommitted += files;
      },
    });
    if (!ok) {
      // Stop rather than carry on: a refused check or a cancelled dialog is a
      // decision about this commit, and committing the rest anyway would be
      // the opposite of what was just asked for. Say what already landed —
      // those commits are real and cannot be quietly implied away.
      if (landed.length > 0) {
        void vscode.window.showWarningMessage(
          vscode.l10n.t(
            'Committed {0}. Stopped at {1}; the remaining repositories were left untouched.',
            landed.map(nameOf).join(', '),
            nameOf(repo),
          ),
        );
      }
      // What did land is still pushed — or offered in the dialog — as it was
      // when each repository pushed straight after its own commit.
      if (andPush) await pushAfterCommit(landed);
      return false;
    }
    landed.push(repo);
  }
  // Each repo's own post-commit cleared its own box; if the message box the
  // user typed into belongs to a repo that committed nothing, it still holds
  // the text of a commit that has already happened.
  clearTypedMessage(deps, messageRepo);
  notifySuccess(committedMessage(filesCommitted, message));
  if (andPush) await pushAfterCommit(landed);
  return true;
}

/**
 * "and Push", once the commits have landed (POST-P14ah): IntelliJ's
 * push-after-commit — the Push dialog for the repositories just committed,
 * or, with `gittree.push.showDialogForCommitAndPush` off, the push itself.
 * The push module decides which; the dialog is not waited for.
 */
async function pushAfterCommit(repos: readonly RepoHandle[]): Promise<void> {
  if (repos.length === 0) return;
  await vscode.commands.executeCommand(
    'gittree.push.afterCommit',
    repos.map((r) => r.root),
  );
}

/**
 * Empties the box the user typed into when its own repo's post-commit never
 * ran. Idempotent — clearing an already-empty box is a no-op echo.
 */
function clearTypedMessage(deps: CommitFlowDeps, repo: RepoHandle): void {
  const box = deps.inputBoxFor(repo);
  if (box && box.value.length > 0) box.value = '';
}

async function postCommit(deps: CommitFlowDeps, repo: RepoHandle, message: string): Promise<void> {
  const inputBox = deps.inputBoxFor(repo);
  if (inputBox) inputBox.value = '';
  await deps.history.push(repo, message);
  await repo.refresher.refreshNow();
}
