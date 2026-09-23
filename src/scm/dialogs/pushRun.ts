/**
 * Running a push (POST-P14af): the push itself, IntelliJ's `Push Rejected`
 * question when the remote has commits the branch does not, the update that
 * answers it, the second push, and one report for all of it.
 *
 * IntelliJ never leaves "the remote moved on" as an error for the user to go
 * and fix. It asks Merge or Rebase — with the update method used last time as
 * the default — updates exactly as Update Project would, and pushes again.
 * GitTree used to stop at "Pull (or fetch and rebase) before pushing", or,
 * from the Push dialog, at "Push failed: To <url>": the first line of git's
 * output, which names the remote and not the problem.
 *
 * The question is a native modal message box, as Update Project's is (D30),
 * and for the same reason `Remember the update method and update silently in
 * the future` moves to the result as `Don't Ask Again` (D32). What that writes
 * is IntelliJ's own setting, `Auto-update if push of the current branch was
 * rejected` — `gittree.push.autoUpdateIfRejected`.
 */
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { Core, RepoHandle } from '../../core/core';
import { GitError } from '../../core/git/errors';
import { repoLabels } from '../../core/util/repoLabels';
import { formatGitCommands } from './commandLine';
import { splitUpstream } from './pushArgs';
import {
  canUpdateAndRetry,
  isForcePush,
  MAX_PUSH_ATTEMPTS,
  pushFailureLine,
  pushRejectedChoices,
  pushRejectionOf,
  type RejectedRef,
} from './pushRejection';
import { buildUpdatePlan, planSetAside, type UpdateStrategy } from './updateArgs';
import {
  applyUpdateResult,
  rememberedUpdateStrategy,
  rememberStrategy,
  showRangeInLog,
  type UpdateDialogDeps,
  type UpdateOutcome,
} from './updateDialog';

/** One push to run: a local branch to a branch on a remote, and the argv that does it. */
export interface PushTarget {
  readonly repo: RepoHandle;
  /** The local branch pushed. */
  readonly branch: string;
  readonly remote: string;
  readonly remoteBranch: string;
  /** The whole command, `push` first. Run again as-is after an update. */
  readonly args: readonly string[];
}

/** The update a rejected push ran so that it could go through. */
export interface PushUpdate {
  readonly strategy: UpdateStrategy;
  /**
   * Every round folded into one: `from` is the upstream before the first
   * fetch and `to` the upstream after the last, so `Show in Log` spans all
   * that came in, and `commitsPulled` counts all of it.
   */
  readonly outcome: UpdateOutcome;
  /** The question was put — so `Don't Ask Again` has an answer to keep. */
  readonly asked: boolean;
}

export type PushResult =
  | {
      kind: 'pushed';
      target: PushTarget;
      /** Commits the push sent — including a merge commit the update made. */
      commits: number;
      /** The remote branch did not exist before. */
      newBranch: boolean;
      update?: PushUpdate;
    }
  | {
      kind: 'rejected';
      target: PushTarget;
      ref: RejectedRef;
      /** IntelliJ would have offered Merge or Rebase (`canUpdateAndRetry`). */
      updatable: boolean;
    }
  | { kind: 'update-failed'; target: PushTarget; update: PushUpdate }
  | { kind: 'failed'; target: PushTarget; message: string; error: unknown };

const AUTO_UPDATE_SETTING = 'push.autoUpdateIfRejected';

function autoUpdateIfRejected(): boolean {
  return vscode.workspace.getConfiguration('gittree').get<boolean>(AUTO_UPDATE_SETTING, false);
}

/** The persistence half of `Don't Ask Again`, separated so tests drive the same path. */
export async function setAutoUpdateIfRejected(value: boolean): Promise<void> {
  await vscode.workspace
    .getConfiguration('gittree')
    .update(AUTO_UPDATE_SETTING, value, vscode.ConfigurationTarget.Workspace);
}

function showCommandLine(): boolean {
  return vscode.workspace.getConfiguration('gittree').get<boolean>('dialogs.showCommandLine', true);
}

/** Workspace-wide names, so a repository is called here what the sidebar calls it. */
function labelsFor(core: Core): (repo: RepoHandle) => string {
  const labels = repoLabels(core.repos.map((r) => r.root));
  return (repo) => labels.get(repo.root) ?? path.basename(repo.root);
}

