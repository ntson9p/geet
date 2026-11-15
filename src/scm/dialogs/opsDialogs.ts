/**
 * Merge · Rebase · Reset · Rollback dialogs, host halves (P13-T3, gap analysis
 * S4). These four are the biggest power-user gap in the audit: GitTree could
 * run all four operations, but every real git flag behind them was unreachable.
 *
 * Each dialog follows the shape T1/T2 settled on — a vscode-free argv builder
 * both halves import, `buildXParams` for the open, and `applyXResult` for the
 * accept, so integration tests drive exactly the payload the webview posts.
 */
import * as path from 'node:path';
import * as vscode from 'vscode';
import { filesCount } from '../../ui/counts';
import type { Core, RepoHandle } from '../../core/core';
import { GitError } from '../../core/git/errors';
import { isStaged, isDirty } from '../../core/model/statusEntry';
import { toBlobEol } from '../../core/patch/eol';
import { computeLineChanges } from '../../core/patch/lineDiff';
import { SNAPSHOT_LABELS } from '../../localHistory/hooks';
import {
  ROLLBACK_DIALOG_METHODS,
  type MergeDialogParamsDto,
  type MergeDialogResultDto,
  type RebaseDialogParamsDto,
  type RebaseDialogResultDto,
  type ResetDialogParamsDto,
  type ResetDialogResultDto,
  type RollbackDialogParamsDto,
  type RollbackDialogResultDto,
  type RollbackFileDiffDto,
  type RollbackFileDto,
} from '../../shared/protocol';
import { confirmModal } from '../../ui/confirm';
import { openDialog } from '../../ui/dialogHost';
import { statusColorOverrides } from '../../ui/statusColors';
import { buildMergeArgs, validateMergeOptions } from './mergeArgs';
import { buildRebaseArgs, validateRebaseOptions } from './rebaseArgs';
import { defaultRef, dialogRefs } from './refs';
import { buildResetArgs, RESET_DEFAULT_REF, resetNeedsConfirm, resetNeedsSnapshot } from './resetArgs';
import {
  isEmptyRollbackPlan,
  planRollback,
  rollbackCommands,
  rollbackKindOf,
  type RollbackFile,
} from './rollbackPlan';
import { showInfo } from '../../ui/notices';

export interface OpDialogDeps {
  core: Core;
  extensionUri: vscode.Uri;
  trace?: (line: string) => void;
}

/** What an operation did — returned so integration tests can assert on it. */
export interface OpOutcome {
  ok: boolean;
  /**
   * It stopped on conflicts: no failure to report, as the conflicts dialog —
   * or, with it off, the conflict session's notice — takes it from here
   * (POST-QA: git's first line came as an error toast besides).
   */
  conflicts?: boolean;
  message: string;
  /** The argv actually run, for the tests and the trace. */
  commands: string[][];
}

function base(repo: RepoHandle): {
  repoRoot: string;
  repoLabel: string;
  currentBranch: string;
  showCommandLine: boolean;
} {
  return {
    repoRoot: repo.root,
    repoLabel: path.basename(repo.root),
    currentBranch: repo.model.snapshot.headRef ?? 'HEAD',
    showCommandLine: vscode.workspace
      .getConfiguration('gittree')
      .get<boolean>('dialogs.showCommandLine', true),
  };
}

function failed(err: unknown, commands: string[][]): OpOutcome {
  const message = err instanceof Error ? err.message : String(err);
  if (err instanceof GitError && err.kind === 'merge-conflict') return { ok: false, conflicts: true, message, commands };
  return { ok: false, message, commands };
}

// ---------------------------------------------------------------------------
// Merge
// ---------------------------------------------------------------------------

export function buildMergeParams(repo: RepoHandle): MergeDialogParamsDto {
  const refs = dialogRefs(repo);
  return { ...base(repo), refs, defaultRef: defaultRef(repo, refs) };
}

