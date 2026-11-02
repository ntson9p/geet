/**
 * One branch checked out in every repository (POST-P14ax), carried out. The
 * rules are `checkoutAcrossModel.ts`'s; this runs them, asks the one question
 * they leave open, and says what happened once.
 *
 * Each repository is tried in turn, as git would be by hand. One whose local
 * changes are in the way is not asked about there and then: the rest go on, and
 * at the end one question covers every repository that was stopped that way —
 * Smart Checkout, Force Checkout, or leave them where they are. A repository
 * that fails for any other reason does not stop the others either; the
 * summary says why, worst news first.
 */
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { Core, RepoHandle } from '../core/core';
import { describeGitFailure, GitError } from '../core/git/errors';
import { repoBusyReason } from '../core/model/repoBusy';
import { repoLabels } from '../core/util/repoLabels';
import { SNAPSHOT_LABELS } from '../localHistory/hooks';
import { notifySuccess, notifyWarning, type NotificationAction } from '../ui/notify';
import { beginOperationProgress } from '../ui/progress';
import {
  branchChoices,
  changes,
  checkoutArgs,
  listNames,
  planCheckout,
  summarizeCheckout,
  type CheckoutResult,
  type CheckoutStep,
  type CheckoutTarget,
  type RepoRefState,
} from './checkoutAcrossModel';
import { parseBlockingFiles } from './parsing';
import { RestoreFailedError, setAsideAround, smartCheckoutBehavior } from './smartCheckout';

/** What the model needs of a repository, read from its snapshot. */
export function refStateOf(repo: RepoHandle, label: string): RepoRefState {
  const snap = repo.model.snapshot;
  const refs = snap.refs.filter((r) => r.symrefTarget === undefined);
  const remotes = refs.flatMap((r) =>
    r.type === 'remote' && r.remote !== undefined ? [{ name: r.name, remote: r.remote }] : [],
  );
  const busy = repoBusyReason(snap);
  const trackingRemote =
    snap.upstream !== undefined ? remotes.find((r) => r.name === snap.upstream)?.remote : undefined;
  return {
    root: repo.root,
    label,
    head: snap.detached ? undefined : snap.headRef,
    ...(busy !== undefined ? { busy } : {}),
    locals: refs.filter((r) => r.type === 'head').map((r) => r.name),
    remotes,
    tags: refs.filter((r) => r.type === 'tag').map((r) => r.name),
    ...(trackingRemote !== undefined ? { trackingRemote } : {}),
  };
}

function labelsOf(core: Core): (repo: RepoHandle) => string {
  const labels = repoLabels(core.repos.map((r) => r.root));
  return (repo) => labels.get(repo.root) ?? path.basename(repo.root);
}

/** git's reason, not its exit code. */
export function reasonOf(err: unknown): string {
  if (err instanceof GitError) return err.exitCode < 0 ? err.message : describeGitFailure(err.details);
  const text = err instanceof Error ? err.message : String(err);
  return text.split('\n', 1)[0]?.trim() ?? text;
}

/** Holds the conflict lifecycle's own toast back: the summary names what conflicted. */
interface ConflictLifecycleShape {
  lifecycle?: { holdNotices?(repoRoot: string): vscode.Disposable };
}

/** A repository whose local changes stopped its checkout. */
interface Blocked {
  readonly repo: RepoHandle;
  readonly state: RepoRefState;
  readonly step: CheckoutStep;
  readonly files: readonly string[];
}

export type LocalChangesChoice = 'smart' | 'force' | 'leave';

/** A repository whose local changes are in the way, as the question names it. */
export interface InTheWay {
  readonly label: string;
  readonly files: readonly string[];
}

let lastQuestion: { message: string; detail: string; buttons: string[] } | undefined;

/** Test seam: what the local-changes question last said. */
export function lastLocalChangesQuestion(): typeof lastQuestion {
  return lastQuestion;
}

/**
 * The one question for every repository whose local changes were in the way,
 * settled by `gittree.smartCheckout.behavior` when that says so. A native modal
 * cannot be clicked from a test: `GITTREE_TEST_SMART_CHOICE` answers it. Shared
 * with the New Branch form's Check it out.
 */
