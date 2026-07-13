/**
 * Sync operations (P1-T5): fetch / pull / push / force-with-lease / sync +
 * auto-fetch. Pull honors the user's pull.rebase config (git does natively);
 * pushing without an upstream offers "Publish Branch"; the branches-popup
 * command is a checkout QuickPick stub that P2 swaps for the real popup.
 */
import * as vscode from 'vscode';
import type { Core, RepoHandle } from '../core/core';
import { canonicalKey } from '../core/repoDiscovery';
import { GitError } from '../core/git/errors';
import { SNAPSHOT_LABELS } from '../localHistory/hooks';
import { confirmModal } from '../ui/confirm';
import type { StatusBarController } from '../ui/statusBar';

type BranchesOpenHandler = (repoRoot?: string) => Promise<void>;
let branchesOpenHandler: BranchesOpenHandler | undefined;

/** P2 installs the real Branches popup over the same command id. */
export function setBranchesOpenHandler(handler: BranchesOpenHandler): void {
  branchesOpenHandler = handler;
}

function pickRepo(core: Core, repoRoot: unknown): RepoHandle | undefined {
  if (typeof repoRoot === 'string') return core.getRepo(repoRoot);
  const active = vscode.window.activeTextEditor?.document.uri;
  return (active && core.repoForUri(active)) ?? core.repos[0];
}

async function mutate(repo: RepoHandle, label: string, args: string[]): Promise<void> {
  await repo.queue.enqueue({
    label,
    kind: 'mutate',
    run: async (git, token) => {
      await git.exec(repo.root, args, { token });
    },
  });
}

