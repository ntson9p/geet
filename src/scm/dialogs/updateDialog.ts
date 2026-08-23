/**
 * Update Project dialog, host half (P13-T2, gap analysis S4 · §2A "Update
 * Project dialog"): the merge/rebase radio, the `Do not show again` shortcut
 * that turns Ctrl+T into a direct action, `Reset to the Remote Branch` behind
 * a destructive confirmation and a P9 snapshot, and the result notification
 * that stands in for IntelliJ's `Update Info` tab (deviation D9).
 *
 * Every command comes from the vscode-free `updateArgs.ts`, so the dialog's
 * "will run" line and the execution cannot drift apart.
 */
import * as vscode from 'vscode';
import type { Core, RepoHandle } from '../../core/core';
import { canonicalKey } from '../../core/repoDiscovery';
import { SNAPSHOT_LABELS } from '../../localHistory/hooks';
import {
  type UpdateDialogParamsDto,
  type UpdateDialogResultDto,
} from '../../shared/protocol';
import { confirmModal } from '../../ui/confirm';
import { openDialog } from '../../ui/dialogHost';
import { splitUpstream } from './pushArgs';
import {
  buildIntegrateArgs,
  buildResetToRemoteArgs,
  buildUpdateFetchArgs,
  normalizeStrategySetting,
  type UpdateStrategy,
  type UpdateStrategySetting,
} from './updateArgs';

export interface UpdateDialogDeps {
  core: Core;
  extensionUri: vscode.Uri;
  trace?: (line: string) => void;
}

/** What the update actually did — returned so integration tests can assert it. */
export interface UpdateOutcome {
  ok: boolean;
  /** Commits the fetch brought in (upstream before → upstream after). */
  commitsPulled: number;
  filesChanged: number;
  /** Upstream sha before the fetch; the "Show in Log" range's left side. */
  from: string;
  to: string;
  message: string;
}

function readSetting(): UpdateStrategySetting {
  return normalizeStrategySetting(
    vscode.workspace.getConfiguration('gittree').get<string>('update.strategy', 'ask'),
  );
}

export async function buildUpdateParams(
  core: Core,
  repo: RepoHandle,
): Promise<UpdateDialogParamsDto> {
  const snap = repo.model.snapshot;
  const cfg = vscode.workspace.getConfiguration('gittree');
  const setting = readSetting();
  const remotesRes = await core.git.exec(repo.root, ['remote']);
  const remotes = remotesRes.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const parsed = snap.upstream !== undefined ? splitUpstream(snap.upstream, remotes) : undefined;
  return {
    repoRoot: repo.root,
    repoLabel: repo.root.split(/[\\/]/u).pop() ?? repo.root,
    branch: snap.headRef ?? '',
    ...(snap.upstream !== undefined ? { upstream: snap.upstream } : {}),
    ...(parsed !== undefined ? { remote: parsed.remote } : {}),
    ahead: snap.ahead ?? 0,
    behind: snap.behind ?? 0,
    // `ask` means "no remembered choice" — open on merge, IntelliJ's default.
    strategy: setting === 'rebase' ? 'rebase' : 'merge',
    showCommandLine: cfg.get<boolean>('dialogs.showCommandLine', true),
  };
}

async function revParse(core: Core, repo: RepoHandle, ref: string): Promise<string | undefined> {
  const res = await core.git.exec(repo.root, ['rev-parse', '--verify', '--quiet', ref], {
    allowNonZeroExit: true,
  });
  return res.exitCode === 0 ? res.stdout.trim() : undefined;
}

/**
 * The accept half, separated so integration tests drive it with exactly the
 * payload the webview posts. Returns what happened, for the notification and
 * for the tests.
 */