/**
 * A local branch pushed to the branch it tracks, or `undefined` when it
 * tracks nothing (or its upstream is gone) — for which the caller keeps its
 * own publish path. The refspec is explicit, as the Push dialog's is:
 * `<branch>:refs/heads/<upstream's name>` on the upstream's own remote, so a
 * branch tracking `upstream/main` is not pushed to some `origin`.
 */
export async function upstreamPushTarget(
  core: Core,
  repo: RepoHandle,
  branch: string,
): Promise<PushTarget | undefined> {
  const ref = repo.model.snapshot.refs.find((r) => r.type === 'head' && r.name === branch);
  const upstream = ref?.upstreamGone === true ? undefined : ref?.upstream;
  if (upstream === undefined) return undefined;
  const res = await core.git.exec(repo.root, ['remote'], { structured: true });
  const remotes = res.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const split = splitUpstream(upstream, remotes);
  if (split === undefined) return undefined;
  return {
    repo,
    branch,
    remote: split.remote,
    remoteBranch: split.branch,
    args: ['push', split.remote, `${branch}:refs/heads/${split.branch}`],
  };
}

/**
 * What the push will send, counted before it runs: `<tracking>..<branch>`, or
 * for a branch the remote does not have yet, whatever that remote has
 * nowhere — the rule the Push dialog's commit list uses.
 */
async function countOutgoing(
  core: Core,
  target: PushTarget,
): Promise<{ commits: number; newBranch: boolean }> {
  const tracking = `refs/remotes/${target.remote}/${target.remoteBranch}`;
  const local = `refs/heads/${target.branch}`;
  const known = await core.git.exec(
    target.repo.root,
    ['rev-parse', '--verify', '--quiet', tracking],
    { allowNonZeroExit: true },
  );
  const newBranch = known.exitCode !== 0;
  const range = newBranch ? [local, '--not', `--remotes=${target.remote}`] : [`${tracking}..${local}`];
  const res = await core.git.exec(target.repo.root, ['rev-list', '--count', ...range], {
    allowNonZeroExit: true,
  });
  return { commits: res.exitCode === 0 ? Number(res.stdout.trim()) || 0 : 0, newBranch };
}

async function pushOnce(core: Core, target: PushTarget): Promise<PushResult> {
  const { repo } = target;
  const outgoing = await countOutgoing(core, target);
  try {
    await repo.queue.enqueue({
      label: vscode.l10n.t('Push {0}', target.branch),
      kind: 'mutate',
      run: async (git, token) => {
        await git.exec(repo.root, [...target.args], { token });
      },
    });
  } catch (err) {
    const stderr = err instanceof GitError ? err.stderr : '';
    const ref = pushRejectionOf(stderr);
    if (ref !== undefined) {
      const snap = repo.model.snapshot;
      return {
        kind: 'rejected',
        target,
        ref,
        updatable: canUpdateAndRetry({
          rejection: ref.rejection,
          force: isForcePush(target.args),
          current: !snap.detached && snap.headRef === target.branch,
          toUpstream: snap.upstream === `${target.remote}/${target.remoteBranch}`,
          busy: snap.inProgressOp !== undefined,
        }),
      };
    }
    const message =
      stderr.length > 0 ? pushFailureLine(stderr) : err instanceof Error ? err.message : String(err);
    return { kind: 'failed', target, message, error: err };
  }
  await repo.refresher.refreshNow();
  return { kind: 'pushed', target, commits: outgoing.commits, newBranch: outgoing.newBranch };
}

/**
 * Runs every push, then answers the rejected ones the IntelliJ way.
 *
 * All pushes go first, as IntelliJ's do, so one question covers every
 * repository the remote turned away. The update-and-push rounds then run in
 * order and **stop at the first that does not go through** — the idiom Update
 * Project and every other fan-out share, so a conflict in one repository is
 * not followed by merges in the rest. Those keep their rejection.
 */
