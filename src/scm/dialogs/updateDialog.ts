/**
 * Update Project, host half (P13-T2, gap analysis S4 · §2A "Update Project
 * dialog"): the Merge / Rebase question, the `Don't Ask Again` shortcut that
 * turns Ctrl+T into a direct action, `Reset to the Remote Branch` behind a
 * destructive confirmation and a P9 snapshot, and the result notification that
 * stands in for IntelliJ's `Update Info` tab (deviation D9).
 *
 * POST-P14ab: the question is a native modal message box rather than a
 * webview dialog in an editor tab (D30). A whole editor tab for two radio
 * buttons read as a stray page; the message box is modal and centred the way
 * IntelliJ's dialog is, and a two-way choice is what a pair of buttons is for.
 *
 * Every command comes from the vscode-free `updateArgs.ts`, so the question's
 * command lines and the execution cannot drift apart.
 */
import * as vscode from 'vscode';
import type { Core, RepoHandle } from '../../core/core';
import { canonicalKey } from '../../core/repoDiscovery';
import { SNAPSHOT_LABELS } from '../../localHistory/hooks';
import { confirmModal } from '../../ui/confirm';
import { splitUpstream } from './pushArgs';
import {
  buildIntegrateArgs,
  buildResetToRemoteArgs,
  buildUpdateFetchArgs,
  buildUpdateQuestion,
  normalizeStrategySetting,
  type UpdateChoice,
  type UpdateStrategy,
  type UpdateStrategySetting,
} from './updateArgs';

export interface UpdateDialogDeps {
  core: Core;
  extensionUri: vscode.Uri;
  trace?: (line: string) => void;
  /**
   * Where the last Merge/Rebase answer is kept. Workspace *state*, not a
   * setting: it changes on every answer, and writing a setting that often
   * would keep rewriting `.vscode/settings.json` — a file many repositories
   * track. IntelliJ keeps its equivalent in `workspace.xml` for the same
   * reason. Optional so a caller without one still gets IntelliJ's default.
   */
  state?: vscode.Memento;
}

/** What Update Project is asked to do — the question's answer, as data. */
export interface UpdateRequest {
  action: 'update' | 'reset';
  strategy: UpdateStrategy;
}

const LAST_STRATEGY_KEY = 'gittree.update.lastStrategy';

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

/**
 * The strategy an update uses when nobody is asked: the setting when it names
 * one, else the last answer to the question, else Merge — IntelliJ's default.
 *
 * IntelliJ keeps two things apart here and GitTree used to fold them into one
 * setting: *which* strategy (saved on every OK) and *whether to ask* (`Don't
 * show again`). Keeping the answer even while the question is still asked is
 * what lets an update that asks nothing — a branch row's `Update` — do what
 * the user chose last time.
 */
export function rememberedUpdateStrategy(state: vscode.Memento | undefined): UpdateStrategy {
  const setting = readSetting();
  if (setting !== 'ask') return setting;
  return state?.get<string>(LAST_STRATEGY_KEY) === 'rebase' ? 'rebase' : 'merge';
}

async function rememberStrategy(
  state: vscode.Memento | undefined,
  strategy: UpdateStrategy,
): Promise<void> {
  await state?.update(LAST_STRATEGY_KEY, strategy);
}

