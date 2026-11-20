/**
 * Phase 13 registration: the option-bearing dialogs that replace the
 * QuickPick/InputBox chains standing in for IntelliJ's dialogs (gap analysis
 * S4), plus the popups and the action hub that follow in T5–T7.
 *
 * Own entry point rather than an addition to `registerPhase01`: P13 spans SCM,
 * branches and merge surfaces, so hanging it off any single earlier phase would
 * misfile it. `extension.ts` stays append-only per master §0.6.
 */
import * as vscode from 'vscode';
import { askRepo, chooseRepo, implicitRepo } from '../../ui/chooseRepo';
import type { Core, RepoHandle } from '../../core/core';
import { canonicalKey } from '../../core/repoDiscovery';
import { registerWorktrees, type WorktreeRegistry } from '../../branches/worktrees';
import { registerOperationsPopup } from '../../ui/operationsPopup';
import { repoRootOf } from '../../ui/rowContext';
import {
  applyConflictsResult,
  buildConflictsParams,
  conflictsDialogEnabled,
  showConflictsDialog,
} from '../../merge/conflictsDialog';
import type { ConflictSession } from '../../merge/conflictSession';
import { presentGitError } from '../../hardening/errorUx';
import {
  applyPushResult,
  buildPushParams,
  clearLastPushDialogRequest,
  isPushDialogOn,
  lastPushDialogOpened,
  lastPushDialogRequest,
  planPushWithoutDialog,
  pushDialogHandlers,
  pushDialogNeedText,
  setPushDialogOn,
  setShowPushDialogForCommitAndPush,
  showPushDialog,
  showPushDialogForCommitAndPush,
  type PushDialogDeps,
  type PushDialogRequest,
} from './pushDialog';
import {
  clearLastPushRejectedPrompt,
  lastPushRejectedPrompt,
  pushAndReport,
  setAutoUpdateIfRejected,
  setUpdateAllRepositoriesIfRejected,
  upstreamPushTarget,
  type PushResult,
} from './pushRun';
import {
  applyUpdateResult,
  buildUpdatePrompt,
  clearLastUpdatePrompt,
  configureUpdateStrategy,
  currentUpdateStrategy,
  lastUpdatePrompt,
  rememberedUpdateStrategy,
  reportUpdate,
  runRememberedUpdate,
  runTitle,
  setUpdateStrategy,
  scopeAsLastFetched,
  scopeWithoutFetch,
  showProjectUpdate,
  showUpdateDialog,
  unreachableWithUpstream,
  UPDATE_REPOSITORY_COMMAND,
  UPDATE_REPOSITORY_WITHOUT_FETCH_COMMAND,
  UPDATE_WITHOUT_FETCH_COMMAND,
  type ProjectUpdateResult,
  type UpdateDialogDeps,
  type UpdateOutcome,
  type UpdatePrompt,
  type UpdateRequest,
} from './updateDialog';
import type { UpdateCovers } from './updateReport';
import {
  applyMergeResult,
  applyRebaseResult,
  applyResetResult,
  applyRollbackResult,
  buildMergeParams,
  buildRebaseParams,
  buildResetParams,
  buildRollbackParams,
  rollbackFileDiff,
  showMergeDialog,
  showRebaseDialog,
  showResetDialog,
  showRollbackDialog,
  type OpDialogDeps,
  type OpOutcome,
} from './opsDialogs';
import {
  applyCherryPickResult,
  applyCloneResult,
  applyPatchResult,
  applyStashResult,
  applyUnstashResult,
  buildCherryPickParams,
  buildPatchParams,
  buildRemotesParams,
  buildStashParams,
  buildUnstashParams,
  checkCloneDirectory,
  listRemoteRows,
  remotesHandlers,
  showApplyPatchDialog,
  showCherryPickDialog,
  showCloneDialog,
  showRemotesDialog,
  showStashDialog,
  showUnstashDialog,
  unstashFiles,
  type UnstashDeps,
} from './moreDialogs';
import type {
  ApplyPatchDialogResultDto,
  CherryPickDialogResultDto,
  CloneDialogResultDto,
  MergeDialogResultDto,
  RebaseDialogResultDto,
  ResetDialogResultDto,
  RollbackDialogResultDto,
  StashDialogResultDto,
  UnstashDialogResultDto,
} from '../../shared/protocol';
import { showInfo } from '../../ui/notices';