export async function askAboutLocalChanges(
  name: string,
  blocked: readonly InTheWay[],
): Promise<LocalChangesChoice> {
  const behavior = smartCheckoutBehavior();
  if (behavior === 'auto') return 'smart';
  if (behavior === 'never') return 'leave';
  const smart = vscode.l10n.t('Smart Checkout');
  const force = vscode.l10n.t('Force Checkout');
  const where = listNames(blocked.map((b) => b.label));
  const message = vscode.l10n.t('Your local changes in {0} would be overwritten by checking out {1}.', where, name);
  const lines = blocked.map((b) =>
    blocked.length > 1
      ? `${b.label}: ${listNames(b.files.length > 0 ? b.files : [vscode.l10n.t('local changes')], 6)}`
      : listNames(b.files.length > 0 ? b.files : [vscode.l10n.t('local changes')], 12),
  );
  const detail = [
    ...lines,
    '',
    vscode.l10n.t(
      'Smart Checkout sets them aside, checks out {0} and puts them back. Force Checkout throws them away; Local History keeps a copy. Cancel leaves {1} where {2}.',
      name,
      blocked.length === 1 ? where : vscode.l10n.t('these repositories'),
      blocked.length === 1 ? vscode.l10n.t('it is') : vscode.l10n.t('they are'),
    ),
  ].join('\n');
  lastQuestion = { message, detail, buttons: [smart, force] };
  const seeded = process.env['GITTREE_TEST_SMART_CHOICE'];
  if (seeded !== undefined) return seeded === 'smart' ? 'smart' : seeded === 'force' ? 'force' : 'leave';
  const picked = await vscode.window.showWarningMessage(message, { modal: true, detail }, smart, force);
  return picked === smart ? 'smart' : picked === force ? 'force' : 'leave';
}

async function runCheckout(repo: RepoHandle, step: CheckoutStep, force: boolean): Promise<void> {
  const args = checkoutArgs(step, force);
  await repo.queue.enqueue({
    label: force ? vscode.l10n.t('Force checkout {0}', stepName(step)) : vscode.l10n.t('Checkout {0}', stepName(step)),
    kind: 'mutate',
    // The run's own progress says which repository it is at: no spinner each.
    quietProgress: true,
    isDestructive: true,
    snapshotLabel: force ? SNAPSHOT_LABELS.forceCheckout : SNAPSHOT_LABELS.checkoutDirty,
    snapshotAfter: true,
    run: async (git, token) => {
      await git.exec(repo.root, args, { token });
    },
  });
}

function stepName(step: CheckoutStep): string {
  return step.kind === 'switch' || step.kind === 'create' || step.kind === 'tag' ? step.name : '';
}

function switched(step: CheckoutStep, state: RepoRefState, extra: Partial<Extract<CheckoutResult, { kind: 'switched' }>> = {}): CheckoutResult {
  return {
    kind: 'switched',
    label: state.label,
    ...(step.kind === 'create' ? { created: step.from } : {}),
    ...extra,
  };
}

/** What every repository came to, in the order given. */
export interface CheckoutAcrossOutcome {
  readonly results: ReadonlyArray<{ readonly root: string; readonly result: CheckoutResult }>;
}

/**
 * Checks `target` out in every one of `repos` that has it, and says once what
 * happened. Resolves with each repository's result, for the tests.
 */