export function registerSyncOps(
  context: vscode.ExtensionContext,
  core: Core,
  statusBars: Map<string, StatusBarController>,
): void {
  const register = (id: string, fn: (...args: unknown[]) => Promise<void> | void): void => {
    context.subscriptions.push(vscode.commands.registerCommand(id, fn));
  };
  const bar = (repo: RepoHandle): StatusBarController | undefined =>
    statusBars.get(canonicalKey(repo.root));

  async function fetch(repo: RepoHandle, quiet: boolean): Promise<void> {
    bar(repo)?.setFetching(true);
    try {
      await mutate(repo, vscode.l10n.t('Fetch'), ['fetch', '--prune']);
      repo.model.update({ lastFetchAt: Date.now() });
    } catch (err) {
      if (!quiet) throw err;
      core.output.appendLine(`auto-fetch failed: ${String(err)}`);
    } finally {
      bar(repo)?.setFetching(false);
    }
  }

  async function push(repo: RepoHandle, extraArgs: string[] = []): Promise<void> {
    try {
      await mutate(repo, vscode.l10n.t('Push'), ['push', ...extraArgs]);
    } catch (err) {
      // P5-T6: a stale lease means the remote moved since our last fetch —
      // never force through it; suggest fetching and re-inspecting instead.
      if (
        err instanceof GitError &&
        err.kind === 'not-fast-forward' &&
        extraArgs.some((a) => a.startsWith('--force-with-lease'))
      ) {
        const fetchAction = vscode.l10n.t('Fetch');
        void vscode.window
          .showErrorMessage(
            vscode.l10n.t(
              'Force-with-lease was refused: the remote moved since your last fetch. Fetch, inspect the new commits, then decide again.',
            ),
            fetchAction,
          )
          .then((choice) => {
            if (choice === fetchAction) {
              return vscode.commands.executeCommand('gittree.fetch', repo.root);
            }
            return undefined;
          });
        return;
      }
      if (err instanceof GitError && err.kind === 'no-upstream') {
        const branch = repo.model.snapshot.headRef;
        const publish = vscode.l10n.t('Publish Branch');
        const choice = await vscode.window.showInformationMessage(
          vscode.l10n.t('Branch "{0}" has no upstream. Publish it?', branch ?? ''),
          publish,
        );
        if (choice === publish && branch) {
          await mutate(repo, vscode.l10n.t('Publish {0}', branch), ['push', '-u', 'origin', branch]);
        }
        return;
      }
      throw err;
    }
  }

  register('gittree.fetch', async (repoRoot) => {
    const repo = pickRepo(core, repoRoot);
    if (repo) await fetch(repo, false);
  });

  register('gittree.pull', async (repoRoot) => {
    const repo = pickRepo(core, repoRoot);
    if (repo) await mutate(repo, vscode.l10n.t('Pull'), ['pull']);
  });

  register('gittree.push', async (repoRoot) => {
    const repo = pickRepo(core, repoRoot);
    if (repo) await push(repo);
  });

  register('gittree.pushForceWithLease', async (repoRoot) => {
    const repo = pickRepo(core, repoRoot);
    if (!repo) return;
    const ok = await confirmModal(
      vscode.l10n.t('Force-push (with lease) "{0}"?', repo.model.snapshot.headRef ?? ''),
      '',
      vscode.l10n.t('Force Push'),
    );
    if (!ok) return;
    const extra = ['--force-with-lease'];
    if (core.git.caps.forceIfIncludes) extra.push('--force-if-includes');
    await push(repo, extra);
  });

  register('gittree.sync', async (repoRoot) => {
    const repo = pickRepo(core, repoRoot);
    if (!repo) return;
    await mutate(repo, vscode.l10n.t('Pull'), ['pull']);
    if ((repo.model.snapshot.ahead ?? 0) > 0 || repo.model.snapshot.upstream === undefined) {
      await push(repo);
    }
  });

  // Branches popup — stub QuickPick until P2 replaces the handler.
  register('gittree.branches.open', async (repoRoot) => {
    const repo = pickRepo(core, repoRoot);
    if (!repo) return;
    if (branchesOpenHandler) {
      await branchesOpenHandler(typeof repoRoot === 'string' ? repoRoot : repo.root);
      return;
    }
    const branches = repo.model.snapshot.refs.filter((r) => r.type === 'head');
    const items = branches.map((b) => ({
      label: `${b.isHead ? '$(check) ' : '$(git-branch) '}${b.name}`,
      description: b.upstream ?? '',
      branch: b.name,
    }));
    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: vscode.l10n.t('Checkout branch (full popup arrives with Phase 2)'),
    });
    if (!picked || branches.find((b) => b.name === picked.branch)?.isHead) return;
    await repo.queue.enqueue({
      label: vscode.l10n.t('Checkout {0}', picked.branch),
      kind: 'mutate',
      isDestructive: true,
      snapshotLabel: SNAPSHOT_LABELS.checkoutDirty,
      run: async (git, token) => {
        await git.exec(repo.root, ['checkout', picked.branch], { token });
      },
    });
  });

  // ---- Auto-fetch (paused during mutations and long-unfocused windows) ----
  let lastFocusedAt = Date.now();
  context.subscriptions.push(
    vscode.window.onDidChangeWindowState((s) => {
      if (s.focused) lastFocusedAt = Date.now();
    }),
  );
  const timer = setInterval(() => {
    const cfg = vscode.workspace.getConfiguration('gittree.autofetch');
    if (!cfg.get<boolean>('enabled', false)) return;
    const unfocusedMs = vscode.window.state.focused ? 0 : Date.now() - lastFocusedAt;
    if (unfocusedMs > 30 * 60 * 1000) return;
    for (const repo of core.repos) {
      if (repo.queue.isMutationActive) continue;
      if (repo.model.snapshot.upstream === undefined) continue;
      const interval = cfg.get<number>('intervalSeconds', 180) * 1000;
      const last = repo.model.snapshot.lastFetchAt ?? 0;
      if (Date.now() - last >= interval) {
        void fetch(repo, true);
      }
    }
  }, 15_000);
  context.subscriptions.push(new vscode.Disposable(() => clearInterval(timer)));
}
