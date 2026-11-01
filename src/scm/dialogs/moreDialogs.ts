/**
 * Cherry-pick · Stash · Unstash · Apply Patch · Clone · Manage Remotes, host
 * halves (P13-T4). `Manage Remotes` is the one with no predecessor at all —
 * there was no remote-management command in GitTree before this.
 *
 * Same split as T1–T3: a vscode-free argv builder both halves import,
 * `buildXParams` for the open, `applyXResult` for the accept.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { Core, RepoHandle } from '../../core/core';
import { isStaged } from '../../core/model/statusEntry';
import { computeLineChanges } from '../../core/patch/lineDiff';
import { SNAPSHOT_LABELS } from '../../localHistory/hooks';
import { applyPatchFile, isMailboxPatch, summarizePatch } from '../../rewrite/patch/applyPatch';
import {
  CLONE_DIALOG_METHODS,
  PATCH_DIALOG_METHODS,
  REMOTES_DIALOG_METHODS,
  UNSTASH_DIALOG_METHODS,
  type ApplyPatchDialogParamsDto,
  type ApplyPatchDialogResultDto,
  type CherryPickDialogParamsDto,
  type CherryPickDialogResultDto,
  type CloneDialogParamsDto,
  type CloneDialogResultDto,
  type PatchFileSummaryDto,
  type RemoteRowDto,
  type RemotesDialogParamsDto,
  type RemotesOpResultDto,
  type RollbackFileDiffDto,
  type StashDialogParamsDto,
  type StashDialogResultDto,
  type UnstashDialogParamsDto,
  type UnstashDialogResultDto,
  type UnstashFileDto,
} from '../../shared/protocol';
import { confirmModal } from '../../ui/confirm';
import { openDialog } from '../../ui/dialogHost';
import { buildCherryPickArgs, validateCherryPickOptions } from './cherryPickArgs';
import { buildCloneArgs, validateCloneOptions } from './cloneArgs';
import type { OpDialogDeps, OpOutcome } from './opsDialogs';
import {
  buildRemotePruneArgs,
  buildRemoteRemoveArgs,
  planRemoteEdit,
  validateRemoteEdit,
  type RemoteEdit,
} from './remoteArgs';
import { buildStashApplyArgs, buildStashPushArgs, validateStashPushOptions } from './stashArgs';

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
  return { ok: false, message: err instanceof Error ? err.message : String(err), commands };
}

function report(outcome: OpOutcome): void {
  if (outcome.ok) void vscode.window.showInformationMessage(outcome.message);
  else void vscode.window.showErrorMessage(outcome.message.split('\n', 1)[0] ?? outcome.message);
}

// ---------------------------------------------------------------------------
// Cherry-pick
// ---------------------------------------------------------------------------

/** Commits not yet on the current branch — the pool a cherry-pick draws from. */
export async function buildCherryPickParams(
  core: Core,
  repo: RepoHandle,
  seedShas?: readonly string[],
): Promise<CherryPickDialogParamsDto> {
  const cfg = vscode.workspace.getConfiguration('gittree');
  const commits: CherryPickDialogParamsDto['commits'] = [];
  if (seedShas !== undefined && seedShas.length > 0) {
    for (const sha of seedShas) {
      const res = await core.git.exec(
        repo.root,
        ['log', '-1', '--format=%H%x00%s%x00%an%x00%at%x00%P', sha],
        { allowNonZeroExit: true },
      );
      if (res.exitCode !== 0) continue;
      const [full, subject, author, at, parents] = res.stdout.trim().split('\0');
      if (full === undefined) continue;
      commits.push({
        sha: full,
        subject: subject ?? '',
        authorName: author ?? '',
        authorTime: Number(at ?? '0') || 0,
        parentCount: (parents ?? '').trim().length === 0 ? 0 : (parents ?? '').trim().split(/\s+/u).length,
      });
    }
  } else {
    // Everything reachable from another local branch but not from HEAD.
    const res = await core.git.exec(repo.root, [
      'log',
      '--format=%H%x00%s%x00%an%x00%at%x00%P',
      '--branches',
      '--not',
      'HEAD',
      '--max-count=200',
    ]);
    for (const line of res.stdout.split('\n').filter((l) => l.length > 0)) {
      const [full, subject, author, at, parents] = line.split('\0');
      if (full === undefined) continue;
      commits.push({
        sha: full,
        subject: subject ?? '',
        authorName: author ?? '',
        authorTime: Number(at ?? '0') || 0,
        parentCount: (parents ?? '').trim().length === 0 ? 0 : (parents ?? '').trim().split(/\s+/u).length,
      });
    }
  }
  return {
    ...base(repo),
    commits,
    recordOrigin: cfg.get<boolean>('cherryPick.recordOrigin', true),
  };
}