export async function applyMergeResult(
  deps: OpDialogDeps,
  repo: RepoHandle,
  result: MergeDialogResultDto,
): Promise<OpOutcome> {
  const errors = validateMergeOptions(result.options);
  if (errors.length > 0) return { ok: false, message: errors.join(' '), commands: [] };
  const args = buildMergeArgs(result.options);
  const current = repo.model.snapshot.headRef ?? 'HEAD';
  try {
    const output = await repo.queue.enqueue({
      label: vscode.l10n.t('Merge {0}', result.options.ref),
      kind: 'mutate',
      isDestructive: true,
      snapshotLabel: SNAPSHOT_LABELS.merge,
      run: async (git, token) => (await git.exec(repo.root, args, { token })).stdout,
    });
    await repo.refresher.refreshNow();
    // IntelliJ's `GitMergeOperation` words: *Merged X to Y*, *Already up to date*.
    return {
      ok: true,
      message: /Already up[ -]to[ -]date/i.test(output)
        ? vscode.l10n.t('Already up to date')
        : result.options.squash
          ? vscode.l10n.t('Squash-merged {0} — staged, not committed.', result.options.ref)
          : vscode.l10n.t('Merged {0} to {1}', result.options.ref, current),
      commands: [args],
    };
  } catch (err) {
    // A conflicted merge is a normal outcome, not a crash: the repo is now in
    // a merge state and P6's conflicts surfaces take over.
    await repo.refresher.refreshNow();
    return failed(err, [args]);
  }
}

export async function showMergeDialog(
  deps: OpDialogDeps,
  repo: RepoHandle,
): Promise<OpOutcome | undefined> {
  const params = buildMergeParams(repo);
  if (params.refs.length === 0) {
    showInfo(vscode.l10n.t('No other branch to merge.'));
    return undefined;
  }
  const result = await openDialog<MergeDialogParamsDto, MergeDialogResultDto>({
    app: 'dialogs',
    dialog: 'merge',
    title: vscode.l10n.t('Merge into {0}', params.currentBranch),
    params,
    extensionUri: deps.extensionUri,
    ...(deps.trace ? { trace: deps.trace } : {}),
  });
  if (!result) return undefined;
  const outcome = await applyMergeResult(deps, repo, result);
  reportOp(outcome);
  return outcome;
}

// ---------------------------------------------------------------------------
// Rebase
// ---------------------------------------------------------------------------

export function buildRebaseParams(repo: RepoHandle): RebaseDialogParamsDto {
  const refs = dialogRefs(repo);
  return { ...base(repo), refs, defaultOnto: defaultRef(repo, refs) };
}

export async function applyRebaseResult(
  deps: OpDialogDeps,
  repo: RepoHandle,
  result: RebaseDialogResultDto,
): Promise<OpOutcome> {
  const errors = validateRebaseOptions(result.options);
  if (errors.length > 0) return { ok: false, message: errors.join(' '), commands: [] };
  // `--interactive` is not run here: P5 already owns a real interactive rebase
  // editor, and shelling out to git's own would open a terminal editor the
  // webview cannot serve.
  if (result.options.interactive) {
    await vscode.commands.executeCommand('gittree.rebase.interactive', {
      repoRoot: repo.root,
      onto: result.options.onto,
      ...(result.options.from.length > 0 ? { from: result.options.from } : {}),
    });
    return {
      ok: true,
      message: vscode.l10n.t('Opened the interactive rebase editor.'),
      commands: [buildRebaseArgs(result.options)],
    };
  }
  const args = buildRebaseArgs(result.options);
  const current = repo.model.snapshot.headRef ?? 'HEAD';
  try {
    await repo.queue.enqueue({
      label: vscode.l10n.t('Rebase onto {0}', result.options.onto),
      kind: 'mutate',
      isDestructive: true,
      snapshotLabel: SNAPSHOT_LABELS.rebaseStart,
      run: async (git, token) => {
        await git.exec(repo.root, args, { token });
      },
    });
    await repo.refresher.refreshNow();
    // IntelliJ's `rebase.notification.successful.rebased.message`.
    return {
      ok: true,
      message: vscode.l10n.t('Rebased {0} on {1}', current, result.options.onto),
      commands: [args],
    };
  } catch (err) {
    await repo.refresher.refreshNow();
    return failed(err, [args]);
  }
}

export async function showRebaseDialog(
  deps: OpDialogDeps,
  repo: RepoHandle,
): Promise<OpOutcome | undefined> {
  const params = buildRebaseParams(repo);
  if (params.refs.length === 0) {
    showInfo(vscode.l10n.t('No other branch to rebase onto.'));
    return undefined;
  }
  const result = await openDialog<RebaseDialogParamsDto, RebaseDialogResultDto>({
    app: 'dialogs',
    dialog: 'rebase',
    title: vscode.l10n.t('Rebase {0}', params.currentBranch),
    params,
    extensionUri: deps.extensionUri,
    ...(deps.trace ? { trace: deps.trace } : {}),
  });
  if (!result) return undefined;
  const outcome = await applyRebaseResult(deps, repo, result);
  reportOp(outcome);
  return outcome;
}

// ---------------------------------------------------------------------------
// Reset
// ---------------------------------------------------------------------------