export async function runPushes(
  deps: UpdateDialogDeps,
  targets: readonly PushTarget[],
): Promise<PushResult[]> {
  const results: PushResult[] = [];
  for (const target of targets) results.push(await pushOnce(deps.core, target));

  const rejected = results.flatMap((r, i) => (r.kind === 'rejected' && r.updatable ? [i] : []));
  if (rejected.length === 0) return results;

  const decision = await decideUpdate(
    deps,
    rejected.map((i) => results[i]!.target),
  );
  if (decision === undefined) return results;

  for (const i of rejected) {
    const next = await updateAndPush(deps, results[i]!.target, decision);
    results[i] = next;
    if (next.kind !== 'pushed') break;
  }
  return results;
}

interface UpdateDecision {
  strategy: UpdateStrategy;
  asked: boolean;
}

/**
 * Unpushed merge commits of the user's own — what a rebase would flatten.
 * IntelliJ checks the same range (`GitRebaseOverMergeProblem`).
 */
async function hasUnpushedMerges(core: Core, targets: readonly PushTarget[]): Promise<boolean> {
  for (const t of targets) {
    const res = await core.git.exec(
      t.repo.root,
      [
        'rev-list',
        '--merges',
        '--count',
        `refs/remotes/${t.remote}/${t.remoteBranch}..refs/heads/${t.branch}`,
      ],
      { allowNonZeroExit: true },
    );
    if (res.exitCode === 0 && (Number(res.stdout.trim()) || 0) > 0) return true;
  }
  return false;
}

async function decideUpdate(
  deps: UpdateDialogDeps,
  targets: readonly PushTarget[],
): Promise<UpdateDecision | undefined> {
  const merges = await hasUnpushedMerges(deps.core, targets);
  const remembered = rememberedUpdateStrategy(deps.state);
  // Silent only while that is safe: a remembered Rebase over unpushed merge
  // commits would flatten them, so the question comes back for that one case.
  if (autoUpdateIfRejected() && !(merges && remembered === 'rebase')) {
    return { strategy: remembered, asked: false };
  }
  const prompt = buildPushRejectedPrompt(deps, targets, merges);
  const choice = await askPushRejected(prompt);
  if (choice === undefined) return undefined;
  // The answer is the update method from now on, as it is in IntelliJ — save
  // for a Merge the merge-commit warning steered the user into, which says
  // nothing about what they want next time. IntelliJ hides its `Remember`
  // checkbox in that case, and `Don't Ask Again` is withheld to match.
  if (!merges) await rememberStrategy(deps.state, choice);
  return { strategy: choice, asked: !merges };
}

/** Folds a later update round into the earlier ones. */
function fold(first: UpdateOutcome, next: UpdateOutcome, total: number): UpdateOutcome {
  return next === first
    ? next
    : {
        ...next,
        from: first.from,
        commitsPulled: total,
        filesChanged: first.filesChanged + next.filesChanged,
        ...((first.restoreConflicts ?? 0) + (next.restoreConflicts ?? 0) > 0
          ? { restoreConflicts: (first.restoreConflicts ?? 0) + (next.restoreConflicts ?? 0) }
          : {}),
      };
}

async function updateAndPush(
  deps: UpdateDialogDeps,
  target: PushTarget,
  decision: UpdateDecision,
): Promise<PushResult> {
  let first: UpdateOutcome | undefined;
  let total = 0;
  for (let attempt = 1; ; attempt++) {
    const outcome = await applyUpdateResult(deps, target.repo, {
      action: 'update',
      strategy: decision.strategy,
    });
    total += outcome.commitsPulled;
    first ??= outcome;
    const update: PushUpdate = {
      strategy: decision.strategy,
      asked: decision.asked,
      outcome: fold(first, outcome, total),
    };
    if (!outcome.ok) return { kind: 'update-failed', target, update };
    const pushed = await pushOnce(deps.core, target);
    if (pushed.kind === 'pushed') return { ...pushed, update };
    // The remote moved again while this round ran: IntelliJ goes round again
    // with the same answer rather than asking twice.
    if (pushed.kind === 'rejected' && pushed.updatable && attempt < MAX_PUSH_ATTEMPTS) continue;
    return pushed;
  }
}

// ---- the question -------------------------------------------------------------

/** The modal as it will be shown — kept whole so tests can read what was asked. */
export interface PushRejectedPrompt {
  message: string;
  detail: string;
  /** Button labels, index-aligned with `choices`. */
  buttons: string[];
  choices: UpdateStrategy[];
}