async function remoteNames(core: Core, repo: RepoHandle): Promise<string[]> {
  const res = await core.git.exec(repo.root, ['remote']);
  return res.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

/** The modal as it will be shown — kept whole so tests can read what was asked. */
export interface UpdatePrompt {
  message: string;
  detail: string;
  /** Button labels, index-aligned with `choices`. */
  buttons: string[];
  choices: UpdateChoice[];
}

function choiceLabel(choice: UpdateChoice): string {
  switch (choice) {
    case 'merge':
      return vscode.l10n.t('Merge');
    case 'rebase':
      return vscode.l10n.t('Rebase');
    case 'reset':
      return vscode.l10n.t('Reset to the Remote Branch');
  }
}

/**
 * The Update Project question for one repository, or `undefined` when there is
 * nothing to update from.
 *
 * The buttons carry the verbs; the detail line says what they act on, which a
 * dialog title alone never did — `develop ← origin/develop · 3 behind`. With
 * `gittree.dialogs.showCommandLine` on, each button's exact commands follow,
 * the same lines the P13 dialogs showed as `will run:`; off, IntelliJ's own
 * wording for the two options stands in for them.
 */
export async function buildUpdatePrompt(
  deps: UpdateDialogDeps,
  repo: RepoHandle,
): Promise<UpdatePrompt | undefined> {
  const snap = repo.model.snapshot;
  const upstream = snap.upstream;
  if (upstream === undefined) return undefined;
  const remote = splitUpstream(upstream, await remoteNames(deps.core, repo))?.remote;
  const question = buildUpdateQuestion(rememberedUpdateStrategy(deps.state), upstream, remote);

  const lines = [
    vscode.l10n.t(
      '{0} ← {1} · {2} behind · {3} ahead',
      snap.headRef ?? '',
      upstream,
      snap.behind ?? 0,
      snap.ahead ?? 0,
    ),
    '',
  ];
  if (vscode.workspace.getConfiguration('gittree').get<boolean>('dialogs.showCommandLine', true)) {
    for (const choice of question.choices) {
      lines.push(`${choiceLabel(choice)}: ${question.commands[choice]}`);
    }
  } else {
    lines.push(
      vscode.l10n.t(
        'Merge incoming changes into the current branch, or rebase the current branch on top of incoming changes.',
      ),
    );
  }
  return {
    message: vscode.l10n.t('Update Project'),
    detail: lines.join('\n'),
    buttons: question.choices.map(choiceLabel),
    choices: [...question.choices],
  };
}

let lastPrompt: UpdatePrompt | undefined;

/** Test seam: the question most recently put to the user, if any. */
export function lastUpdatePrompt(): UpdatePrompt | undefined {
  return lastPrompt;
}

/** Test seam: forget the last question, so a test can prove none was asked. */
export function clearLastUpdatePrompt(): void {
  lastPrompt = undefined;
}

/**
 * Puts the question. `undefined` is Cancel, Escape or closing the box.
 *
 * A native modal cannot be clicked from a test, so `GITTREE_TEST_UPDATE_CHOICE`
 * answers it (`merge` | `rebase` | `reset` | `cancel`), the same kind of seam
 * as `GITTREE_TEST_AUTOCONFIRM`. The prompt is recorded either way, so a test
 * sees exactly what a user would have been asked.
 */
async function askUpdate(prompt: UpdatePrompt): Promise<UpdateChoice | undefined> {
  lastPrompt = prompt;
  const seam = process.env['GITTREE_TEST_UPDATE_CHOICE'];
  if (seam !== undefined) {
    return prompt.choices.find((c) => c === seam);
  }
  const picked = await vscode.window.showInformationMessage(
    prompt.message,
    { modal: true, detail: prompt.detail },
    ...prompt.buttons,
  );
  const index = picked === undefined ? -1 : prompt.buttons.indexOf(picked);
  return index >= 0 ? prompt.choices[index] : undefined;
}

async function revParse(core: Core, repo: RepoHandle, ref: string): Promise<string | undefined> {
  const res = await core.git.exec(repo.root, ['rev-parse', '--verify', '--quiet', ref], {
    allowNonZeroExit: true,
  });
  return res.exitCode === 0 ? res.stdout.trim() : undefined;
}

/**
 * The accept half, separated so integration tests drive it with exactly the
 * answer the question returns. Returns what happened, for the notification and
 * for the tests.
 */
export async function applyUpdateResult(
  deps: UpdateDialogDeps,
  repo: RepoHandle,
  result: UpdateRequest,
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
  const remote = splitUpstream(upstream, await remoteNames(core, repo))?.remote;

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

export interface ReportOptions {
  /**
   * The strategy the user just answered the question with. Set only when a
   * question was actually asked: it puts `Don't Ask Again` on the result,
   * where IntelliJ has a `Don't show again` checkbox in the dialog — a native
   * message box cannot hold a checkbox (D30).
   */
  dontAskAgain?: UpdateStrategy;
}

/**
 * The result notification standing in for IntelliJ's `Update Info` tab (D9):
 * what came in, and a "Show in Log" that opens the log filtered to exactly the
 * fetched range.
 */
export function reportUpdate(outcome: UpdateOutcome, options: ReportOptions = {}): void {
  if (!outcome.ok) {
    void vscode.window.showErrorMessage(
      vscode.l10n.t('Update Project: {0}', outcome.message.split('\n', 1)[0] ?? outcome.message),
    );
    return;
  }
  const showInLog = vscode.l10n.t('Show in Log');
  const dontAsk = vscode.l10n.t("Don't Ask Again");
  const actions = outcome.commitsPulled > 0 ? [showInLog] : [];
  const remember = options.dontAskAgain;
  if (remember !== undefined) actions.push(dontAsk);
  // Deliberately not awaited: a notification carrying an action button stays
  // pending until the user dismisses it, and the update is already finished —
  // awaiting it would leave `showUpdateDialog` hanging on the notification.
  void vscode.window.showInformationMessage(outcome.message, ...actions).then(async (choice) => {
    if (choice === showInLog) {
      await vscode.commands.executeCommand('gittree.log.setFilter', {
        sort: 'topo',
        range: { a: outcome.from, b: outcome.to },
      });
      return;
    }
    if (choice === dontAsk && remember !== undefined) {
      await setUpdateStrategy(remember);
      // Say how to undo it: the question will not be there to remind anyone.
      void vscode.window.showInformationMessage(
        remember === 'rebase'
          ? vscode.l10n.t(
              'Update Project will rebase without asking. Change this with "GitTree: Update Project Strategy…".',
            )
          : vscode.l10n.t(
              'Update Project will merge without asking. Change this with "GitTree: Update Project Strategy…".',
            ),
      );
    }
  });
}

/**
 * `Ctrl+T`. Asks Merge or Rebase unless the user chose `Don't Ask Again`, in
 * which case that strategy runs directly — IntelliJ's behaviour, and
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
    const outcome = await applyUpdateResult(deps, repo, { action: 'update', strategy: setting });
    reportUpdate(outcome);
    return outcome;
  }

  const prompt = await buildUpdatePrompt(deps, repo);
  if (!prompt) return undefined;
  const choice = await askUpdate(prompt);
  if (choice === undefined) return undefined;

  if (choice === 'reset') {
    // `strategy` is unused on the reset path; the remembered one is passed so
    // the request stays a complete answer rather than a special case.
    const outcome = await applyUpdateResult(deps, repo, {
      action: 'reset',
      strategy: rememberedUpdateStrategy(deps.state),
    });
    reportUpdate(outcome);
    return outcome;
  }

  // Saved before the update runs, as IntelliJ saves the radio on OK: the answer
  // is the user's choice whether or not this particular update succeeds.
  await rememberStrategy(deps.state, choice);
  const outcome = await applyUpdateResult(deps, repo, { action: 'update', strategy: choice });
  reportUpdate(outcome, { dontAskAgain: choice });
  return outcome;
}

/** What `Ctrl+T` will do right now — `ask` means the question is still asked. */
export function currentUpdateStrategy(): UpdateStrategySetting {
  return readSetting();
}

/**
 * The persistence half of the gear, separated from the QuickPick so tests (and
 * the result's `Don't Ask Again`) drive the same code path the picker does.
 */
export async function setUpdateStrategy(value: UpdateStrategySetting): Promise<void> {
  await vscode.workspace
    .getConfiguration('gittree')
    .update('update.strategy', value, vscode.ConfigurationTarget.Workspace);
}

/**
 * The "gear" that brings the question back after `Don't Ask Again` — IntelliJ
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
      description: vscode.l10n.t('Ask Merge or Rebase on every update'),
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