export async function applyCherryPickResult(
  deps: OpDialogDeps,
  repo: RepoHandle,
  result: CherryPickDialogResultDto,
): Promise<OpOutcome> {
  const errors = validateCherryPickOptions(result.options);
  if (errors.length > 0) return { ok: false, message: errors.join(' '), commands: [] };
  const args = buildCherryPickArgs(result.options);
  try {
    await repo.queue.enqueue({
      label: vscode.l10n.t('Cherry-pick {0} commit(s)', result.options.shas.length),
      kind: 'mutate',
      isDestructive: true,
      snapshotLabel: SNAPSHOT_LABELS.cherryPick,
      run: async (git, token) => {
        await git.exec(repo.root, args, { token });
      },
    });
    await repo.refresher.refreshNow();
    return {
      ok: true,
      message: vscode.l10n.t('Cherry-picked {0} commit(s).', result.options.shas.length),
      commands: [args],
    };
  } catch (err) {
    await repo.refresher.refreshNow();
    return failed(err, [args]);
  }
}

export async function showCherryPickDialog(
  deps: OpDialogDeps,
  repo: RepoHandle,
  seedShas?: readonly string[],
): Promise<OpOutcome | undefined> {
  const params = await buildCherryPickParams(deps.core, repo, seedShas);
  if (params.commits.length === 0) {
    void vscode.window.showInformationMessage(
      vscode.l10n.t('No commits outside this branch to cherry-pick.'),
    );
    return undefined;
  }
  const result = await openDialog<CherryPickDialogParamsDto, CherryPickDialogResultDto>({
    app: 'dialogs',
    dialog: 'cherryPick',
    title: vscode.l10n.t('Cherry-Pick into {0}', params.currentBranch),
    params,
    extensionUri: deps.extensionUri,
    ...(deps.trace ? { trace: deps.trace } : {}),
  });
  if (!result) return undefined;
  const outcome = await applyCherryPickResult(deps, repo, result);
  report(outcome);
  return outcome;
}

// ---------------------------------------------------------------------------
// Stash
// ---------------------------------------------------------------------------

export function buildStashParams(core: Core, repo: RepoHandle): StashDialogParamsDto {
  const entries = repo.model.snapshot.statusEntries.filter((e) => e.kind !== 'ignored');
  return {
    ...base(repo),
    canStashStaged: core.git.caps.stashStaged,
    dirtyCount: entries.length,
    untrackedCount: entries.filter((e) => e.kind === 'untracked').length,
    stagedCount: entries.filter((e) => isStaged(e)).length,
    includeUntrackedDefault: vscode.workspace
      .getConfiguration('gittree')
      .get<boolean>('stash.includeUntrackedDefault', true),
  };
}

