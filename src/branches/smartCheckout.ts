/**
 * Smart Checkout interceptor (P2-T4): IntelliJ's signature move. A checkout
 * blocked by dirty files offers Smart Checkout (stash → checkout → unstash),
 * Force Checkout (discard, snapshotted), or Cancel. A conflicting pop keeps
 * the stash entry and points at the conflicts.
 */
import * as vscode from 'vscode';
import { filesCount } from '../ui/counts';
import { notifySuccess } from '../ui/notify';
import type { Core, RepoHandle } from '../core/core';
import { GitError } from '../core/git/errors';
import type { CancelToken, GitExecutor } from '../core/git/executor';
import { readStaged, restoreStaged, type StagedSnapshot } from '../core/ops/keepStaged';
import { SNAPSHOT_LABELS } from '../localHistory/hooks';
import { parseBlockingFiles } from './parsing';

export type SmartCheckoutBehavior = 'ask' | 'auto' | 'never';

export function smartCheckoutBehavior(): SmartCheckoutBehavior {
  const v = vscode.workspace
    .getConfiguration('geet')
    .get<string>('smartCheckout.behavior', 'ask');
  return v === 'auto' || v === 'never' ? v : 'ask';
}

// NOTE: branch checkouts must NOT use `--` (that flips the argument into a
// pathspec and restores files instead of switching branches). Branch names
// cannot start with `-` (check-ref-format), so the bare form is safe.
async function plainCheckout(repo: RepoHandle, target: string): Promise<void> {
  await repo.queue.enqueue({
    label: vscode.l10n.t('Checkout {0}', target),
    kind: 'mutate',
    isDestructive: true,
    snapshotLabel: SNAPSHOT_LABELS.checkoutDirty,
    snapshotAfter: true,
    run: async (git, token) => {
      await git.exec(repo.root, ['checkout', target], { token });
    },
  });
}

/** IntelliJ's `checkout.operation.checked.out`, whichever way the checkout went. */
function checkedOut(target: string): void {
  notifySuccess(vscode.l10n.t('Checked out {0}', target));
}

export async function checkoutWithSmart(core: Core, repo: RepoHandle, target: string): Promise<void> {
  try {
    await plainCheckout(repo, target);
    checkedOut(target);
    return;
  } catch (err) {
    if (!(err instanceof GitError) || err.kind !== 'would-overwrite-checkout') throw err;

    const blocking = parseBlockingFiles(err.stderr);
    const behavior = smartCheckoutBehavior();

    let choice: 'smart' | 'force' | 'cancel';
    if (behavior === 'auto') {
      choice = 'smart';
    } else if (behavior === 'never') {
      void vscode.window.showWarningMessage(
        vscode.l10n.t(
          'Checkout of "{0}" blocked by local changes in {1}. Commit, stash or roll back first.',
          target,
          filesCount(blocking.length),
        ),
      );
      return;
    } else {
      const smart = vscode.l10n.t('Smart Checkout');
      const force = vscode.l10n.t('Force Checkout');
      const picked =
        process.env['GEET_TEST_SMART_CHOICE'] === 'smart'
          ? smart
          : process.env['GEET_TEST_SMART_CHOICE'] === 'force'
            ? force
            : await vscode.window.showWarningMessage(
                vscode.l10n.t('Your local changes would be overwritten by checkout. ({0} files)', blocking.length),
                {
                  modal: true,
                  detail: vscode.l10n.t(
                    '{0}\n\nSmart Checkout stashes your changes, switches to "{1}", and restores them there.',
                    blocking.slice(0, 12).join('\n') + (blocking.length > 12 ? '\n…' : ''),
                    target,
                  ),
                },
                smart,
                force,
              );
      choice = picked === smart ? 'smart' : picked === force ? 'force' : 'cancel';
    }

    if (choice === 'cancel') return;
    if (choice === 'force') {
      await repo.queue.enqueue({
        label: vscode.l10n.t('Force checkout {0}', target),
        kind: 'mutate',
        isDestructive: true,
        snapshotLabel: SNAPSHOT_LABELS.forceCheckout,
        snapshotAfter: true,
        run: async (git, token) => {
          await git.exec(repo.root, ['checkout', '-f', target], { token });
        },
      });
      checkedOut(target);
      return;
    }

    await smartCheckout(core, repo, target);
  }
}

/**
 * The checkout went through, but putting the user's changes back did not: git
 * keeps the stash entry whenever `stash pop` fails, so nothing is lost.
 */
export class RestoreFailedError extends Error {
  override readonly name = 'RestoreFailedError';

