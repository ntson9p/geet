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
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { Core, RepoHandle } from '../../core/core';
import { GitError } from '../../core/git/errors';
import { parseStatusV2 } from '../../core/git/parsers/statusV2';
import { detectInProgressOp } from '../../core/model/inProgressOp';
import { canonicalKey } from '../../core/repoDiscovery';
import { repoLabels } from '../../core/util/repoLabels';
import { SNAPSHOT_LABELS } from '../../localHistory/hooks';
import { confirmModal } from '../../ui/confirm';
import { splitUpstream } from './pushArgs';
import {
  buildDetachArgs,
  buildIntegrateArgs,
  buildReattachArgs,
  buildResetToRemoteArgs,
  buildUpdateFetchArgs,
  buildUpdateQuestion,
  hasStashableChanges,
  normalizeStrategySetting,
  planSetAside,
  updateChoices,
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
  /**
   * POST-P14ac: files left conflicted when git put the user's own changes
   * back after the update. git calls that success (exit 0, "Your changes are
   * safe in the stash"), so it has to be counted to be reported at all.
   */
  restoreConflicts?: number;
  /**
   * POST-P14af: the merge or rebase itself stopped on conflicts and is still
   * in progress — as opposed to one git refused to start. A push waiting on
   * this update is cancelled with IntelliJ's "conflicts during the update".
   */
  conflicts?: boolean;
}