export async function applyStashResult(
  deps: OpDialogDeps,
  repo: RepoHandle,
  result: StashDialogResultDto,
): Promise<OpOutcome> {
  const errors = validateStashPushOptions(result.options);
  if (errors.length > 0) return { ok: false, message: errors.join(' '), commands: [] };
  if (result.options.staged && !deps.core.git.caps.stashStaged) {
    return {
      ok: false,
      message: vscode.l10n.t('Stashing only staged changes requires git 2.35+.'),
      commands: [],
    };
  }
  const args = buildStashPushArgs(result.options);
  try {
    await repo.queue.enqueue({
      label: vscode.l10n.t('Stash changes'),
      kind: 'mutate',
      run: async (git, token) => {
        await git.exec(repo.root, args, { token });
      },
    });
    await repo.refresher.refreshNow();
    // IntelliJ's `stash.files.success`, as the quick Stash says it.
    return { ok: true, message: vscode.l10n.t('Files stashed successfully'), commands: [args] };
  } catch (err) {
    await repo.refresher.refreshNow();
    return failed(err, [args]);
  }
}

export async function showStashDialog(
  deps: OpDialogDeps,
  repo: RepoHandle,
): Promise<OpOutcome | undefined> {
  const params = buildStashParams(deps.core, repo);
  if (params.dirtyCount === 0) {
    void vscode.window.showInformationMessage(vscode.l10n.t('Nothing to stash.'));
    return undefined;
  }
  const result = await openDialog<StashDialogParamsDto, StashDialogResultDto>({
    app: 'dialogs',
    dialog: 'stash',
    title: vscode.l10n.t('Stash Changes — {0}', params.repoLabel),
    params,
    extensionUri: deps.extensionUri,
    ...(deps.trace ? { trace: deps.trace } : {}),
  });
  if (!result) return undefined;
  const outcome = await applyStashResult(deps, repo, result);
  report(outcome);
  return outcome;
}

// ---------------------------------------------------------------------------
// Unstash
// ---------------------------------------------------------------------------

export interface UnstashDeps extends OpDialogDeps {
  /** P3's changelists, for the target selector. */
  changelists?: (repo: RepoHandle) => Array<{ id: string; name: string }>;
  /** P3 seam: move the restored paths into a changelist. */
  assignChangelist?: (repo: RepoHandle, listId: string, paths: readonly string[]) => void;
}

export function buildUnstashParams(deps: UnstashDeps, repo: RepoHandle): UnstashDialogParamsDto {
  const entries = repo.model.snapshot.stashes.map((s) => ({
    index: s.index,
    message: s.message,
    ...(s.branch !== undefined ? { branch: s.branch } : {}),
    date: s.time,
  }));
  const lists = deps.changelists?.(repo) ?? [];
  return {
    ...base(repo),
    entries,
    changelists: lists,
    activeChangelistId: lists[0]?.id ?? 'default',
  };
}

export async function unstashFiles(
  core: Core,
  repo: RepoHandle,
  index: number,
): Promise<UnstashFileDto[]> {
  const res = await core.git.exec(
    repo.root,
    ['stash', 'show', '--name-status', '-z', `stash@{${index}}`],
    { allowNonZeroExit: true },
  );
  if (res.exitCode !== 0) return [];
  const parts = res.stdout.split('\0').filter((p) => p.length > 0);
  const out: UnstashFileDto[] = [];
  for (let i = 0; i < parts.length; i += 2) {
    const status = parts[i];
    const p = parts[i + 1];
    if (status === undefined || p === undefined) break;
    out.push({ status, path: p });
  }
  return out;
}

export async function unstashFileDiff(
  core: Core,
  repo: RepoHandle,
  index: number,
  relPath: string,
): Promise<RollbackFileDiffDto> {
  const empty: RollbackFileDiffDto = {
    path: relPath,
    originalText: '',
    modifiedText: '',
    changes: [],
    wholeFileOnly: true,
  };
  const before = await core.git.exec(repo.root, ['show', `stash@{${index}}^:${relPath}`], {
    allowNonZeroExit: true,
  });
  const after = await core.git.exec(repo.root, ['show', `stash@{${index}}:${relPath}`], {
    allowNonZeroExit: true,
  });
  if (after.exitCode !== 0) return empty;
  const originalText = before.exitCode === 0 ? before.stdout : '';
  if (originalText.includes('\0') || after.stdout.includes('\0')) return empty;
  return {
    path: relPath,
    originalText,
    modifiedText: after.stdout,
    changes: computeLineChanges(originalText, after.stdout),
    wholeFileOnly: false,
  };
}