function choiceLabel(choice: UpdateStrategy, merges: boolean): string {
  if (choice === 'merge') return vscode.l10n.t('Merge');
  return merges ? vscode.l10n.t('Rebase Anyway') : vscode.l10n.t('Rebase');
}

/**
 * IntelliJ's `Push Rejected` dialog as a message box: its sentence, naming
 * the branch — and the repository, in a workspace with more than one — then,
 * with `gittree.dialogs.showCommandLine` on, what each button runs.
 */
export function buildPushRejectedPrompt(
  deps: UpdateDialogDeps,
  targets: readonly PushTarget[],
  merges: boolean,
): PushRejectedPrompt {
  const label = labelsFor(deps.core);
  const choices = pushRejectedChoices(rememberedUpdateStrategy(deps.state), merges);
  const only = targets.length === 1 ? targets[0] : undefined;
  const lines: string[] = [];
  if (only !== undefined) {
    lines.push(
      deps.core.repos.length > 1
        ? vscode.l10n.t(
            'Push of the current branch "{0}" in {1} was rejected. Remote changes need to be merged before pushing.',
            only.branch,
            label(only.repo),
          )
        : vscode.l10n.t(
            'Push of the current branch "{0}" was rejected. Remote changes need to be merged before pushing.',
            only.branch,
          ),
    );
  } else {
    lines.push(vscode.l10n.t('Push of the current branch was rejected in:'));
    for (const t of targets) {
      lines.push(`${label(t.repo)}: ${t.branch} → ${t.remote}/${t.remoteBranch}`);
    }
    lines.push(vscode.l10n.t('Remote changes need to be merged before pushing.'));
  }
  if (merges) {
    lines.push(
      '',
      vscode.l10n.t(
        'Merge is highly recommended here: there are merge commits that have not been pushed, and rebasing them can lead to problems.',
      ),
    );
  }
  if (showCommandLine()) {
    lines.push('');
    if (only !== undefined) {
      const upstream = `${only.remote}/${only.remoteBranch}`;
      const entries = only.repo.model.snapshot.statusEntries;
      for (const choice of choices) {
        const aside = planSetAside(entries, choice, deps.core.git.caps.mergeAutostash);
        const plan = [...buildUpdatePlan('update', choice, upstream, only.remote, aside), [...only.args]];
        lines.push(`${choiceLabel(choice, merges)}: ${formatGitCommands(plan)}`);
      }
    } else {
      lines.push(
        vscode.l10n.t(
          'Each repository runs git fetch --prune <its remote>, then git merge or git rebase onto its upstream, then pushes again, in the order listed. The update stops at the first repository that fails.',
        ),
      );
    }
  }
  return {
    message: vscode.l10n.t('Push Rejected'),
    detail: lines.join('\n'),
    buttons: choices.map((c) => choiceLabel(c, merges)),
    choices,
  };
}

let lastPrompt: PushRejectedPrompt | undefined;

/** Test seam: the Push Rejected question most recently put, if any. */
export function lastPushRejectedPrompt(): PushRejectedPrompt | undefined {
  return lastPrompt;
}

/** Test seam: forget it, so a test can prove none was asked. */
export function clearLastPushRejectedPrompt(): void {
  lastPrompt = undefined;
}

/**
 * Puts the question; `undefined` is Cancel, Escape or closing the box. A
 * warning, as IntelliJ's dialog is. `GITTREE_TEST_PUSH_REJECTED_CHOICE`
 * (`merge` | `rebase` | `cancel`) answers it in tests, the same kind of seam
 * as `GITTREE_TEST_UPDATE_CHOICE`; the prompt is recorded either way.
 */
async function askPushRejected(prompt: PushRejectedPrompt): Promise<UpdateStrategy | undefined> {
  lastPrompt = prompt;
  const seam = process.env['GITTREE_TEST_PUSH_REJECTED_CHOICE'];
  if (seam !== undefined) return prompt.choices.find((c) => c === seam);
  const picked = await vscode.window.showWarningMessage(
    prompt.message,
    { modal: true, detail: prompt.detail },
    ...prompt.buttons,
  );
  const index = picked === undefined ? -1 : prompt.buttons.indexOf(picked);
  return index >= 0 ? prompt.choices[index] : undefined;
}