/** Structural slice of phase06's conflict lifecycle — imported by shape, not module. */
interface ConflictLifecycleShape {
  lifecycle?: { expectConflict(repoRoot: string, source: 'stash-pop'): void };
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

/**
 * Keeps an answer as "what you chose last time". Shared with the push flow's
 * Push Rejected question (POST-P14af): IntelliJ keeps one update method for
 * both, and saves it from either dialog.
 */
export async function rememberStrategy(
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

/** A repository a project-wide update leaves alone, and why. */
export interface SkippedRepo {
  repo: RepoHandle;
  reason: string;
}

/** What one Update Project run covers. */
export interface UpdateScope {
  targets: RepoHandle[];
  skipped: SkippedRepo[];
}

/**
 * The repositories a project-wide Update Project touches (POST-P14ae) — every
 * one, as IntelliJ's does, except those it cannot update: a detached HEAD or a
 * branch with no upstream has nothing to update from, and a merge or rebase
 * already in progress is one git refuses to update over. Those are *skipped*,
 * not attempted — `runCommonAction`'s rule — so one repository mid-rebase
 * cannot stop the other six, and the question says so before anything runs.
 */
export function updateScope(repos: readonly RepoHandle[]): UpdateScope {
  const scope: UpdateScope = { targets: [], skipped: [] };
  for (const repo of repos) {
    const snap = repo.model.snapshot;
    const op = snap.inProgressOp?.kind;
    if (op !== undefined) {
      const name = op.startsWith('rebase') ? 'rebase' : op;
      scope.skipped.push({ repo, reason: vscode.l10n.t('a {0} is in progress', name) });
    } else if (snap.detached) {
      scope.skipped.push({ repo, reason: vscode.l10n.t('detached HEAD') });
    } else if (snap.upstream === undefined) {
      scope.skipped.push({ repo, reason: vscode.l10n.t('no upstream branch') });
    } else {
      scope.targets.push(repo);
    }
  }
  return scope;
}

/** Workspace-wide names, so a repository is called here what the sidebar calls it. */
function labelsFor(core: Core): (repo: RepoHandle) => string {
  const labels = repoLabels(core.repos.map((r) => r.root));
  return (repo) => labels.get(repo.root) ?? path.basename(repo.root);
}

function summaryOf(repo: RepoHandle): string {
  const snap = repo.model.snapshot;
  return vscode.l10n.t(
    '{0} ← {1} · {2} behind · {3} ahead',
    snap.headRef ?? '',
    snap.upstream ?? '',
    snap.behind ?? 0,
    snap.ahead ?? 0,
  );
}

/**
 * The Update Project question, or `undefined` when nothing can be updated.
 *
 * The buttons carry the verbs; the detail says what they act on, which a
 * dialog title alone never did — `develop ← origin/develop · 3 behind`, one
 * line per repository, named when the workspace has more than one, then any
 * repository being skipped and why. With `gittree.dialogs.showCommandLine`
 * on, one repository gets each button's exact commands, the lines the P13
 * dialogs showed as `will run:`; several get one sentence saying what each of
 * them runs, rather than two command lines per repository.
 */
export async function buildUpdatePrompt(
  deps: UpdateDialogDeps,
  scope: UpdateScope,
): Promise<UpdatePrompt | undefined> {
  const { targets, skipped } = scope;
  const only = targets.length === 1 ? targets[0] : undefined;
  if (targets.length === 0) return undefined;
  const label = labelsFor(deps.core);
  const named = deps.core.repos.length > 1;
  const remembered = rememberedUpdateStrategy(deps.state);
  const showCommands = vscode.workspace
    .getConfiguration('gittree')
    .get<boolean>('dialogs.showCommandLine', true);

  const lines = targets.map((repo) =>
    named ? `${label(repo)}: ${summaryOf(repo)}` : summaryOf(repo),
  );
  for (const s of skipped) {
    lines.push(vscode.l10n.t('{0}: skipped — {1}', label(s.repo), s.reason));
  }
  lines.push('');

  let choices: UpdateChoice[];
  if (only !== undefined) {
    const snap = only.model.snapshot;
    const upstream = snap.upstream ?? '';
    const remote = splitUpstream(upstream, await remoteNames(deps.core, only))?.remote;
    const question = buildUpdateQuestion(
      remembered,
      upstream,
      remote,
      // The command lines show what would be put aside given the tree as last
      // seen; the run reads status again and decides for itself.
      (strategy) =>
        planSetAside(snap.statusEntries, strategy, deps.core.git.caps.mergeAutostash),
    );
    choices = [...question.choices];
    if (showCommands) {
      for (const choice of choices) lines.push(`${choiceLabel(choice)}: ${question.commands[choice]}`);
    }
  } else {
    choices = updateChoices(remembered, false);
    if (showCommands) {
      lines.push(
        vscode.l10n.t(
          'Each repository runs git fetch --prune <its remote>, then git merge or git rebase onto its upstream, in the order listed. The update stops at the first repository that fails.',
        ),
      );
    }
  }
  if (!showCommands) {
    lines.push(
      vscode.l10n.t(
        'Merge incoming changes into the current branch, or rebase the current branch on top of incoming changes.',
      ),
    );
  }
  return {
    message: vscode.l10n.t('Update Project'),
    detail: lines.join('\n'),
    buttons: choices.map(choiceLabel),
    choices,
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
  // Intent-to-add paths still out of the index when the integrate step stopped
  // half-way — reported rather than put back, see the `finally` below.
  let leftUntracked: string[] = [];
  // Files left conflicted by git putting the user's own changes back.
  let restoreConflicts = 0;
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
        // POST-P14ac: decided from a status read *now*, inside the queue — the
        // model snapshot can be older than the working tree it describes.
        const status = await git.exec(
          repo.root,
          ['status', '--porcelain=v2', '-z', '--untracked-files=no'],
          { structured: true, noOptionalLocks: true, token },
        );
        const entries = parseStatusV2(status.stdout).entries;
        const aside = planSetAside(entries, strategy, core.git.caps.mergeAutostash);
        const stashes = aside.autostash && hasStashableChanges(entries);
        if (aside.detach.length > 0) {
          await git.exec(repo.root, buildDetachArgs(aside.detach), { token });
        }
        try {
          await git.exec(repo.root, buildIntegrateArgs(strategy, upstream, aside.autostash), {
            token,
          });
        } finally {
          if (aside.detach.length > 0) {
            // Put back only once the merge or rebase is over. Stopped on a
            // conflict, the autostash is still waiting to be re-applied when
            // the user finishes, and `git stash` cannot stand intent-to-add
            // entries — re-adding them now could fail that very step. Left
            // untracked they lose nothing: the file is on disk, and it stays
            // in its changelist, whose commit path adds it back with `-N`.
            const present = aside.detach.filter((p) => fs.existsSync(path.join(repo.root, p)));
            if (detectInProgressOp(repo.dirs.gitDir) !== undefined) {
              leftUntracked = present;
            } else if (present.length > 0) {
              await git.exec(repo.root, buildReattachArgs(present), {
                token,
                allowNonZeroExit: true,
              });
            }
          }
        }
        // Reached only when the merge or rebase itself finished. If putting
        // the stashed changes back then conflicted, git still exits 0, with no
        // merge or rebase in progress for the conflict lifecycle to name it
        // by — so count it here, and tell the lifecycle what it was. Told only
        // once it has happened, as the stash service does: a hint registered
        // in advance would outlive a clean update and mislabel the next,
        // unrelated conflict in this repository.
        if (stashes) {
          const after = await git.exec(
            repo.root,
            ['status', '--porcelain=v2', '-z', '--untracked-files=no'],
            { structured: true, noOptionalLocks: true, token },
          );
          restoreConflicts = parseStatusV2(after.stdout).entries.filter(
            (e) => e.kind === 'unmerged',
          ).length;
          if (restoreConflicts > 0) {
            (core.debugRegistry.get('phase06') as ConflictLifecycleShape | undefined)
              ?.lifecycle?.expectConflict(repo.root, 'stash-pop');
          }
        }
      },
    });
  } catch (err) {
    const first = err instanceof Error ? err.message : String(err);
    // One line: the notification shows only the first one.
    const message =
      leftUntracked.length === 0
        ? first
        : `${first} — ${vscode.l10n.t(
            '{0} file(s) added to VCS are unversioned until the {1} is finished; they stay in their changelist.',
            leftUntracked.length,
            strategy,
          )}`;
    // Stopped on conflicts — still in progress — or refused before starting?
    // The operation left on disk is the reliable answer; git's wording is not.
    const conflicts =
      (err instanceof GitError && err.kind === 'merge-conflict') ||
      detectInProgressOp(repo.dirs.gitDir) !== undefined;
    await repo.refresher.refreshNow();
    return {
      ok: false,
      commitsPulled: counted.commits,
      filesChanged: counted.files,
      from: before,
      to: after,
      message,
      ...(conflicts ? { conflicts: true } : {}),
    };
  }
  await repo.refresher.refreshNow();

  const summary =
    counted.commits === 0
      ? vscode.l10n.t('Already up to date.')
      : vscode.l10n.t(
          '{0}: {1} commit(s), {2} file(s) changed.',
          strategy === 'rebase' ? vscode.l10n.t('Rebased') : vscode.l10n.t('Merged'),
          counted.commits,
          counted.files,
        );
  return {
    ok: true,
    commitsPulled: counted.commits,
    filesChanged: counted.files,
    from: before,
    to: after,
    message:
      restoreConflicts === 0
        ? summary
        : `${summary} ${vscode.l10n.t(
            'Your local changes conflict with it in {0} file(s); a copy is kept in the stash.',
            restoreConflicts,
          )}`,
    ...(restoreConflicts > 0 ? { restoreConflicts } : {}),
  };
}