export function buildResetParams(repo: RepoHandle, seedRef?: string): ResetDialogParamsDto {
  const refs = dialogRefs(repo);
  const entries = repo.model.snapshot.statusEntries;
  return {
    ...base(repo),
    refs,
    defaultRef: seedRef ?? RESET_DEFAULT_REF,
    dirtyCount: entries.filter((e) => isDirty(e) && e.kind !== 'ignored').length,
    stagedCount: entries.filter((e) => isStaged(e)).length,
  };
}

export async function applyResetResult(
  deps: OpDialogDeps,
  repo: RepoHandle,
  result: ResetDialogResultDto,
): Promise<OpOutcome> {
  const args = buildResetArgs({ ref: result.ref, mode: result.mode });
  if (result.ref.trim().length === 0) {
    return { ok: false, message: vscode.l10n.t('Enter a revision to reset to.'), commands: [] };
  }
  if (resetNeedsConfirm(result.mode)) {
    const ok = await confirmModal(
      vscode.l10n.t('Hard reset to {0}?', result.ref),
      vscode.l10n.t('Uncommitted changes are discarded. A Local History snapshot is taken first.'),
      vscode.l10n.t('Reset Hard'),
    );
    if (!ok) return { ok: false, message: vscode.l10n.t('Reset cancelled.'), commands: [] };
  }
  try {
    await repo.queue.enqueue({
      label: vscode.l10n.t('Reset ({0}) to {1}', result.mode, result.ref),
      kind: 'mutate',
      isDestructive: resetNeedsSnapshot(result.mode),
      ...(resetNeedsSnapshot(result.mode)
        ? { snapshotLabel: SNAPSHOT_LABELS.reset, snapshotAfter: true }
        : {}),
      run: async (git, token) => {
        await git.exec(repo.root, args, { token });
      },
    });
    await repo.refresher.refreshNow();
    // IntelliJ's `git.reset.successful.notification.message`, as Reset Here says it.
    return { ok: true, message: vscode.l10n.t('Reset successful'), commands: [args] };
  } catch (err) {
    await repo.refresher.refreshNow();
    // `--keep` refusing is the mode working as designed — surface git's reason.
    if (result.mode === 'keep' && err instanceof GitError) {
      const reason =
        err.stderr.split('\n').find((l) => l.trim().length > 0) ?? 'local changes would be lost';
      return {
        ok: false,
        message: vscode.l10n.t('Reset --keep refused: {0}', reason),
        commands: [args],
      };
    }
    return failed(err, [args]);
  }
}

export async function showResetDialog(
  deps: OpDialogDeps,
  repo: RepoHandle,
  seedRef?: string,
): Promise<OpOutcome | undefined> {
  const params = buildResetParams(repo, seedRef);
  const result = await openDialog<ResetDialogParamsDto, ResetDialogResultDto>({
    app: 'dialogs',
    dialog: 'reset',
    title: vscode.l10n.t('Reset {0}', params.currentBranch),
    params,
    extensionUri: deps.extensionUri,
    ...(deps.trace ? { trace: deps.trace } : {}),
  });
  if (!result) return undefined;
  const outcome = await applyResetResult(deps, repo, result);
  reportOp(outcome);
  return outcome;
}

// ---------------------------------------------------------------------------
// Rollback
// ---------------------------------------------------------------------------

export function rollbackFilesOf(repo: RepoHandle): RollbackFileDto[] {
  return repo.model.snapshot.statusEntries
    .filter((e) => e.kind !== 'ignored')
    .map((e) => ({
      path: e.path,
      code: `${e.x}${e.y}`,
      kind: rollbackKindOf(e),
      ...(e.origPath !== undefined ? { origPath: e.origPath } : {}),
    }));
}

export function buildRollbackParams(
  repo: RepoHandle,
  preselected?: readonly string[],
): RollbackDialogParamsDto {
  const files = rollbackFilesOf(repo);
  const checked =
    preselected !== undefined && preselected.length > 0
      ? files.filter((f) => preselected.includes(f.path)).map((f) => f.path)
      : files.map((f) => f.path);
  return {
    ...base(repo),
    files,
    checked,
    deleteAddedLocalCopies: true,
    colors: statusColorOverrides(),
  };
}