// ---- the report ---------------------------------------------------------------

function firstLineOf(text: string): string {
  return text.split('\n', 1)[0] ?? text;
}

function pushedSentence(r: Extract<PushResult, { kind: 'pushed' }>): string {
  const where = `${r.target.remote}/${r.target.remoteBranch}`;
  if (r.newBranch) return vscode.l10n.t('Pushed {0} to new branch {1}.', r.target.branch, where);
  if (r.commits === 0) return vscode.l10n.t('Nothing to push: {0} is up to date.', where);
  return r.commits === 1
    ? vscode.l10n.t('Pushed 1 commit to {0}.', where)
    : vscode.l10n.t('Pushed {0} commits to {1}.', r.commits, where);
}

function updateSentence(update: PushUpdate): string {
  const n = update.outcome.commitsPulled;
  const parts: string[] = [];
  if (n > 0) {
    if (update.strategy === 'rebase') {
      parts.push(
        n === 1
          ? vscode.l10n.t('Rebased onto 1 incoming commit first.')
          : vscode.l10n.t('Rebased onto {0} incoming commits first.', n),
      );
    } else {
      parts.push(
        n === 1
          ? vscode.l10n.t('Merged 1 incoming commit first.')
          : vscode.l10n.t('Merged {0} incoming commits first.', n),
      );
    }
  }
  const conflicted = update.outcome.restoreConflicts ?? 0;
  if (conflicted > 0) {
    parts.push(
      vscode.l10n.t(
        'Your local changes conflict with what came in, in {0} file(s); a copy is kept in the stash.',
        conflicted,
      ),
    );
  }
  return parts.join(' ');
}

/** One push's outcome, in IntelliJ's words where IntelliJ has them. */
export function describePush(r: PushResult): string {
  const where = `${r.target.remote}/${r.target.remoteBranch}`;
  switch (r.kind) {
    case 'pushed':
      return r.update === undefined
        ? pushedSentence(r)
        : [pushedSentence(r), updateSentence(r.update)].filter((s) => s.length > 0).join(' ');
    case 'rejected':
      if (r.ref.rejection === 'behind') return vscode.l10n.t('Push to {0} was rejected.', where);
      if (r.ref.rejection === 'stale') {
        return vscode.l10n.t(
          'Force push to {0} was rejected: the remote branch moved since your last fetch. Fetch, check the new commits, then decide again.',
          where,
        );
      }
      return vscode.l10n.t('Push to {0} was rejected ({1}).', where, r.ref.reason);
    case 'update-failed':
      return r.update.outcome.conflicts === true
        ? vscode.l10n.t(
            'Push was canceled, because there were conflicts during the update. Check that the conflicts were resolved correctly, then push again.',
          )
        : vscode.l10n.t(
            'Push was canceled, because the update failed: {0}',
            firstLineOf(r.update.outcome.message),
          );
    case 'failed':
      // "failed to push some refs" restates the headline; the console has
      // what actually refused it (a hook's own output, say).
      return r.message.length === 0 || /^failed to push/iu.test(r.message)
        ? vscode.l10n.t('Push to {0} failed.', where)
        : vscode.l10n.t('Push to {0} failed: {1}', where, r.message);
  }
}

/** The line a test — or a log — reads for one push. Not shown to the user. */
export function pushOutcomeLine(r: PushResult): string {
  const where = `${r.target.branch} → ${r.target.remote}/${r.target.remoteBranch}`;
  switch (r.kind) {
    case 'pushed':
      return `${where}: ${r.update === undefined ? 'pushed' : `pushed after ${r.update.strategy}`}`;
    case 'rejected':
      return `${where}: rejected (${r.ref.reason})`;
    case 'update-failed':
      return `${where}: not pushed, the update ${r.update.outcome.conflicts === true ? 'stopped on conflicts' : 'failed'}: ${firstLineOf(r.update.outcome.message)}`;
    case 'failed':
      return `${where}: ${r.message}`;
  }
}

export interface PushReportOptions {
  /**
   * One push that failed for a reason GitTree classifies — authentication, a
   * locked index — goes to the P10-T4 error dialog with its Help and Report
   * Issue, rather than to a one-line notification.
   */
  presentFailure?: (err: GitError) => Promise<void>;
}