export async function applyUnstashResult(
  deps: UnstashDeps,
  repo: RepoHandle,
  result: UnstashDialogResultDto,
): Promise<OpOutcome> {
  const args = buildStashApplyArgs({
    index: result.index,
    pop: result.pop,
    reinstateIndex: result.reinstateIndex,
  });
  const files = await unstashFiles(deps.core, repo, result.index);
  try {
    const exec = await repo.queue.enqueue({
      label: result.pop ? vscode.l10n.t('Stash: pop') : vscode.l10n.t('Stash: apply'),
      kind: 'mutate',
      isDestructive: true,
      snapshotLabel: result.pop ? SNAPSHOT_LABELS.stashPop : SNAPSHOT_LABELS.stashApply,
      run: (git, token) => git.exec(repo.root, args, { allowNonZeroExit: true, token }),
    });
    await repo.refresher.refreshNow();
    if (exec.exitCode !== 0) {
      const text = exec.stdout + exec.stderr;
      return {
        ok: false,
        message: /conflict/iu.test(text)
          ? vscode.l10n.t('Unstashed with conflicts — resolve them in the Conflicts view.')
          : (exec.stderr.split('\n')[0] ?? vscode.l10n.t('Unstash failed.')),
        commands: [args],
      };
    }
    if (result.changelistId.length > 0 && files.length > 0) {
      deps.assignChangelist?.(
        repo,
        result.changelistId,
        files.map((f) => f.path),
      );
    }
    return {
      ok: true,
      message: vscode.l10n.t('Unstashed {0} file(s).', files.length),
      commands: [args],
    };
  } catch (err) {
    await repo.refresher.refreshNow();
    return failed(err, [args]);
  }
}

export function unstashHandlers(
  deps: UnstashDeps,
  repo: RepoHandle,
): Record<string, (params: unknown) => unknown> {
  return {
    [UNSTASH_DIALOG_METHODS.files]: async (raw): Promise<UnstashFileDto[]> => {
      const p = raw as { index: number };
      return unstashFiles(deps.core, repo, p.index);
    },
    [UNSTASH_DIALOG_METHODS.fileDiff]: async (raw): Promise<RollbackFileDiffDto> => {
      const p = raw as { index: number; relPath: string };
      return unstashFileDiff(deps.core, repo, p.index, p.relPath);
    },
  };
}

export async function showUnstashDialog(
  deps: UnstashDeps,
  repo: RepoHandle,
): Promise<OpOutcome | undefined> {
  const params = buildUnstashParams(deps, repo);
  if (params.entries.length === 0) {
    void vscode.window.showInformationMessage(vscode.l10n.t('There are no stashes.'));
    return undefined;
  }
  const result = await openDialog<UnstashDialogParamsDto, UnstashDialogResultDto>({
    app: 'dialogs',
    dialog: 'unstash',
    title: vscode.l10n.t('Unstash Changes — {0}', params.repoLabel),
    params,
    extensionUri: deps.extensionUri,
    ...(deps.trace ? { trace: deps.trace } : {}),
    handlers: unstashHandlers(deps, repo),
  });
  if (!result) return undefined;
  const outcome = await applyUnstashResult(deps, repo, result);
  report(outcome);
  return outcome;
}

// ---------------------------------------------------------------------------
// Apply Patch
// ---------------------------------------------------------------------------