export async function applyUpdateResult(
  deps: UpdateDialogDeps,
  repo: RepoHandle,
  result: UpdateDialogResultDto,
): Promise<UpdateOutcome> {
  const { core } = deps;
  const snap = repo.model.snapshot;
  const upstream = snap.upstream;
  if (upstream === undefined) {
    return {
      ok: false,
      commitsPulled: 0,
      filesChanged: 0,
      from: '',
      to: '',
      message: vscode.l10n.t('"{0}" has no upstream branch to update from.', snap.headRef ?? ''),
    };
  }
  const remotesRes = await core.git.exec(repo.root, ['remote']);
  const remotes = remotesRes.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const remote = splitUpstream(upstream, remotes)?.remote;

  const before = (await revParse(core, repo, upstream)) ?? '';
  try {
    await repo.queue.enqueue({
      label: vscode.l10n.t('Fetch'),
      kind: 'mutate',
      run: async (git, token) => {
        await git.exec(repo.root, buildUpdateFetchArgs(remote), { token });
      },
    });
    repo.model.update({ lastFetchAt: Date.now() });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, commitsPulled: 0, filesChanged: 0, from: before, to: before, message };
  }
  const after = (await revParse(core, repo, upstream)) ?? before;

  // Incoming volume is measured on the *upstream* boundary, not on HEAD: a
  // rebase rewrites local commits, so HEAD before→after would over-count.
  const counted = await countIncoming(core, repo, before, after);

  if (result.action === 'reset') {
    const ok = await confirmModal(
      vscode.l10n.t('Reset "{0}" to {1}?', snap.headRef ?? '', upstream),
      vscode.l10n.t(
        'Discards every local commit and uncommitted change on this branch. A Local History snapshot is taken first.',
      ),
      vscode.l10n.t('Reset Hard'),
    );
    if (!ok) {
      return {
        ok: false,
        commitsPulled: counted.commits,
        filesChanged: counted.files,
        from: before,
        to: after,
        message: vscode.l10n.t('Reset cancelled.'),
      };
    }
    try {
      await repo.queue.enqueue({
        label: vscode.l10n.t('Reset to {0}', upstream),
        kind: 'mutate',
        isDestructive: true,
        snapshotLabel: SNAPSHOT_LABELS.reset,
        run: async (git, token) => {
          await git.exec(repo.root, buildResetToRemoteArgs(upstream), { token });
        },
      });
      await repo.refresher.refreshNow();
      return {
        ok: true,
        commitsPulled: counted.commits,
        filesChanged: counted.files,
        from: before,
        to: after,
        message: vscode.l10n.t('Reset {0} to {1}.', snap.headRef ?? '', upstream),
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, commitsPulled: 0, filesChanged: 0, from: before, to: after, message };
    }
  }

  const strategy: UpdateStrategy = result.strategy === 'rebase' ? 'rebase' : 'merge';
  try {
    await repo.queue.enqueue({
      label:
        strategy === 'rebase'
          ? vscode.l10n.t('Rebase onto {0}', upstream)
          : vscode.l10n.t('Merge {0}', upstream),
      kind: 'mutate',
      isDestructive: true,
      snapshotLabel:
        strategy === 'rebase' ? SNAPSHOT_LABELS.rebaseStart : SNAPSHOT_LABELS.merge,
      run: async (git, token) => {
        await git.exec(repo.root, buildIntegrateArgs(strategy, upstream), { token });
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await repo.refresher.refreshNow();
    return { ok: false, commitsPulled: counted.commits, filesChanged: counted.files, from: before, to: after, message };
  }
  await repo.refresher.refreshNow();

  return {
    ok: true,
    commitsPulled: counted.commits,
    filesChanged: counted.files,
    from: before,
    to: after,
    message:
      counted.commits === 0
        ? vscode.l10n.t('Already up to date.')
        : vscode.l10n.t(
            '{0}: {1} commit(s), {2} file(s) changed.',
            strategy === 'rebase' ? vscode.l10n.t('Rebased') : vscode.l10n.t('Merged'),
            counted.commits,
            counted.files,
          ),
  };
}

async function countIncoming(
  core: Core,
  repo: RepoHandle,
  before: string,
  after: string,
): Promise<{ commits: number; files: number }> {
  if (before.length === 0 || after.length === 0 || before === after) {
    return { commits: 0, files: 0 };
  }
  const countRes = await core.git.exec(repo.root, ['rev-list', '--count', `${before}..${after}`], {
    allowNonZeroExit: true,
  });
  const commits = countRes.exitCode === 0 ? Number(countRes.stdout.trim()) || 0 : 0;
  const filesRes = await core.git.exec(repo.root, ['diff', '--name-only', '-z', before, after], {
    allowNonZeroExit: true,
  });
  const files =
    filesRes.exitCode === 0
      ? filesRes.stdout.split('\0').filter((p) => p.length > 0).length
      : 0;
  return { commits, files };
}

/**
 * The result notification standing in for IntelliJ's `Update Info` tab (D9):
 * what came in, and a "Show in Log" that opens the log filtered to exactly the
 * fetched range.
 */
export function reportUpdate(outcome: UpdateOutcome): void {
  if (!outcome.ok) {
    void vscode.window.showErrorMessage(
      vscode.l10n.t('Update Project: {0}', outcome.message.split('\n', 1)[0] ?? outcome.message),
    );
    return;
  }
  const showInLog = vscode.l10n.t('Show in Log');
  const actions = outcome.commitsPulled > 0 ? [showInLog] : [];
  // Deliberately not awaited: a notification carrying an action button stays
  // pending until the user dismisses it, and the update is already finished —
  // awaiting it would leave `showUpdateDialog` hanging on the notification.
  void vscode.window.showInformationMessage(outcome.message, ...actions).then((choice) => {
    if (choice !== showInLog) return undefined;
    return vscode.commands.executeCommand('gittree.log.setFilter', {
      sort: 'topo',
      range: { a: outcome.from, b: outcome.to },
    });
  });
}

/**
 * `Ctrl+T`. Opens the dialog unless the user ticked `Do not show again`, in
 * which case the remembered strategy runs directly — IntelliJ's behaviour, and
 * restorable through `gittree.update.configure`.
 */
export async function showUpdateDialog(
  deps: UpdateDialogDeps,
  repo: RepoHandle,
): Promise<UpdateOutcome | undefined> {
  const snap = repo.model.snapshot;
  if (snap.upstream === undefined) {
    void vscode.window.showInformationMessage(
      vscode.l10n.t('"{0}" has no upstream branch to update from.', snap.headRef ?? ''),
    );
    return undefined;
  }

  const setting = readSetting();
  if (setting !== 'ask') {
    const outcome = await applyUpdateResult(deps, repo, {
      action: 'update',
      strategy: setting,
      dontShowAgain: true,
    });
    reportUpdate(outcome);
    return outcome;
  }

  const params = await buildUpdateParams(deps.core, repo);
  const result = await openDialog<UpdateDialogParamsDto, UpdateDialogResultDto>({
    app: 'dialogs',
    dialog: 'update',
    title: vscode.l10n.t('Update Project'),
    params,
    extensionUri: deps.extensionUri,
    ...(deps.trace ? { trace: deps.trace } : {}),
  });
  if (!result) return undefined;

  if (result.dontShowAgain && result.action === 'update') {
    await setUpdateStrategy(result.strategy);
  }
  const outcome = await applyUpdateResult(deps, repo, result);
  reportUpdate(outcome);
  return outcome;
}

/** What `Ctrl+T` will do right now — `ask` means the dialog still opens. */
export function currentUpdateStrategy(): UpdateStrategySetting {
  return readSetting();
}

/**
 * The persistence half of the gear, separated from the QuickPick so tests (and
 * the dialog's `Do not show again`) drive the same code path the picker does.
 */
export async function setUpdateStrategy(value: UpdateStrategySetting): Promise<void> {
  await vscode.workspace
    .getConfiguration('gittree')
    .update('update.strategy', value, vscode.ConfigurationTarget.Workspace);
}

/**
 * The "gear" that brings the dialog back after `Do not show again` — IntelliJ
 * puts this in Settings; here it is a command, and the setting itself stays
 * editable in the Settings UI.
 */
export async function configureUpdateStrategy(): Promise<UpdateStrategySetting | undefined> {
  const current = readSetting();
  interface Choice extends vscode.QuickPickItem {
    value: UpdateStrategySetting;
  }
  const items: Choice[] = [
    {
      label: vscode.l10n.t('Ask every time'),
      description: vscode.l10n.t('Show the Update Project dialog'),
      value: 'ask',
    },
    {
      label: vscode.l10n.t('Merge'),
      description: vscode.l10n.t('Merge incoming changes into the current branch'),
      value: 'merge',
    },
    {
      label: vscode.l10n.t('Rebase'),
      description: vscode.l10n.t('Rebase the current branch on top of incoming changes'),
      value: 'rebase',
    },
  ];
  for (const item of items) if (item.value === current) item.picked = true;
  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: vscode.l10n.t('Update Project strategy (currently: {0})', current),
  });
  if (!picked) return undefined;
  await setUpdateStrategy(picked.value);
  return picked.value;
}

/** Shared by the command and the tests: the repo an update acts on. */
export function repoForUpdate(core: Core, arg?: unknown): RepoHandle | undefined {
  if (typeof arg === 'string' && arg.length > 0) {
    return core.repos.find((r) => canonicalKey(r.root) === canonicalKey(arg));
  }
  return undefined;
}