  constructor(override readonly cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
  }

  /** Putting them back conflicted with what was checked out, rather than failing outright. */
  get conflicts(): boolean {
    return this.cause instanceof GitError && this.cause.kind === 'merge-conflict';
  }
}

/**
 * Smart Checkout's steps, saying nothing (POST-P14ax): stash everything,
 * untracked files included, run `args`, put it all back. Shared by one
 * repository's Smart Checkout and a checkout across repositories, which reports
 * once for all of them.
 *
 * Throws what the checkout threw, with the changes put back where they were;
 * or `RestoreFailedError` when the checkout went through and putting the changes
 * back did not, the stash entry kept.
 */
export async function setAsideAround(
  repo: RepoHandle,
  target: string,
  args: readonly string[],
  options: { readonly quietProgress?: boolean } = {},
): Promise<void> {
  const marker = `geet-smart:${target}:${Date.now()}`;
  // Quiet when a caller's own progress says what is going on.
  const quiet = options.quietProgress === true ? { quietProgress: true as const } : {};

  // 1. Stash everything (incl. untracked) — destructive-flagged for P9 —
  //    remembering what was staged, for when `pop --index` cannot be used.
  let staged: StagedSnapshot | undefined;
  await repo.queue.enqueue({
    label: vscode.l10n.t('Smart checkout: stash changes'),
    kind: 'mutate',
    ...quiet,
    isDestructive: true,
    snapshotLabel: SNAPSHOT_LABELS.smartCheckoutStash,
    run: async (git, token) => {
      staged = await readStaged(git, repo.root, token);
      await git.exec(repo.root, ['stash', 'push', '-u', '-m', marker], { token });
    },
  });

  // 2. Checkout (now clean).
  try {
    await repo.queue.enqueue({
      label: vscode.l10n.t('Checkout {0}', target),
      kind: 'mutate',
      ...quiet,
      run: async (git, token) => {
        await git.exec(repo.root, [...args], { token });
      },
    });
  } catch (err) {
    // Restore on the original branch so the user isn't stranded.
    await repo.queue
      .enqueue({
        label: vscode.l10n.t('Smart checkout: restore stash after failure'),
        kind: 'mutate',
        ...quiet,
        run: async (git, token) => {
          await popKeepingIndex(git, repo.root, staged, token).catch(() => undefined);
        },
      })
      .catch(() => undefined);
    throw err;
  }

  // 3. Pop on the target. Clean pop drops the stash automatically; a
  //    conflicting pop KEEPS it (git behavior) — exactly what we want.
  try {
    await repo.queue.enqueue({
      label: vscode.l10n.t('Smart checkout: restore changes'),
      kind: 'mutate',
      ...quiet,
      run: async (git, token) => {
        await popKeepingIndex(git, repo.root, staged, token);
      },
    });
  } catch (err) {
    throw new RestoreFailedError(err);
  }
}

/**
 * `git stash pop --index`: the staged changes come back staged, as IntelliJ's
 * Smart Checkout puts them back with the staging area on (POST-QA F3). When
 * the staged half no longer applies on the new branch ("conflicts in index"),
 * git changes nothing; the plain pop then brings everything back unstaged, and
 * `restoreStaged` stages again every path the checkout did not change — only
 * the files that differ between the two branches stay unstaged.
 */
async function popKeepingIndex(
  git: GitExecutor,
  root: string,
  staged: StagedSnapshot | undefined,
  token: CancelToken,
): Promise<void> {
  try {
    await git.exec(root, ['stash', 'pop', '--index'], { token });
    return;
  } catch (err) {
    const output = err instanceof GitError ? `${err.stderr}\n${err.details.stdout}` : '';
    if (!(err instanceof GitError) || !/conflicts in index/iu.test(output)) throw err;
  }
  await git.exec(root, ['stash', 'pop'], { token });
  if (staged) await restoreStaged(git, root, staged, token);
}

async function smartCheckout(core: Core, repo: RepoHandle, target: string): Promise<void> {
  try {
    await setAsideAround(repo, target, ['checkout', target]);
    core.output.appendLine(`[branches] smart checkout to ${target} completed with changes restored`);
    checkedOut(target);
  } catch (err) {
    if (!(err instanceof RestoreFailedError)) throw err;
    if (err.conflicts) {
      void vscode.window.showWarningMessage(
        vscode.l10n.t(
          'Conflicts while restoring your changes on "{0}". Resolve them, then drop the kept stash entry.',
          target,
        ),
      );
      return;
    }
    throw err.cause;
  }
}