export function buildPatchParams(repo: RepoHandle, patchPath: string): ApplyPatchDialogParamsDto {
  const shell = { ...base(repo), patchPath, summary: [] as PatchFileSummaryDto[], isMailbox: false };
  if (patchPath.length === 0) return shell;
  let text: string;
  try {
    text = fs.readFileSync(patchPath, 'latin1');
  } catch (err) {
    return { ...shell, error: err instanceof Error ? err.message : String(err) };
  }
  const summary: PatchFileSummaryDto[] = summarizePatch(text).map((s) => ({
    relPath: s.relPath,
    hunks: s.hunks,
    status: s.status,
    // A patch that edits a file we do not have will not apply cleanly — say so
    // before the user presses Apply, not after.
    missing:
      s.status !== 'added' && !fs.existsSync(path.join(repo.root, s.relPath)),
  }));
  if (summary.length === 0) {
    return { ...shell, error: vscode.l10n.t('No file sections found — is this a patch file?') };
  }
  return { ...shell, summary, isMailbox: isMailboxPatch(text) };
}

export async function applyPatchResult(
  deps: OpDialogDeps,
  repo: RepoHandle,
  result: ApplyPatchDialogResultDto,
): Promise<OpOutcome> {
  if (result.patchPath.length === 0) {
    return { ok: false, message: vscode.l10n.t('Choose a patch file first.'), commands: [] };
  }
  try {
    const applied = await applyPatchFile(repo, result.patchPath, {
      threeWay: result.threeWay,
      reverse: result.reverse,
      pDepth: result.pDepth,
      whitespaceFix: result.whitespaceFix,
      contentOnly: result.contentOnly,
    });
    await repo.refresher.refreshNow();
    if (applied.status === 'applied') {
      return {
        ok: true,
        message: applied.appliedAsCommits
          ? vscode.l10n.t('Patch replayed as commits.')
          : vscode.l10n.t('Patch applied.'),
        commands: [],
      };
    }
    // Rejects are reported as a file list, per the phase plan.
    const list = applied.rejected.join(', ');
    return {
      ok: false,
      message:
        applied.status === 'conflicts'
          ? vscode.l10n.t('Patch applied with conflicts in: {0}', list)
          : vscode.l10n.t('Patch failed ({0}): {1}', applied.reason ?? 'no reason given', list),
      commands: [],
    };
  } catch (err) {
    await repo.refresher.refreshNow();
    return failed(err, []);
  }
}

export function patchHandlers(
  deps: OpDialogDeps,
  repo: RepoHandle,
): Record<string, (params: unknown) => unknown> {
  return {
    [PATCH_DIALOG_METHODS.choose]: async (): Promise<ApplyPatchDialogParamsDto> => {
      const picked = await vscode.window.showOpenDialog({
        canSelectMany: false,
        openLabel: vscode.l10n.t('Apply Patch'),
        filters: { Patches: ['patch', 'diff', 'txt'], 'All files': ['*'] },
      });
      const file = picked?.[0];
      return buildPatchParams(repo, file?.fsPath ?? '');
    },
    [PATCH_DIALOG_METHODS.inspect]: (raw): ApplyPatchDialogParamsDto => {
      const p = raw as { patchPath: string };
      return buildPatchParams(repo, p.patchPath);
    },
  };
}

export async function showApplyPatchDialog(
  deps: OpDialogDeps,
  repo: RepoHandle,
  seedPath?: string,
): Promise<OpOutcome | undefined> {
  const params = buildPatchParams(repo, seedPath ?? '');
  const result = await openDialog<ApplyPatchDialogParamsDto, ApplyPatchDialogResultDto>({
    app: 'dialogs',
    dialog: 'applyPatch',
    title: vscode.l10n.t('Apply Patch — {0}', params.repoLabel),
    params,
    extensionUri: deps.extensionUri,
    ...(deps.trace ? { trace: deps.trace } : {}),
    handlers: patchHandlers(deps, repo),
  });
  if (!result) return undefined;
  const outcome = await applyPatchResult(deps, repo, result);
  report(outcome);
  return outcome;
}

// ---------------------------------------------------------------------------
// Clone
// ---------------------------------------------------------------------------