/**
 * What a pull brought in: the commits `source` (the branch pulled, as it is
 * now) has that HEAD did not have `before` — so a rebase's rewritten local
 * commits are not counted — and the files HEAD changed since.
 */
export async function countPulled(
  core: Core,
  repo: RepoHandle,
  before: string,
  source: string,
): Promise<{ commits: number; files: number }> {
  if (before.length === 0) return { commits: 0, files: 0 };
  const countRes = await core.git.exec(repo.root, ['rev-list', '--count', `${before}..${source}`], {
    allowNonZeroExit: true,
  });
  const commits = countRes.exitCode === 0 ? Number(countRes.stdout.trim()) || 0 : 0;
  if (commits === 0) return { commits: 0, files: 0 };
  const filesRes = await core.git.exec(repo.root, ['diff', '--name-only', '-z', before, 'HEAD'], {
    allowNonZeroExit: true,
  });
  const files =
    filesRes.exitCode === 0
      ? filesRes.stdout.split('\0').filter((p) => p.length > 0).length
      : 0;
  return { commits, files };
}

/** What `before..after` brought in: commits, and the files they changed. */
export async function countIncoming(
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
  /**
   * The repository updated, so `Show in Log` filters *its* log. Without it the
   * range went to whichever repository the log happened to show, where in a
   * multi-root workspace neither end of it need exist.
   */
  root?: string;
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
  // A conflicted restore is a warning, not a success toast: the update landed,
  // but the user now has conflict markers in files they were editing.
  const shown =
    (outcome.restoreConflicts ?? 0) > 0
      ? vscode.window.showWarningMessage(outcome.message, ...actions)
      : vscode.window.showInformationMessage(outcome.message, ...actions);
  void shown.then(async (choice) => {
    if (choice === showInLog) {
      if (options.root !== undefined) {
        await showRangeInLog(outcome, options.root);
      } else {
        await vscode.commands.executeCommand('gittree.log.openTab', {
          sort: 'topo',
          range: { a: outcome.from, b: outcome.to },
        });
      }
      return;
    }
    if (choice === dontAsk && remember !== undefined) {
      await rememberDontAskAgain(remember);
    }
  });
}