export interface Phase13Registry {
  /** Test seam: the params the dialog would open with. */
  buildPushParams: (request: PushDialogRequest) => ReturnType<typeof buildPushParams>;
  /** Test seam: the accept half, driven with the payload the webview posts. */
  applyPushResult: (result: Parameters<typeof applyPushResult>[1]) => Promise<string[]>;
  /** Test seam: the request handlers the dialog registers, verbatim. */
  pushHandlers: () => Record<string, (params: unknown) => unknown>;
  /** POST-P14af: the Push Rejected question most recently put, and its reset. */
  lastPushRejectedPrompt: typeof lastPushRejectedPrompt;
  clearLastPushRejectedPrompt: typeof clearLastPushRejectedPrompt;
  /** What `Don't Ask Again` on a pushed-after-update result writes. */
  setAutoUpdateIfRejected: typeof setAutoUpdateIfRejected;
  /** IntelliJ's `Update all repositories`, as a setting (D32). */
  setUpdateAllRepositoriesIfRejected: typeof setUpdateAllRepositoriesIfRejected;
  /**
   * `gittree.push.run` for `repo`'s checked-out branch, with `Update all
   * repositories` narrowed to `project` — the shared fixture repositories
   * track remotes other suites have long deleted.
   */
  pushTracked: (
    repo: RepoHandle,
    project?: readonly RepoHandle[],
  ) => Promise<PushResult[] | undefined>;
  /** POST-P14ah: the repositories the Push dialog was last opened for, and its reset. */
  lastPushDialogRequest: typeof lastPushDialogRequest;
  /** POST-P14ao: all of it — every listed repository, and what each row pushes. */
  lastPushDialogOpened: typeof lastPushDialogOpened;
  clearLastPushDialogRequest: typeof clearLastPushDialogRequest;
  /** IntelliJ's *Show Push dialog for Commit and Push*. */
  setShowPushDialogForCommitAndPush: typeof setShowPushDialogForCommitAndPush;
  /** POST-P14cn: `gittree.push.showDialog`, what the footer's `Don't show this dialog again` writes. */
  setPushDialogOn: typeof setPushDialogOn;
  /** POST-P14cn: what a Push without the dialog would do for `request`, without doing it. */
  planPushWithoutDialog: (request: PushDialogRequest) => ReturnType<typeof planPushWithoutDialog>;
  /** P13-T2 test seams. POST-P14ab: the question is a native modal now. */
  buildUpdatePrompt: (repo: RepoHandle) => Promise<UpdatePrompt | undefined>;
  /** POST-P14ae: the question and the run for a whole project. */
  buildProjectPrompt: (repos: readonly RepoHandle[]) => Promise<UpdatePrompt | undefined>;
  /** POST-P14bm: the question Update Project Without Fetching would put for `repos`. */
  buildPromptWithoutFetch: (repos: readonly RepoHandle[]) => Promise<UpdatePrompt | undefined>;
  /** POST-P14bx: `covers: 'named'` is some of the project, titled by them. */
  showProjectUpdate: (
    repos: readonly RepoHandle[],
    options?: { readonly fetch?: boolean; readonly covers?: UpdateCovers },
  ) => Promise<ProjectUpdateResult | undefined>;
  /** POST-P14bm: what a project run's `Update Without Fetching` would update. */
  unreachableWithUpstream: typeof unreachableWithUpstream;
  /** The question most recently put to the user — what the modal showed. */
  lastUpdatePrompt: typeof lastUpdatePrompt;
  clearLastUpdatePrompt: typeof clearLastUpdatePrompt;
  /** The strategy an update that asks nothing would use right now. */
  rememberedUpdateStrategy: () => ReturnType<typeof rememberedUpdateStrategy>;
  applyUpdateResult: (repo: RepoHandle, result: UpdateRequest) => Promise<UpdateOutcome>;
  showUpdateDialog: (
    repo: RepoHandle,
    options?: { readonly fetch?: boolean },
  ) => Promise<UpdateOutcome | undefined>;
  reportUpdate: typeof reportUpdate;
  /** The gear's persistence half, and what Ctrl+T would do right now. */
  currentUpdateStrategy: typeof currentUpdateStrategy;
  setUpdateStrategy: typeof setUpdateStrategy;
  /** P13-T3 test seams — params in, accept-half out, for all four dialogs. */
  buildMergeParams: typeof buildMergeParams;
  applyMergeResult: (repo: RepoHandle, result: MergeDialogResultDto) => Promise<OpOutcome>;
  buildRebaseParams: typeof buildRebaseParams;
  applyRebaseResult: (repo: RepoHandle, result: RebaseDialogResultDto) => Promise<OpOutcome>;
  buildResetParams: typeof buildResetParams;
  applyResetResult: (repo: RepoHandle, result: ResetDialogResultDto) => Promise<OpOutcome>;
  buildRollbackParams: typeof buildRollbackParams;
  applyRollbackResult: (repo: RepoHandle, result: RollbackDialogResultDto) => Promise<OpOutcome>;
  rollbackFileDiff: (repo: RepoHandle, relPath: string) => ReturnType<typeof rollbackFileDiff>;
  /** P13-T4 test seams. */
  buildCherryPickParams: (
    repo: RepoHandle,
    seedShas?: readonly string[],
  ) => ReturnType<typeof buildCherryPickParams>;
  applyCherryPickResult: (
    repo: RepoHandle,
    result: CherryPickDialogResultDto,
  ) => Promise<OpOutcome>;
  buildStashParams: (repo: RepoHandle) => ReturnType<typeof buildStashParams>;
  applyStashResult: (repo: RepoHandle, result: StashDialogResultDto) => Promise<OpOutcome>;
  buildUnstashParams: (repo: RepoHandle) => ReturnType<typeof buildUnstashParams>;
  applyUnstashResult: (repo: RepoHandle, result: UnstashDialogResultDto) => Promise<OpOutcome>;
  unstashFiles: (repo: RepoHandle, index: number) => ReturnType<typeof unstashFiles>;
  buildPatchParams: typeof buildPatchParams;
  applyPatchResult: (repo: RepoHandle, result: ApplyPatchDialogResultDto) => Promise<OpOutcome>;
  checkCloneDirectory: typeof checkCloneDirectory;
  applyCloneResult: (result: CloneDialogResultDto) => Promise<OpOutcome>;
  buildRemotesParams: (repo: RepoHandle) => ReturnType<typeof buildRemotesParams>;
  listRemoteRows: (repo: RepoHandle) => ReturnType<typeof listRemoteRows>;
  remotesHandlers: (repo: RepoHandle) => Record<string, (params: unknown) => unknown>;
  /** P13-T6 — worktree management (also exposed under `worktrees`). */
  worktrees: WorktreeRegistry;
  /** P13-T8 test seams for the S7 conflicts gate. */
  buildConflictsParams: typeof buildConflictsParams;
  applyConflictsResult: typeof applyConflictsResult;
  conflictsDialogEnabled: typeof conflictsDialogEnabled;
}