/** A clone target must be missing or empty — anything else is refused with a reason. */
export function checkCloneDirectory(dir: string): { ok: boolean; reason?: string } {
  const trimmed = dir.trim();
  if (trimmed.length === 0) return { ok: false, reason: 'Choose a directory.' };
  if (!fs.existsSync(trimmed)) return { ok: true };
  let stat: fs.Stats;
  try {
    stat = fs.statSync(trimmed);
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
  if (!stat.isDirectory()) return { ok: false, reason: 'That path is a file, not a directory.' };
  const entries = fs.readdirSync(trimmed);
  return entries.length === 0
    ? { ok: true }
    : { ok: false, reason: `Directory is not empty (${entries.length} entries).` };
}

export function buildCloneParams(): CloneDialogParamsDto {
  const first = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  return {
    defaultParent: first !== undefined ? path.dirname(first) : '',
    showCommandLine: vscode.workspace
      .getConfiguration('gittree')
      .get<boolean>('dialogs.showCommandLine', true),
  };
}

export async function applyCloneResult(
  core: Core,
  result: CloneDialogResultDto,
): Promise<OpOutcome> {
  const errors = validateCloneOptions(result.options);
  if (errors.length > 0) return { ok: false, message: errors.join(' '), commands: [] };
  const check = checkCloneDirectory(result.options.directory);
  if (!check.ok) {
    return { ok: false, message: check.reason ?? 'Unusable directory.', commands: [] };
  }
  const args = buildCloneArgs(result.options);
  try {
    // Clone has no repository to queue against — it runs in the parent dir.
    await core.git.exec(path.dirname(result.options.directory.trim()) || '.', args);
  } catch (err) {
    return failed(err, [args]);
  }
  const target = vscode.Uri.file(result.options.directory.trim());
  if (result.openAfter === 'window') {
    await vscode.commands.executeCommand('vscode.openFolder', target, { forceNewWindow: true });
  } else if (result.openAfter === 'add') {
    vscode.workspace.updateWorkspaceFolders(
      vscode.workspace.workspaceFolders?.length ?? 0,
      0,
      { uri: target },
    );
  }
  return {
    ok: true,
    message: vscode.l10n.t('Cloned into {0}.', result.options.directory.trim()),
    commands: [args],
  };
}

export function cloneHandlers(): Record<string, (params: unknown) => unknown> {
  return {
    [CLONE_DIALOG_METHODS.browse]: async (): Promise<{ directory: string }> => {
      const picked = await vscode.window.showOpenDialog({
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
        openLabel: vscode.l10n.t('Clone Here'),
      });
      return { directory: picked?.[0]?.fsPath ?? '' };
    },
    [CLONE_DIALOG_METHODS.checkDirectory]: (raw): { ok: boolean; reason?: string } => {
      const p = raw as { directory: string };
      return checkCloneDirectory(p.directory);
    },
  };
}

export async function showCloneDialog(deps: OpDialogDeps): Promise<OpOutcome | undefined> {
  const result = await openDialog<CloneDialogParamsDto, CloneDialogResultDto>({
    app: 'dialogs',
    dialog: 'clone',
    title: vscode.l10n.t('Clone Repository'),
    params: buildCloneParams(),
    extensionUri: deps.extensionUri,
    ...(deps.trace ? { trace: deps.trace } : {}),
    handlers: cloneHandlers(),
  });
  if (!result) return undefined;
  const outcome = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Cloning…') },
    () => applyCloneResult(deps.core, result),
  );
  report(outcome);
  return outcome;
}

// ---------------------------------------------------------------------------
// Manage Remotes
// ---------------------------------------------------------------------------