/**
 * `Ctrl+T` on one named repository — a Repositories row's context menu. Asks
 * Merge or Rebase unless the user chose `Don't Ask Again`, in which case that
 * strategy runs directly — IntelliJ's behaviour, and restorable through
 * `gittree.update.configure`.
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
  return updateOne(deps, repo, { targets: [repo], skipped: [] });
}

/** One repository: exact commands, `Reset` offered, `Show in Log` for it. */
async function updateOne(
  deps: UpdateDialogDeps,
  repo: RepoHandle,
  scope: UpdateScope,
): Promise<UpdateOutcome | undefined> {
  const setting = readSetting();
  if (setting !== 'ask') {
    const outcome = await applyUpdateResult(deps, repo, { action: 'update', strategy: setting });
    reportUpdate(outcome, { root: repo.root });
    return outcome;
  }

  const prompt = await buildUpdatePrompt(deps, scope);
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
    reportUpdate(outcome, { root: repo.root });
    return outcome;
  }

  // Saved before the update runs, as IntelliJ saves the radio on OK: the answer
  // is the user's choice whether or not this particular update succeeds.
  await rememberStrategy(deps.state, choice);
  const outcome = await applyUpdateResult(deps, repo, { action: 'update', strategy: choice });
  reportUpdate(outcome, { dontAskAgain: choice, root: repo.root });
  return outcome;
}

/** What a project-wide update did, repository by repository. */
export interface ProjectUpdateResult {
  /** In the order they ran; a stopped run ends with the one that failed. */
  results: Array<{ repo: RepoHandle; outcome: UpdateOutcome }>;
  skipped: SkippedRepo[];
  /** The repository the run stopped at, when one failed. */
  stoppedAt?: RepoHandle;
}

/**
 * `Ctrl+T` and `Update Project…` with no repository named: the **project**,
 * as IntelliJ's Update Project is (POST-P14ae). One question covers every
 * repository it can update; they then run in order and the run **stops at the
 * first failure** — the idiom `runCommitAcross` and `runCommonAction` share,
 * so a conflict in one repository is not followed by merges in the rest.
 *
 * With a single repository to update the flow is exactly the one-repository
 * one, so a single-root workspace — and a multi-root one where only one
 * repository tracks anything — sees no difference at all.
 */
export async function showProjectUpdate(
  deps: UpdateDialogDeps,
  repos: readonly RepoHandle[],
): Promise<ProjectUpdateResult | undefined> {
  const scope = updateScope(repos);
  const label = labelsFor(deps.core);
  if (scope.targets.length === 0) {
    void vscode.window.showInformationMessage(
      scope.skipped.length === 1 && scope.skipped[0] !== undefined
        ? vscode.l10n.t(
            'Nothing to update: {0} — {1}.',
            label(scope.skipped[0].repo),
            scope.skipped[0].reason,
          )
        : vscode.l10n.t('Nothing to update: no repository tracks a remote branch.'),
    );
    return undefined;
  }
  const first = scope.targets[0];
  if (scope.targets.length === 1 && first !== undefined) {
    const outcome = await updateOne(deps, first, scope);
    return outcome
      ? { results: [{ repo: first, outcome }], skipped: scope.skipped }
      : undefined;
  }

  const setting = readSetting();
  let strategy: UpdateStrategy;
  let asked = false;
  if (setting !== 'ask') {
    strategy = setting;
  } else {
    const prompt = await buildUpdatePrompt(deps, scope);
    if (!prompt) return undefined;
    const choice = await askUpdate(prompt);
    // `reset` is never offered across several repositories; treat anything
    // else the same as Cancel rather than trust an answer nobody was shown.
    if (choice !== 'merge' && choice !== 'rebase') return undefined;
    await rememberStrategy(deps.state, choice);
    strategy = choice;
    asked = true;
  }

  const result: ProjectUpdateResult = { results: [], skipped: scope.skipped };
  for (const repo of scope.targets) {
    const outcome = await applyUpdateResult(deps, repo, { action: 'update', strategy });
    result.results.push({ repo, outcome });
    if (!outcome.ok) {
      result.stoppedAt = repo;
      break;
    }
  }
  reportProjectUpdate(deps, result, scope, asked ? strategy : undefined);
  return result;
}

/**
 * One notification for the whole run — N toasts for N repositories would bury
 * the one that matters. A stop names where, what was already done and what
 * was never attempted; a finished run totals what came in and names anything
 * skipped or conflicted. `Show in Log` is offered only when exactly one
 * repository received commits: the log shows one repository at a time (D24),
 * and a range spanning several has nowhere to go.
 */