/**
 * The repository an argument names — a root string, or a file Uri — and
 * nothing else: no guess from the active editor. For a command whose
 * no-argument form means something other than "the repository I am looking
 * at" — Update Project, whose no-argument form is the whole project.
 */
export function namedRepo(core: Core, arg?: unknown): RepoHandle | undefined {
  if (typeof arg === 'string' && arg.length > 0) {
    return core.repos.find((r) => canonicalKey(r.root) === canonicalKey(arg));
  }
  if (arg instanceof vscode.Uri) return core.repoForPath(arg.fsPath);
  // POST-P14cb: a Commit-window repository row, `{ repoRoot }`, names its repository too.
  const fromRow = repoRootOf(arg);
  if (fromRow !== undefined) return namedRepo(core, fromRow);
  return undefined;
}

/**
 * The repositories a list argument names (POST-P14bx): the Repositories panel's
 * `⋯` hands the roots of those in view. Undefined when the argument is no list;
 * a root no longer open is left out, and so is one named twice.
 */
export function namedRepos(core: Core, arg?: unknown): RepoHandle[] | undefined {
  if (!Array.isArray(arg)) return undefined;
  const repos: RepoHandle[] = [];
  for (const item of arg) {
    const repo = namedRepo(core, item);
    if (repo !== undefined && !repos.includes(repo)) repos.push(repo);
  }
  return repos;
}

/** The repo a dialog acts on: an explicit argument, else the active editor's, else the only one. */
export function resolveRepo(core: Core, arg?: unknown): RepoHandle | undefined {
  return implicitRepo(core, arg);
}