export async function applyRollbackResult(
  deps: OpDialogDeps,
  repo: RepoHandle,
  result: RollbackDialogResultDto,
): Promise<OpOutcome> {
  const known = new Map(rollbackFilesOf(repo).map((f) => [f.path, f]));
  const files: RollbackFile[] = result.paths
    .map((p) => known.get(p))
    .filter((f): f is RollbackFileDto => f !== undefined)
    .map((f) => ({
      path: f.path,
      kind: f.kind,
      ...(f.origPath !== undefined ? { origPath: f.origPath } : {}),
    }));
  const plan = planRollback(files, result.deleteAddedLocalCopies);
  if (isEmptyRollbackPlan(plan)) {
    return { ok: false, message: vscode.l10n.t('Nothing selected to roll back.'), commands: [] };
  }

  // The very commands the dialog's "will run" line showed — one builder, so
  // the two cannot drift apart (they were written out twice until POST-P14ck).
  const commands = rollbackCommands(plan);

  try {
    await repo.queue.enqueue({
      label: vscode.l10n.t('Rollback {0}', filesCount(files.length)),
      kind: 'mutate',
      isDestructive: true,
      snapshotLabel: SNAPSHOT_LABELS.rollback,
      // Snapshot the exact files being rolled back, deletions included.
      snapshotPaths: [...new Set([...plan.restorePaths, ...plan.unstagePaths, ...plan.deletePaths])].map(
        (p) => path.join(repo.root, p),
      ),
      run: async (git, token) => {
        for (const args of commands) {
          await git.exec(repo.root, args, { token });
        }
        for (const rel of plan.deletePaths) {
          await vscode.workspace.fs
            .delete(vscode.Uri.file(path.join(repo.root, rel)), { useTrash: false })
            .then(undefined, () => undefined);
        }
      },
    });
    await repo.refresher.refreshNow();
    return {
      ok: true,
      message: vscode.l10n.t('Rolled back {0}.', filesCount(files.length)),
      commands,
    };
  } catch (err) {
    await repo.refresher.refreshNow();
    return failed(err, commands);
  }
}

/** Lazy per-file diff for the dialog's InlineDiff preview. */
export async function rollbackFileDiff(
  core: Core,
  repo: RepoHandle,
  relPath: string,
): Promise<RollbackFileDiffDto> {
  const empty: RollbackFileDiffDto = {
    path: relPath,
    originalText: '',
    modifiedText: '',
    changes: [],
    wholeFileOnly: true,
  };
  const head = await core.git.exec(repo.root, ['show', `HEAD:${relPath}`], {
    allowNonZeroExit: true,
  });
  if (head.exitCode !== 0) return empty; // new file — nothing to compare against
  let modified: string;
  try {
    const bytes = await vscode.workspace.fs.readFile(
      vscode.Uri.file(path.join(repo.root, relPath)),
    );
    modified = Buffer.from(bytes).toString('utf8');
  } catch {
    modified = ''; // deleted in the worktree
  }
  if (head.stdout.includes('\0') || modified.includes('\0')) return empty;
  // On the blob's line endings, so a CRLF checkout previews its real changes.
  const modifiedText = toBlobEol(head.stdout, modified).text;
  return {
    path: relPath,
    originalText: head.stdout,
    modifiedText,
    changes: computeLineChanges(head.stdout, modifiedText),
    wholeFileOnly: false,
  };
}

export function rollbackDialogHandlers(
  deps: OpDialogDeps,
  repo: RepoHandle,
): Record<string, (params: unknown) => unknown> {
  return {
    [ROLLBACK_DIALOG_METHODS.fileDiff]: async (raw): Promise<RollbackFileDiffDto> => {
      const p = raw as { relPath: string };
      return rollbackFileDiff(deps.core, repo, p.relPath);
    },
  };
}

export async function showRollbackDialog(
  deps: OpDialogDeps,
  repo: RepoHandle,
  preselected?: readonly string[],
): Promise<OpOutcome | undefined> {
  const params = buildRollbackParams(repo, preselected);
  if (params.files.length === 0) {
    showInfo(vscode.l10n.t('Nothing to roll back.'));
    return undefined;
  }
  const result = await openDialog<RollbackDialogParamsDto, RollbackDialogResultDto>({
    app: 'dialogs',
    dialog: 'rollback',
    title: vscode.l10n.t('Rollback Changes — {0}', params.repoLabel),
    params,
    extensionUri: deps.extensionUri,
    ...(deps.trace ? { trace: deps.trace } : {}),
    handlers: rollbackDialogHandlers(deps, repo),
  });
  if (!result) return undefined;
  const outcome = await applyRollbackResult(deps, repo, result);
  reportOp(outcome);
  return outcome;
}

// ---------------------------------------------------------------------------

/** Not awaited: a notification's promise stays pending until it is dismissed. */
function reportOp(outcome: OpOutcome): void {
  if (outcome.conflicts === true) return;
  if (outcome.ok) {
    showInfo(outcome.message);
    return;
  }
  void vscode.window.showErrorMessage(
    outcome.message.split('\n', 1)[0] ?? outcome.message,
  );
}