function reportProjectUpdate(
  deps: UpdateDialogDeps,
  result: ProjectUpdateResult,
  scope: UpdateScope,
  dontAskAgain: UpdateStrategy | undefined,
): void {
  const label = labelsFor(deps.core);
  const names = (repos: readonly RepoHandle[]): string => repos.map(label).join(', ');
  const done = result.results.filter((r) => r.outcome.ok).map((r) => r.repo);

  if (result.stoppedAt !== undefined) {
    const failed = result.results[result.results.length - 1]?.outcome;
    const reason = failed?.message.split('\n', 1)[0] ?? '';
    const untouched = scope.targets.slice(result.results.length);
    const parts = [vscode.l10n.t('Update Project stopped at {0}: {1}', label(result.stoppedAt), reason)];
    if (done.length > 0) parts.push(vscode.l10n.t('Already updated: {0}.', names(done)));
    if (untouched.length > 0) parts.push(vscode.l10n.t('Not attempted: {0}.', names(untouched)));
    void vscode.window.showErrorMessage(parts.join(' '));
    return;
  }

  const commits = result.results.reduce((n, r) => n + r.outcome.commitsPulled, 0);
  const files = result.results.reduce((n, r) => n + r.outcome.filesChanged, 0);
  const conflicted = result.results.filter((r) => (r.outcome.restoreConflicts ?? 0) > 0);
  const parts = [
    commits === 0
      ? vscode.l10n.t('{0} repositories already up to date.', result.results.length)
      : vscode.l10n.t(
          'Updated {0} repositories: {1} commit(s), {2} file(s) changed.',
          result.results.length,
          commits,
          files,
        ),
  ];
  if (conflicted.length > 0) {
    parts.push(
      vscode.l10n.t(
        'Your local changes conflict with what came in, in {0}; a copy is kept in the stash.',
        names(conflicted.map((r) => r.repo)),
      ),
    );
  }
  if (result.skipped.length > 0) {
    parts.push(vscode.l10n.t('Skipped: {0}.', names(result.skipped.map((s) => s.repo))));
  }

  const showInLog = vscode.l10n.t('Show in Log');
  const dontAsk = vscode.l10n.t("Don't Ask Again");
  const pulled = result.results.filter((r) => r.outcome.commitsPulled > 0);
  const single = pulled.length === 1 ? pulled[0] : undefined;
  const actions = [
    ...(single !== undefined ? [showInLog] : []),
    ...(dontAskAgain !== undefined ? [dontAsk] : []),
  ];
  const message = parts.join(' ');
  const shown =
    conflicted.length > 0
      ? vscode.window.showWarningMessage(message, ...actions)
      : vscode.window.showInformationMessage(message, ...actions);
  void shown.then(async (choice) => {
    if (choice === showInLog && single !== undefined) {
      await showRangeInLog(single.outcome, single.repo.root);
      return;
    }
    if (choice === dontAsk && dontAskAgain !== undefined) {
      await rememberDontAskAgain(dontAskAgain);
    }
  });
}

/**
 * The log, filtered to exactly what one update brought in — in *that*
 * repository, and in a Log tab of its own, so the filters of the tab you were
 * using survive.
 */
export async function showRangeInLog(outcome: UpdateOutcome, root: string): Promise<void> {
  await vscode.commands.executeCommand(
    'gittree.log.openTab',
    { sort: 'topo', range: { a: outcome.from, b: outcome.to } },
    root,
  );
}

async function rememberDontAskAgain(strategy: UpdateStrategy): Promise<void> {
  await setUpdateStrategy(strategy);
  // Say how to undo it: the question will not be there to remind anyone.
  void vscode.window.showInformationMessage(
    strategy === 'rebase'
      ? vscode.l10n.t(
          'Update Project will rebase without asking. Change this with "GitTree: Update Project Strategy…".',
        )
      : vscode.l10n.t(
          'Update Project will merge without asking. Change this with "GitTree: Update Project Strategy…".',
        ),
  );
}

/**
 * Update without asking (POST-P14ad): the remembered strategy — the setting,
 * else the last answer, else Merge — as IntelliJ's branch `Update` uses its
 * saved update method. What a branch row's `Update` runs on the checked-out
 * branch; `Update Project…` is the one that asks.
 */
export async function runRememberedUpdate(
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
  const outcome = await applyUpdateResult(deps, repo, {
    action: 'update',
    strategy: rememberedUpdateStrategy(deps.state),
  });
  reportUpdate(outcome, { root: repo.root });
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