export async function checkoutAcross(
  core: Core,
  repos: readonly RepoHandle[],
  target: CheckoutTarget,
): Promise<CheckoutAcrossOutcome> {
  const label = labelsOf(core);
  const states = repos.map((repo) => refStateOf(repo, label(repo)));
  const steps = planCheckout(states, target);
  const results = new Map<string, CheckoutResult>();
  // What needs no git at all: already there, nowhere to be had, or mid-operation.
  for (const [i, step] of steps.entries()) {
    const state = states[i]!;
    if (step.kind === 'already') results.set(step.root, { kind: 'already', label: state.label });
    else if (step.kind === 'missing') {
      results.set(step.root, { kind: 'missing', label: state.label, ...(state.head !== undefined ? { head: state.head } : {}) });
    } else if (step.kind === 'busy') results.set(step.root, { kind: 'busy', label: state.label, reason: step.reason });
  }

  const todo = changes(steps);
  const byRoot = new Map(repos.map((r) => [r.root, r]));
  const stateOf = new Map(states.map((s) => [s.root, s]));
  const lifecycle = (core.debugRegistry.get('phase06') as ConflictLifecycleShape | undefined)?.lifecycle;
  const holds = repos.flatMap((r) => {
    const hold = lifecycle?.holdNotices?.(r.root);
    return hold !== undefined ? [hold] : [];
  });
  let restoreConflicts = false;
  try {
    const blocked: Blocked[] = [];
    if (todo.length > 0) {
      const progress = beginOperationProgress(vscode.l10n.t('Checkout {0}', target.name));
      try {
        for (const [i, step] of todo.entries()) {
          const repo = byRoot.get(step.root)!;
          const state = stateOf.get(step.root)!;
          // Cancel stops the next one from starting, never one half-way through.
          if (progress.token.isCancellationRequested) {
            results.set(step.root, { kind: 'notAttempted', label: state.label });
            continue;
          }
          progress.report(vscode.l10n.t('{0} ({1} of {2})…', state.label, i + 1, todo.length));
          try {
            await runCheckout(repo, step, false);
            results.set(step.root, switched(step, state));
          } catch (err) {
            if (err instanceof GitError && err.kind === 'would-overwrite-checkout') {
              blocked.push({ repo, state, step, files: parseBlockingFiles(err.stderr) });
            } else {
              results.set(step.root, { kind: 'failed', label: state.label, reason: reasonOf(err) });
            }
          }
        }
      } finally {
        progress.done();
      }
    }

    if (blocked.length > 0) {
      const choice = await askAboutLocalChanges(
        target.name,
        blocked.map((b) => ({ label: b.state.label, files: b.files })),
      );
      if (choice === 'leave') {
        for (const b of blocked) {
          results.set(b.repo.root, {
            kind: 'blocked',
            label: b.state.label,
            ...(b.state.head !== undefined ? { head: b.state.head } : {}),
            files: b.files,
          });
        }
      } else {
        const progress = beginOperationProgress(vscode.l10n.t('Checkout {0}', target.name));
        try {
          for (const b of blocked) {
            if (progress.token.isCancellationRequested) {
              results.set(b.repo.root, { kind: 'notAttempted', label: b.state.label });
              continue;
            }
            progress.report(
              choice === 'smart'
                ? vscode.l10n.t('{0}: setting your local changes aside…', b.state.label)
                : vscode.l10n.t('{0}: discarding your local changes…', b.state.label),
            );
            try {
              if (choice === 'smart') {
                await setAsideAround(b.repo, stepName(b.step), checkoutArgs(b.step), { quietProgress: true });
                results.set(b.repo.root, switched(b.step, b.state, { setAside: 'restored' }));
              } else {
                await runCheckout(b.repo, b.step, true);
                results.set(b.repo.root, switched(b.step, b.state, { forced: true }));
              }
            } catch (err) {
              if (err instanceof RestoreFailedError) {
                restoreConflicts ||= err.conflicts;
                results.set(b.repo.root, switched(b.step, b.state, { setAside: 'kept' }));
              } else {
                results.set(b.repo.root, { kind: 'failed', label: b.state.label, reason: reasonOf(err) });
              }
            }
          }
        } finally {
          progress.done();
        }
      }
    }
    await Promise.all(repos.map((r) => r.refresher.refreshNow()));
  } finally {
    for (const hold of holds) hold.dispose();
  }

  const ordered = repos.flatMap((r) => {
    const result = results.get(r.root);
    return result !== undefined ? [{ root: r.root, result }] : [];
  });
  const summary = summarizeCheckout(target, ordered.map((o) => o.result));
  const actions: NotificationAction[] = restoreConflicts
    ? [{ title: vscode.l10n.t('Show Conflicts'), run: () => vscode.commands.executeCommand('gittree.conflicts.focus') }]
    : [];
  if (ordered.some((o) => o.result.kind === 'failed')) {
    actions.push({ title: vscode.l10n.t('Show Details'), run: () => vscode.commands.executeCommand('gittree.log.showConsole') });
  }
  if (summary.kind === 'warning') notifyWarning(summary.message, ...actions);
  else notifySuccess(summary.message, ...actions);
  return { results: ordered };
}

/**
 * `Checkout Branch in All Repositories…`: every branch any of them has, local or
 * remote, by its own name, then `checkoutAcross`. `GITTREE_TEST_CHECKOUT_BRANCH`
 * answers the picker, which a test cannot click.
 */
export async function pickAndCheckoutAcross(
  core: Core,
  repos: readonly RepoHandle[],
): Promise<CheckoutAcrossOutcome | undefined> {
  if (repos.length === 0) {
    void vscode.window.showInformationMessage(vscode.l10n.t('No repository is open.'));
    return undefined;
  }
  const label = labelsOf(core);
  const choices = branchChoices(repos.map((repo) => refStateOf(repo, label(repo))));
  if (choices.length === 0) {
    void vscode.window.showInformationMessage(vscode.l10n.t('There is no branch to check out.'));
    return undefined;
  }
  const seeded = process.env['GITTREE_TEST_CHECKOUT_BRANCH'];
  let name: string | undefined;
  if (seeded !== undefined) {
    name = seeded;
  } else {
    interface Item extends vscode.QuickPickItem {
      readonly branch: string;
    }
    const items: Item[] = choices.map((c) => ({
      label: `$(${c.changes === 0 ? 'check' : 'git-branch'}) ${c.name}`,
      description: c.description,
      detail: c.detail,
      branch: c.name,
    }));
    const picked = await vscode.window.showQuickPick(items, {
      title: vscode.l10n.t('Checkout Branch in All Repositories'),
      placeHolder:
        repos.length === 1
          ? vscode.l10n.t('Branch to check out')
          : vscode.l10n.t('Branch to check out in {0} repositories', repos.length),
      matchOnDetail: true,
    });
    name = picked?.branch;
  }
  if (name === undefined || name.trim().length === 0) return undefined;
  return checkoutAcross(core, repos, { kind: 'branch', name: name.trim() });
}