export function registerPhase13Dialogs(
  context: vscode.ExtensionContext,
  core: Core,
): Phase13Registry {
  const trace = (line: string): void => core.output.appendLine(`[dialogs] ${line}`);
  const deps: PushDialogDeps = { core, extensionUri: context.extensionUri, trace };
  // Update Project also remembers the last Merge/Rebase answer, per workspace.
  const updateDeps: UpdateDialogDeps = { ...deps, state: context.workspaceState };
  // POST-P14af: a push the remote rejects asks that same question, so every
  // push path carries the same state.
  const pushDeps: PushDialogDeps = updateDeps;
  /** A branch — the checked-out one by default — pushed to the branch it tracks. */
  const pushTracked = async (
    repo: RepoHandle,
    branch = repo.model.snapshot.headRef,
    project?: readonly RepoHandle[],
  ): Promise<PushResult[] | undefined> => {
    if (branch === undefined) return undefined;
    const target = await upstreamPushTarget(core, repo, branch);
    if (!target) return undefined;
    return pushAndReport(updateDeps, [target], {
      presentFailure: (err) => presentGitError(context, core, err),
      ...(project !== undefined ? { project } : {}),
    });
  };

  // P13-T1: Push — IntelliJ's `VcsPushDialog`, which every Push of Geet
  // opens (POST-P14ao), unless `gittree.push.showDialog` is off (POST-P14cn).
  // `gittree.push` (P1) stays registered, hidden from the palette, for a
  // keybinding; Geet itself no longer calls it. Sync pushes its own way.
  /** The commit's branch, as `GitPushUpToCommitAction` picks it. */
  const branchHolding = async (repo: RepoHandle, sha: string): Promise<string | undefined> => {
    const snap = repo.model.snapshot;
    // The current branch when the commit is on it, else the first local
    // branch that contains it; none, and the commit is pushed detached.
    if (snap.headRef !== undefined && !snap.detached) {
      const onHead = await core.git.exec(repo.root, ['merge-base', '--is-ancestor', sha, 'HEAD'], {
        structured: true,
        allowNonZeroExit: true,
      });
      if (onHead.exitCode === 0) return snap.headRef;
    }
    const res = await core.git.exec(
      repo.root,
      ['for-each-ref', '--contains', sha, '--format=%(refname:short)', 'refs/heads'],
      { structured: true, allowNonZeroExit: true },
    );
    return res.stdout
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.length > 0);
  };
  const openPush = (request: PushDialogRequest, because?: string): Promise<boolean> =>
    showPushDialog(pushDeps, request, because).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      trace(`push dialog failed: ${message}`);
      void vscode.window.showErrorMessage(
        vscode.l10n.t('The Push dialog could not open: {0}', message),
      );
      return false;
    });
  /**
   * POST-P14cn: a Push as `gittree.push.showDialog` says. On, the dialog. Off,
   * straight away: what the dialog would push had Push been pressed at once,
   * reported as a push of the branch to its upstream is. The dialog opens
   * after all, saying why, for a push that cannot go ahead without it. Resolves
   * true when a push ran; with `waitForDialog` false (Commit and Push) it does
   * not wait for a dialog to close, only for a push.
   */
  const pushAsSet = async (
    request: PushDialogRequest,
    options: { readonly dialog: boolean; readonly waitForDialog: boolean },
  ): Promise<boolean> => {
    const dialog = (because?: string): Promise<boolean> => {
      const shown = openPush(request, because);
      return options.waitForDialog ? shown : Promise.resolve(false);
    };
    if (options.dialog) return dialog();
    try {
      const plan = await planPushWithoutDialog(pushDeps, request);
      if (plan === undefined) {
        showInfo(vscode.l10n.t('There is no repository to push.'));
        return false;
      }
      if (plan.kind === 'dialog') return await dialog(pushDialogNeedText(plan.need));
      const outcomes = await applyPushResult(pushDeps, plan.result, {
        presentFailure: (err) => presentGitError(context, core, err),
      });
      return outcomes.length > 0;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      trace(`push failed: ${message}`);
      void vscode.window.showErrorMessage(vscode.l10n.t('Push failed: {0}', message));
      return false;
    }
  };
  /** Every Push but Commit and Push's: the dialog unless the setting is off. */
  const push = (request: PushDialogRequest): Promise<boolean> =>
    pushAsSet(request, { dialog: isPushDialogOn(), waitForDialog: true });
  context.subscriptions.push(
    vscode.commands.registerCommand('gittree.push.dialog', async (arg?: unknown) => {
      // POST-P14by: a list, the Branches panel's `⋯` with some repositories
      // in view: every repository listed still, as IntelliJ's dialog lists them,
      // and those checked.
      const several = namedRepos(core, arg);
      if (several !== undefined) {
        if (several.length === 0) {
          showInfo(vscode.l10n.t('Nothing to push: those repositories are no longer open.'));
          return;
        }
        await push({ repos: core.repos, preselected: several, current: several[0]! });
        return;
      }
      // IntelliJ's `Push…`: every repository listed; the one named — a
      // Repositories row — checked, else the one the user is in.
      const named = namedRepo(core, arg);
      const current = resolveRepo(core, arg);
      await push({
        repos: core.repos,
        preselected: named !== undefined ? [named] : [],
        ...(current !== undefined ? { current } : {}),
      });
    }),
    // A branch's `Push…` (IntelliJ's `GitPushBranchAction`): that branch, in
    // the repositories named — one, or every one a common branch is in.
    // Internal, called by the branch rows. Resolves once the dialog closes, or
    // without the dialog once the push is done.
    vscode.commands.registerCommand(
      'gittree.push.branch',
      async (arg?: unknown, branchArg?: unknown): Promise<boolean> => {
        const roots: unknown[] = Array.isArray(arg) ? arg : [arg];
        const repos = roots
          .map((root) => namedRepo(core, root))
          .filter((r): r is RepoHandle => r !== undefined);
        if (repos.length === 0 || typeof branchArg !== 'string' || branchArg.length === 0) {
          return false;
        }
        return push({ repos, preselected: repos, source: { kind: 'branch', branch: branchArg } });
      },
    ),
    // `Push All up to Here…` (IntelliJ's `GitPushUpToCommitAction`): the commit
    // and everything before it, from the branch it is on. Internal.
    vscode.commands.registerCommand(
      'gittree.push.upTo',
      async (arg?: unknown, shaArg?: unknown): Promise<boolean> => {
        const repo = namedRepo(core, arg);
        if (!repo || typeof shaArg !== 'string' || shaArg.length === 0) return false;
        const branch = await branchHolding(repo, shaArg);
        return push({
          repos: [repo],
          preselected: [repo],
          current: repo,
          source: { kind: 'revision', sha: shaArg, ...(branch !== undefined ? { branch } : {}) },
        });
      },
    ),
    // POST-P14af: a tracked branch pushed to its upstream, the IntelliJ way —
    // `gittree.push` (so Sync) comes through here; every Push… opens the Push
    // dialog, or pushes as it would (POST-P14cn). Internal, as
    // `gittree.update.run` is. Resolves to what happened, or `undefined` for a
    // branch that tracks nothing, which the caller publishes its own way.
    vscode.commands.registerCommand(
      'gittree.push.run',
      async (arg?: unknown, branchArg?: unknown): Promise<PushResult[] | undefined> => {
        const repo = namedRepo(core, arg);
        if (!repo) return undefined;
        const branch =
          typeof branchArg === 'string' && branchArg.length > 0 ? branchArg : undefined;
        return pushTracked(repo, branch);
      },
    ),
    // POST-P14ah: `Commit and Push…` once its commits have landed — IntelliJ's
    // push-after-commit. With *Show Push dialog for Commit and Push* on (its
    // default) that is the Push dialog, for the repositories just committed;
    // off — or with `gittree.push.showDialog` off (POST-P14cn) — they are
    // pushed straight away, as a Push without the dialog pushes. Internal: the
    // commit flow is the only caller, and hands over every repository it
    // committed at once, so a commit spanning several opens one dialog, or
    // runs one push, not one each.
    vscode.commands.registerCommand('gittree.push.afterCommit', async (arg?: unknown) => {
      const repos = (Array.isArray(arg) ? arg : [])
        .map((root: unknown) => namedRepo(core, root))
        .filter((r): r is RepoHandle => r !== undefined);
      if (repos.length === 0) return;
      // A dialog is not waited for. It is a tab the user may leave open while
      // they read it, and the commit window stays busy — refusing the next
      // commit — for as long as the commit call that got here is running. A
      // push straight away is waited for, as it always was here. Every
      // repository is listed, as IntelliJ lists them; the ones just committed
      // are the ones checked, and the ones pushed without the dialog.
      await pushAsSet(
        { repos: core.repos, preselected: repos, current: repos[0]! },
        { dialog: isPushDialogOn() && showPushDialogForCommitAndPush(), waitForDialog: false },
      );
    }),
  );

  /**
   * POST-P14bx: some of the project, titled by them. One left is that
   * repository's own update; none left (each since closed) is said, not taken
   * for the whole project.
   */
  const updateNamed = async (repos: readonly RepoHandle[], fetch: boolean): Promise<void> => {
    const only = repos.length === 1 ? repos[0] : undefined;
    if (only !== undefined) {
      await showUpdateDialog(updateDeps, only, { fetch });
    } else if (repos.length === 0) {
      showInfo(vscode.l10n.t('Nothing to update: those repositories are no longer open.'));
    } else {
      await showProjectUpdate(updateDeps, repos, { fetch, covers: 'named' });
    }
  };

  // P13-T2: Update Project. `gittree.pull` (P1) stays as the raw pull; this is
  // Ctrl+T's question (a native modal since POST-P14ab, D30), and it runs
  // directly once the user chooses Don't Ask Again.
  context.subscriptions.push(
    vscode.commands.registerCommand('gittree.update.dialog', async (arg?: unknown) => {
      // POST-P14bx: a list of repositories, the Branches panel's `⋯` with
      // some of them in view, updates those.
      const several = namedRepos(core, arg);
      if (several !== undefined) {
        await updateNamed(several, true);
        return;
      }
      // POST-P14ae: a named repository — a Repositories row — updates just
      // that one. With nothing named this is the *project*, IntelliJ's meaning
      // of Update Project: every repository, after one question. It used to
      // update the active editor's repository, or none at all with no editor
      // open and several repositories in the workspace.
      const repo = namedRepo(core, arg);
      if (repo) {
        await showUpdateDialog(updateDeps, repo);
        return;
      }
      if (core.repos.length === 0) {
        showInfo(
          vscode.l10n.t('Open a repository to update.'),
        );
        return;
      }
      await showProjectUpdate(updateDeps, core.repos);
    }),
    // POST-P14bm: Update Project Without Fetching — the same update, from each
    // remote branch as it was last fetched: instant, and offline. Named, that
    // repository (or those, POST-P14bx); with nothing named, the project, as
    // Update Project is.
    vscode.commands.registerCommand(UPDATE_WITHOUT_FETCH_COMMAND, async (arg?: unknown) => {
      const several = namedRepos(core, arg);
      if (several !== undefined) {
        await updateNamed(several, false);
        return;
      }
      const repo = namedRepo(core, arg);
      if (repo) {
        await showUpdateDialog(updateDeps, repo, { fetch: false });
        return;
      }
      if (core.repos.length === 0) {
        showInfo(vscode.l10n.t('Open a repository to update.'));
        return;
      }
      await showProjectUpdate(updateDeps, core.repos, { fetch: false });
    }),
    // POST-P14bx: one repository's update, under its own name, where Update
    // Project… said "project" and updated that repository alone: a repository's
    // menu (the Repositories panel's and the Repositories (Tree) view's) and its
    // row's button. Named, that repository; with nothing named (a keybinding),
    // which one is asked, the editor's first. Not in the palette.
    vscode.commands.registerCommand(UPDATE_REPOSITORY_COMMAND, async (arg?: unknown) => {
      const repo = await askRepo(core, arg, vscode.l10n.t('Update which repository?'));
      if (repo) await showUpdateDialog(updateDeps, repo);
    }),
    vscode.commands.registerCommand(UPDATE_REPOSITORY_WITHOUT_FETCH_COMMAND, async (arg?: unknown) => {
      const repo = await askRepo(core, arg, vscode.l10n.t('Update which repository, without fetching?'));
      if (repo) await showUpdateDialog(updateDeps, repo, { fetch: false });
    }),
    // POST-P14ad: the half that does not ask — a branch row's `Update` on the
    // checked-out branch. Internal: not contributed, so not in the palette,
    // where `Update Project…` is the verb. Returns the outcome so the caller
    // can tell a fan-out whether to carry on.
    vscode.commands.registerCommand('gittree.update.run', async (arg?: unknown) => {
      const repo = resolveRepo(core, arg);
      return repo ? runRememberedUpdate(updateDeps, repo) : undefined;
    }),
    // The "gear" that brings the question back after Don't Ask Again.
    vscode.commands.registerCommand('gittree.update.configure', async () => {
      await configureUpdateStrategy();
    }),
  );

  // P13-T3: the four "Modify options" dialogs. The P1/P2/P5 no-questions
  // commands stay; these are the surfaces that expose the flags behind them.
  const opDeps: OpDialogDeps = deps;
  // POST-QA F6: with several repositories and nothing to say which, ask —
  // these dialogs have no Git Root chooser of their own, as IntelliJ's do.
  const needRepo = (arg?: unknown): Promise<RepoHandle | undefined> => chooseRepo(core, arg);
  context.subscriptions.push(
    vscode.commands.registerCommand('gittree.merge.dialog', async (arg?: unknown) => {
      const repo = await needRepo(arg);
      if (repo) await showMergeDialog(opDeps, repo);
    }),
    vscode.commands.registerCommand('gittree.rebase.dialog', async (arg?: unknown) => {
      const repo = await needRepo(arg);
      if (repo) await showRebaseDialog(opDeps, repo);
    }),
    vscode.commands.registerCommand('gittree.reset.dialog', async (arg?: unknown) => {
      const repo = await needRepo(arg);
      if (!repo) return;
      // Invoked from a log row, the clicked commit seeds the revision field.
      const seed =
        arg !== null && typeof arg === 'object' && 'sha' in arg ? String(arg.sha) : undefined;
      await showResetDialog(opDeps, repo, seed);
    }),
    vscode.commands.registerCommand('gittree.rollback.dialog', async (arg?: unknown) => {
      // A Commit-window repository row passes `{ repoRoot }`: that repository,
      // every change listed and ticked, for the dialog to untick.
      const repo = await needRepo(repoRootOf(arg) ?? arg);
      if (!repo) return;
      const preselected =
        Array.isArray(arg) && arg.every((a) => typeof a === 'string') ? arg : undefined;
      await showRollbackDialog(opDeps, repo, preselected);
    }),
  );

  // P13-T4: the remaining option-bearing dialogs. `Manage Remotes` had no
  // command at all before this; the others replace QuickPick chains.
  interface ChangelistsSeam {
    getLists(): Array<{ id: string; name: string }>;
    moveFiles(relPaths: readonly string[], targetId: string): void;
  }
  const changelistsFor = (repo: RepoHandle): ChangelistsSeam | undefined => {
    const p3 = core.debugRegistry.get('phase03') as
      | { changelistsFor?: (r: RepoHandle) => ChangelistsSeam }
      | undefined;
    return p3?.changelistsFor?.(repo);
  };
  const unstashDeps: UnstashDeps = {
    ...deps,
    changelists: (repo) => changelistsFor(repo)?.getLists() ?? [],
    assignChangelist: (repo, listId, paths) => {
      changelistsFor(repo)?.moveFiles(paths, listId);
    },
  };
  context.subscriptions.push(
    vscode.commands.registerCommand('gittree.cherryPick.dialog', async (arg?: unknown) => {
      const repo = await needRepo(arg);
      if (!repo) return;
      const seed =
        arg !== null && typeof arg === 'object' && 'sha' in arg ? [String(arg.sha)] : undefined;
      await showCherryPickDialog(opDeps, repo, seed);
    }),
    vscode.commands.registerCommand('gittree.stash.dialog', async (arg?: unknown) => {
      const repo = await needRepo(arg);
      if (repo) await showStashDialog(opDeps, repo);
    }),
    vscode.commands.registerCommand('gittree.unstash.dialog', async (arg?: unknown) => {
      const repo = await needRepo(arg);
      if (repo) await showUnstashDialog(unstashDeps, repo);
    }),
    vscode.commands.registerCommand('gittree.patch.applyDialog', async (arg?: unknown) => {
      const repo = await needRepo(arg);
      if (!repo) return;
      const seed = arg instanceof vscode.Uri ? arg.fsPath : undefined;
      await showApplyPatchDialog(opDeps, repo, seed);
    }),
    // Clone is the one dialog that works with no repository open.
    vscode.commands.registerCommand('gittree.clone.dialog', async () => {
      await showCloneDialog(opDeps);
    }),
    vscode.commands.registerCommand('gittree.remotes.manage', async (arg?: unknown) => {
      const repo = await needRepo(arg);
      if (repo) await showRemotesDialog(opDeps, repo);
    }),
  );

  // P13-T6: worktree management — the view, its commands, and the New Worktree
  // dialog that the T5 branch submenu's `New Worktree from 'X'…` will call.
  const worktrees = registerWorktrees(context, core, deps);

  // P13-T8 · S7: the `Files Merged with Conflicts` gate. IntelliJ gates on the
  // modal; the `gittree.conflicts` tree view stays as the persistent surface,
  // so this fires once per session and can be switched off entirely.
  const p6 = core.debugRegistry.get('phase06') as
    | { lifecycle?: { onDidStartSession: vscode.Event<ConflictSession> } }
    | undefined;
  if (p6?.lifecycle) {
    context.subscriptions.push(
      p6.lifecycle.onDidStartSession((session) => {
        if (!conflictsDialogEnabled()) return;
        void showConflictsDialog(deps, session);
      }),
    );
  }
  // POST-QA: the operation banner's Resolve… — IntelliJ's Resolve link brings
  // the Files Merged with Conflicts dialog back; it used to only focus the
  // Conflicts view, and the dialog, once dismissed, had no way back.
  context.subscriptions.push(
    vscode.commands.registerCommand('gittree.conflicts.resolve', async (arg?: unknown) => {
      const phase06 = core.debugRegistry.get('phase06') as
        | { getSession?: (repoRoot: string) => ConflictSession | undefined }
        | undefined;
      const repo = implicitRepo(core, arg) ?? core.repos.find((r) => phase06?.getSession?.(r.root) !== undefined);
      const session = repo !== undefined ? phase06?.getSession?.(repo.root) : undefined;
      if (session !== undefined && session.remaining > 0) {
        await showConflictsDialog(deps, session);
        return;
      }
      await vscode.commands.executeCommand('gittree.conflicts.focus');
    }),
  );

  // P13-T7: the VCS Operations Popup, enumerated from `dialogRegistry.ts` so it
  // stays complete by construction rather than by a hand-kept list.
  registerOperationsPopup(context, {
    core,
    commitSelected: () => {
      const p4 = core.debugRegistry.get('phase04') as
        | { logView?: { currentSession?: { rowCount: number } } }
        | undefined;
      return (p4?.logView?.currentSession?.rowCount ?? 0) > 0;
    },
  });

  const registry: Phase13Registry = {
    buildPushParams: (request) => buildPushParams(pushDeps, request),
    applyPushResult: (result) => applyPushResult(pushDeps, result),
    pushHandlers: () => pushDialogHandlers(pushDeps),
    lastPushRejectedPrompt,
    clearLastPushRejectedPrompt,
    setAutoUpdateIfRejected,
    setUpdateAllRepositoriesIfRejected,
    pushTracked: (repo, project) => pushTracked(repo, undefined, project),
    lastPushDialogRequest,
    lastPushDialogOpened,
    clearLastPushDialogRequest,
    setShowPushDialogForCommitAndPush,
    setPushDialogOn,
    planPushWithoutDialog: (request) => planPushWithoutDialog(pushDeps, request),
    // The question as it would read against what was fetched last: the real
    // one is only ever built after a fetch. One repository's own, so titled by
    // it, as `showUpdateDialog` titles it (POST-P14bx).
    buildUpdatePrompt: async (repo) =>
      buildUpdatePrompt(
        updateDeps,
        await scopeAsLastFetched(updateDeps, [repo]),
        runTitle(updateDeps, 'named', [repo], false),
      ),
    buildProjectPrompt: async (repos) =>
      buildUpdatePrompt(updateDeps, await scopeAsLastFetched(updateDeps, repos)),
    buildPromptWithoutFetch: async (repos) =>
      buildUpdatePrompt(updateDeps, await scopeWithoutFetch(updateDeps, repos)),
    showProjectUpdate: (repos, options) => showProjectUpdate(updateDeps, repos, options),
    unreachableWithUpstream,
    lastUpdatePrompt,
    clearLastUpdatePrompt,
    rememberedUpdateStrategy: () => rememberedUpdateStrategy(updateDeps.state),
    applyUpdateResult: (repo, result) => applyUpdateResult(updateDeps, repo, result),
    showUpdateDialog: (repo, options) => showUpdateDialog(updateDeps, repo, options),
    reportUpdate,
    currentUpdateStrategy,
    setUpdateStrategy,
    buildMergeParams,
    applyMergeResult: (repo, result) => applyMergeResult(opDeps, repo, result),
    buildRebaseParams,
    applyRebaseResult: (repo, result) => applyRebaseResult(opDeps, repo, result),
    buildResetParams,
    applyResetResult: (repo, result) => applyResetResult(opDeps, repo, result),
    buildRollbackParams,
    applyRollbackResult: (repo, result) => applyRollbackResult(opDeps, repo, result),
    rollbackFileDiff: (repo, relPath) => rollbackFileDiff(core, repo, relPath),
    buildCherryPickParams: (repo, seedShas) => buildCherryPickParams(core, repo, seedShas),
    applyCherryPickResult: (repo, result) => applyCherryPickResult(opDeps, repo, result),
    buildStashParams: (repo) => buildStashParams(core, repo),
    applyStashResult: (repo, result) => applyStashResult(opDeps, repo, result),
    buildUnstashParams: (repo) => buildUnstashParams(unstashDeps, repo),
    applyUnstashResult: (repo, result) => applyUnstashResult(unstashDeps, repo, result),
    unstashFiles: (repo, index) => unstashFiles(core, repo, index),
    buildPatchParams,
    applyPatchResult: (repo, result) => applyPatchResult(opDeps, repo, result),
    checkCloneDirectory,
    applyCloneResult: (result) => applyCloneResult(core, result),
    buildRemotesParams: (repo) => buildRemotesParams(core, repo),
    listRemoteRows: (repo) => listRemoteRows(core, repo),
    remotesHandlers: (repo) => remotesHandlers(opDeps, repo),
    worktrees,
    buildConflictsParams,
    applyConflictsResult,
    conflictsDialogEnabled,
  };
  core.debugRegistry.set('phase13', registry);
  return registry;
}