export async function listRemoteRows(core: Core, repo: RepoHandle): Promise<RemoteRowDto[]> {
  const res = await core.git.exec(repo.root, ['remote', '-v']);
  const rows = new Map<string, RemoteRowDto>();
  for (const line of res.stdout.split('\n')) {
    const m = /^(\S+)\t(.+) \((fetch|push)\)$/u.exec(line.trim());
    if (!m) continue;
    const [, name, url, kind] = m;
    if (name === undefined || url === undefined) continue;
    const row = rows.get(name) ?? { name, fetchUrl: '', pushUrl: '' };
    if (kind === 'fetch') row.fetchUrl = url;
    else row.pushUrl = url;
    rows.set(name, row);
  }
  // git echoes the fetch URL as the push URL when no pushurl is configured;
  // the dialog shows "same as fetch" instead, so normalize it away.
  for (const row of rows.values()) if (row.pushUrl === row.fetchUrl) row.pushUrl = '';
  return [...rows.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export async function buildRemotesParams(
  core: Core,
  repo: RepoHandle,
): Promise<RemotesDialogParamsDto> {
  return { ...base(repo), remotes: await listRemoteRows(core, repo) };
}

async function runRemoteCommands(
  core: Core,
  repo: RepoHandle,
  label: string,
  commands: readonly string[][],
): Promise<RemotesOpResultDto> {
  try {
    await repo.queue.enqueue({
      label,
      kind: 'mutate',
      run: async (git, token) => {
        for (const args of commands) await git.exec(repo.root, args, { token });
      },
    });
    await repo.refresher.refreshNow();
    return { ok: true, remotes: await listRemoteRows(core, repo) };
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message.split('\n', 1)[0] : String(err),
      remotes: await listRemoteRows(core, repo),
    };
  }
}

export function remotesHandlers(
  deps: OpDialogDeps,
  repo: RepoHandle,
): Record<string, (params: unknown) => unknown> {
  const { core } = deps;
  return {
    [REMOTES_DIALOG_METHODS.save]: async (raw): Promise<RemotesOpResultDto> => {
      const p = raw as { before?: RemoteEdit; after: RemoteEdit };
      const existing = await listRemoteRows(core, repo);
      const errors = validateRemoteEdit(
        p.after,
        existing.map((r) => r.name),
        p.before?.name,
      );
      if (errors.length > 0) return { ok: false, message: errors.join(' '), remotes: existing };
      const commands = planRemoteEdit(p.before, p.after);
      if (commands.length === 0) return { ok: true, remotes: existing };
      return runRemoteCommands(core, repo, vscode.l10n.t('Save remote'), commands);
    },
    [REMOTES_DIALOG_METHODS.remove]: async (raw): Promise<RemotesOpResultDto> => {
      const p = raw as { name: string };
      const ok = await confirmModal(
        vscode.l10n.t('Remove the remote "{0}"?', p.name),
        vscode.l10n.t('Its remote-tracking branches are deleted too. Local branches are untouched.'),
        vscode.l10n.t('Remove'),
      );
      if (!ok) return { ok: false, remotes: await listRemoteRows(core, repo) };
      return runRemoteCommands(core, repo, vscode.l10n.t('Remove remote'), [
        buildRemoteRemoveArgs(p.name),
      ]);
    },
    [REMOTES_DIALOG_METHODS.prune]: async (raw): Promise<RemotesOpResultDto> => {
      const p = raw as { name: string };
      return runRemoteCommands(core, repo, vscode.l10n.t('Prune remote'), [
        buildRemotePruneArgs(p.name),
      ]);
    },
  };
}

export async function showRemotesDialog(deps: OpDialogDeps, repo: RepoHandle): Promise<void> {
  const params = await buildRemotesParams(deps.core, repo);
  await openDialog<RemotesDialogParamsDto, unknown>({
    app: 'dialogs',
    dialog: 'remotes',
    title: vscode.l10n.t('Manage Remotes — {0}', params.repoLabel),
    params,
    extensionUri: deps.extensionUri,
    ...(deps.trace ? { trace: deps.trace } : {}),
    handlers: remotesHandlers(deps, repo),
  });
}
