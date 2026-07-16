/**
 * Smart Checkout interceptor (P2-T4): IntelliJ's signature move. A checkout
 * blocked by dirty files offers Smart Checkout (stash → checkout → unstash),
 * Force Checkout (discard, snapshotted), or Cancel. A conflicting pop keeps
 * the stash entry and points at the conflicts.
 */
import * as vscode from 'vscode';
import type { Core, RepoHandle } from '../core/core';
import { GitError } from '../core/git/errors';
import { SNAPSHOT_LABELS } from '../localHistory/hooks';
import { parseBlockingFiles } from './parsing';

export type SmartCheckoutBehavior = 'ask' | 'auto' | 'never';

export function smartCheckoutBehavior(): SmartCheckoutBehavior {
  const v = vscode.workspace
    .getConfiguration('gittree')
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

export async function checkoutWithSmart(core: Core, repo: RepoHandle, target: string): Promise<void> {
  try {
    await plainCheckout(repo, target);
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
          'Checkout of "{0}" blocked by local changes in {1} file(s). Commit, stash or roll back first.',
          target,
          blocking.length,
        ),
      );
      return;
    } else {
      const smart = vscode.l10n.t('Smart Checkout');
      const force = vscode.l10n.t('Force Checkout');
      const picked =
        process.env['GITTREE_TEST_SMART_CHOICE'] === 'smart'
          ? smart
          : process.env['GITTREE_TEST_SMART_CHOICE'] === 'force'
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
      return;
    }

    await smartCheckout(core, repo, target);
  }
}

async function smartCheckout(core: Core, repo: RepoHandle, target: string): Promise<void> {
  const marker = `gittree-smart:${target}:${Date.now()}`;

  // 1. Stash everything (incl. untracked) — destructive-flagged for P9.
  await repo.queue.enqueue({
    label: vscode.l10n.t('Smart checkout: stash changes'),
    kind: 'mutate',
    isDestructive: true,
    snapshotLabel: SNAPSHOT_LABELS.smartCheckoutStash,
    run: async (git, token) => {
      await git.exec(repo.root, ['stash', 'push', '-u', '-m', marker], { token });
    },
  });

  // 2. Checkout (now clean).
  try {
    await repo.queue.enqueue({
      label: vscode.l10n.t('Checkout {0}', target),
      kind: 'mutate',
      run: async (git, token) => {
        await git.exec(repo.root, ['checkout', target], { token });
      },
    });
  } catch (err) {
    // Restore on the original branch so the user isn't stranded.
    await repo.queue
      .enqueue({
        label: vscode.l10n.t('Smart checkout: restore stash after failure'),
        kind: 'mutate',
        run: async (git, token) => {
          await git.exec(repo.root, ['stash', 'pop'], { token, allowNonZeroExit: true });
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
      run: async (git, token) => {
        await git.exec(repo.root, ['stash', 'pop'], { token });
      },
    });
    core.output.appendLine(`[branches] smart checkout to ${target} completed with changes restored`);
  } catch (err) {
    if (err instanceof GitError && err.kind === 'merge-conflict') {
      void vscode.window.showWarningMessage(
        vscode.l10n.t(
          'Conflicts while restoring your changes on "{0}". Resolve them, then drop the kept stash entry.',
          target,
        ),
      );
      return;
    }
    throw err;
  }
}
