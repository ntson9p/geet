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
import type { Core, RepoHandle } from '../../core/core';
import { canonicalKey } from '../../core/repoDiscovery';
import { registerWorktrees, type WorktreeRegistry } from '../../branches/worktrees';
import { registerOperationsPopup } from '../../ui/operationsPopup';
import {
  applyPushResult,
  buildPushParams,
  pushDialogHandlers,
  showPushDialog,
  type PushDialogDeps,
} from './pushDialog';
import {
  applyUpdateResult,
  buildUpdateParams,
  configureUpdateStrategy,
  currentUpdateStrategy,
  reportUpdate,
  setUpdateStrategy,
  showUpdateDialog,
  type UpdateOutcome,
} from './updateDialog';
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
  UpdateDialogResultDto,
} from '../../shared/protocol';

export interface Phase13Registry {
  /** Test seam: the params the dialog would open with. */
  buildPushParams: typeof buildPushParams;
  /** Test seam: the accept half, driven with the payload the webview posts. */
  applyPushResult: (result: Parameters<typeof applyPushResult>[1]) => Promise<string[]>;
  /** Test seam: the request handlers the dialog registers, verbatim. */
  pushHandlers: () => Record<string, (params: unknown) => unknown>;
  /** P13-T2 test seams. */
  buildUpdateParams: (repo: RepoHandle) => ReturnType<typeof buildUpdateParams>;
  applyUpdateResult: (repo: RepoHandle, result: UpdateDialogResultDto) => Promise<UpdateOutcome>;
  showUpdateDialog: (repo: RepoHandle) => Promise<UpdateOutcome | undefined>;
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
}

/** The repo a dialog acts on: an explicit argument, else the active editor's, else the only one. */
export function resolveRepo(core: Core, arg?: unknown): RepoHandle | undefined {
  if (typeof arg === 'string' && arg.length > 0) {
    const byArg = core.repos.find((r) => canonicalKey(r.root) === canonicalKey(arg));
    if (byArg) return byArg;
  }
  if (arg instanceof vscode.Uri) {
    const byUri = core.repoForPath(arg.fsPath);
    if (byUri) return byUri;
  }
  const doc = vscode.window.activeTextEditor?.document;
  if (doc && doc.uri.scheme === 'file') {
    const byEditor = core.repoForPath(doc.uri.fsPath);
    if (byEditor) return byEditor;
  }
  return core.repos.length === 1 ? core.repos[0] : undefined;
}

export function registerPhase13Dialogs(
  context: vscode.ExtensionContext,
  core: Core,
): Phase13Registry {
  const trace = (line: string): void => core.output.appendLine(`[dialogs] ${line}`);
  const deps: PushDialogDeps = { core, extensionUri: context.extensionUri, trace };

  // P13-T1: Push. `gittree.sync.push` (P1) stays as the no-questions path; this
  // is the dialog that exposes the flags behind it.
  context.subscriptions.push(
    vscode.commands.registerCommand('gittree.push.dialog', async (arg?: unknown) => {
      const one = resolveRepo(core, arg);
      // No unambiguous repo: offer every pushable repo at once, which is also
      // the multi-repo shape the dialog is built for.
      await showPushDialog(deps, one ? [one] : core.repos);
    }),
  );

  // P13-T2: Update Project. `gittree.pull` (P1) stays as the raw pull; this is
  // Ctrl+T's dialog, and it runs directly once the user ticks Do not show again.
  context.subscriptions.push(
    vscode.commands.registerCommand('gittree.update.dialog', async (arg?: unknown) => {
      const repo = resolveRepo(core, arg);
      if (!repo) {
        void vscode.window.showInformationMessage(
          vscode.l10n.t('Open a repository to update.'),
        );
        return;
      }
      await showUpdateDialog(deps, repo);
    }),
    // The "gear" that brings the dialog back after Do not show again.
    vscode.commands.registerCommand('gittree.update.configure', async () => {
      await configureUpdateStrategy();
    }),
  );

  // P13-T3: the four "Modify options" dialogs. The P1/P2/P5 no-questions
  // commands stay; these are the surfaces that expose the flags behind them.
  const opDeps: OpDialogDeps = deps;
  const needRepo = (arg?: unknown): RepoHandle | undefined => {
    const repo = resolveRepo(core, arg);
    if (!repo) {
      void vscode.window.showInformationMessage(vscode.l10n.t('Open a repository first.'));
    }
    return repo;
  };
  context.subscriptions.push(
    vscode.commands.registerCommand('gittree.merge.dialog', async (arg?: unknown) => {
      const repo = needRepo(arg);
      if (repo) await showMergeDialog(opDeps, repo);
    }),
    vscode.commands.registerCommand('gittree.rebase.dialog', async (arg?: unknown) => {
      const repo = needRepo(arg);
      if (repo) await showRebaseDialog(opDeps, repo);
    }),
    vscode.commands.registerCommand('gittree.reset.dialog', async (arg?: unknown) => {
      const repo = needRepo(arg);
      if (!repo) return;
      // Invoked from a log row, the clicked commit seeds the revision field.
      const seed =
        arg !== null && typeof arg === 'object' && 'sha' in arg ? String(arg.sha) : undefined;
      await showResetDialog(opDeps, repo, seed);
    }),
    vscode.commands.registerCommand('gittree.rollback.dialog', async (arg?: unknown) => {
      const repo = needRepo(arg);
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
      const repo = needRepo(arg);
      if (!repo) return;
      const seed =
        arg !== null && typeof arg === 'object' && 'sha' in arg ? [String(arg.sha)] : undefined;
      await showCherryPickDialog(opDeps, repo, seed);
    }),
    vscode.commands.registerCommand('gittree.stash.dialog', async (arg?: unknown) => {
      const repo = needRepo(arg);
      if (repo) await showStashDialog(opDeps, repo);
    }),
    vscode.commands.registerCommand('gittree.unstash.dialog', async (arg?: unknown) => {
      const repo = needRepo(arg);
      if (repo) await showUnstashDialog(unstashDeps, repo);
    }),
    vscode.commands.registerCommand('gittree.patch.applyDialog', async (arg?: unknown) => {
      const repo = needRepo(arg);
      if (!repo) return;
      const seed = arg instanceof vscode.Uri ? arg.fsPath : undefined;
      await showApplyPatchDialog(opDeps, repo, seed);
    }),
    // Clone is the one dialog that works with no repository open.
    vscode.commands.registerCommand('gittree.clone.dialog', async () => {
      await showCloneDialog(opDeps);
    }),
    vscode.commands.registerCommand('gittree.remotes.manage', async (arg?: unknown) => {
      const repo = needRepo(arg);
      if (repo) await showRemotesDialog(opDeps, repo);
    }),
  );

  // P13-T6: worktree management — the view, its commands, and the New Worktree
  // dialog that the T5 branch submenu's `New Worktree from 'X'…` will call.
  const worktrees = registerWorktrees(context, core, deps);

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
    buildPushParams,
    applyPushResult: (result) => applyPushResult(deps, result),
    pushHandlers: () => pushDialogHandlers(deps),
    buildUpdateParams: (repo) => buildUpdateParams(core, repo),
    applyUpdateResult: (repo, result) => applyUpdateResult(deps, repo, result),
    showUpdateDialog: (repo) => showUpdateDialog(deps, repo),
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
  };
  core.debugRegistry.set('phase13', registry);
  return registry;
}