async function rememberAutoUpdate(strategy: UpdateStrategy): Promise<void> {
  await setAutoUpdateIfRejected(true);
  // Say how to undo it: the question will not be there to remind anyone.
  void vscode.window.showInformationMessage(
    strategy === 'rebase'
      ? vscode.l10n.t(
          'A rejected push will now rebase and push again without asking. Turn this off with the setting gittree.push.autoUpdateIfRejected.',
        )
      : vscode.l10n.t(
          'A rejected push will now merge and push again without asking. Turn this off with the setting gittree.push.autoUpdateIfRejected.',
        ),
  );
}

/**
 * One notification for the whole push — IntelliJ's balloon: `Pushed 2
 * commits to origin/main`, `Push to origin/main was rejected`, `Push was
 * canceled, because there were conflicts during the update`. Its links become
 * actions: `Show Details` opens the Console tab (IntelliJ's "Show details in
 * console"), `Show in Log` stands in for "View files updated during the push"
 * (D9: no Update Info tab), and `Don't Ask Again` is the dialog's checkbox.
 */
export function reportPushes(
  core: Core,
  results: readonly PushResult[],
  options: PushReportOptions = {},
): void {
  if (results.length === 0) return;
  const only = results.length === 1 ? results[0] : undefined;
  if (
    only?.kind === 'failed' &&
    options.presentFailure !== undefined &&
    only.error instanceof GitError &&
    only.error.kind !== 'unknown'
  ) {
    void options.presentFailure(only.error);
    return;
  }

  const label = labelsFor(core);
  const sentences = results.map((r) =>
    results.length > 1 ? `${label(r.target.repo)}: ${describePush(r)}` : describePush(r),
  );
  const failed = results.some(
    (r) => r.kind === 'failed' || (r.kind === 'update-failed' && r.update.outcome.conflicts !== true),
  );
  const warned = results.some(
    (r) =>
      r.kind === 'rejected' ||
      r.kind === 'update-failed' ||
      (r.kind === 'pushed' && (r.update?.outcome.restoreConflicts ?? 0) > 0),
  );
  const trouble = results.some((r) => r.kind !== 'pushed');
  const updated = results.flatMap((r) =>
    (r.kind === 'pushed' || r.kind === 'update-failed') &&
    r.update !== undefined &&
    r.update.outcome.commitsPulled > 0
      ? [{ root: r.target.repo.root, outcome: r.update.outcome }]
      : [],
  );
  // The log shows one repository at a time (D24): a range spanning several
  // has nowhere to go.
  const single = updated.length === 1 ? updated[0] : undefined;
  const remember = results.find(
    (r): r is Extract<PushResult, { kind: 'pushed' }> =>
      r.kind === 'pushed' && r.update?.asked === true,
  )?.update?.strategy;

  const showInLog = vscode.l10n.t('Show in Log');
  const dontAsk = vscode.l10n.t("Don't Ask Again");
  const details = vscode.l10n.t('Show Details');
  const actions = [
    ...(single !== undefined ? [showInLog] : []),
    ...(remember !== undefined ? [dontAsk] : []),
    ...(trouble ? [details] : []),
  ];
  const message = sentences.join(' ');
  // Not awaited: a notification with actions stays pending until dismissed,
  // and the push is already over — awaiting would hang every caller on it.
  const shown = failed
    ? vscode.window.showErrorMessage(message, ...actions)
    : warned
      ? vscode.window.showWarningMessage(message, ...actions)
      : vscode.window.showInformationMessage(message, ...actions);
  void shown.then(async (choice) => {
    if (choice === showInLog && single !== undefined) {
      await showRangeInLog(single.outcome, single.root);
    } else if (choice === dontAsk && remember !== undefined) {
      await rememberAutoUpdate(remember);
    } else if (choice === details) {
      await vscode.commands.executeCommand('gittree.log.showConsole');
    }
  });
}

/** Runs the pushes and reports them — what every push entry point does. */
export async function pushAndReport(
  deps: UpdateDialogDeps,
  targets: readonly PushTarget[],
  options: PushReportOptions = {},
): Promise<PushResult[]> {
  const results = await runPushes(deps, targets);
  reportPushes(deps.core, results, options);
  return results;
}
