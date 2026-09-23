/**
 * Sync operations (P1-T5): fetch / pull / push / force-with-lease / sync +
 * auto-fetch. Pull honors the user's pull.rebase config (git does natively);
 * pushing without an upstream offers "Publish Branch"; the branches-popup
 * command is a checkout QuickPick stub that P2 swaps for the real popup.
 *
 * POST-P14o: `gittree.fetch` is **project-scoped when it is given no argument**
 * — IntelliJ's Fetch fetches every root, and inferring one root from the active
 * editor (as this did) is a coin flip the user cannot see the result of. An
 * explicit `repoRoot` still means that one repository, so every in-product
 * caller that knows which repository it means keeps its narrow behaviour.
 */
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { Core, RepoHandle } from '../core/core';
import type { CancelToken } from '../core/git/executor';
import { canonicalKey } from '../core/repoDiscovery';
import { GitError } from '../core/git/errors';
import { anyToken } from '../core/util/cancellation';
import { presentGitError } from '../hardening/errorUx';
import { SNAPSHOT_LABELS } from '../localHistory/hooks';
import { confirmModal } from '../ui/confirm';
import type { StatusBarController } from '../ui/statusBar';
import { runFetchAll, summarizeFetch, type FetchOutcome, type FetchTarget } from './fetchAll';

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
  // P10-T4: classified failures that no richer flow claimed get the
  // actionable dialog (copy per kind + Help deep-link + Report Issue).
  const register = (id: string, fn: (...args: unknown[]) => Promise<void> | void): void => {
    context.subscriptions.push(
      vscode.commands.registerCommand(id, async (...args: unknown[]) => {
        try {
          await fn(...args);
        } catch (err) {
          if (err instanceof GitError) {
            await presentGitError(context, core, err);
            return;
          }
          throw err;
        }
      }),
    );
  };
  const bar = (repo: RepoHandle): StatusBarController | undefined =>
    statusBars.get(canonicalKey(repo.root));

  /**
   * One repository's fetch. `quietProgress` hands the reporting to the caller:
   * auto-fetch wants no UI at all (IntelliJ's background fetch is silent), and
   * the fan-out wants one notification rather than N escalating separately.
   * `token` is the fan-out's Cancel, joined with the queue's own.
   */
  async function fetchOne(
    repo: RepoHandle,
    options: { quietProgress?: boolean; token?: CancelToken } = {},
  ): Promise<void> {
    bar(repo)?.setFetching(true);
    try {
      await repo.queue.enqueue({
        label: vscode.l10n.t('Fetch'),
        kind: 'mutate',
        ...(options.quietProgress === true ? { quietProgress: true } : {}),
        run: async (git, queueToken) => {
          const outer = options.token;
          const linked = outer ? anyToken(queueToken, outer) : undefined;
          try {
            await git.exec(repo.root, ['fetch', '--prune'], {
              token: linked?.token ?? queueToken,
            });
          } finally {
            linked?.dispose();
          }
        },
      });
      repo.model.update({ lastFetchAt: Date.now() });
    } finally {
      bar(repo)?.setFetching(false);
    }
  }

  /** The auto-fetch wrapper: silent, and a failure is a log line, not a dialog. */
  async function autoFetch(repo: RepoHandle): Promise<void> {
    try {
      await fetchOne(repo, { quietProgress: true });
    } catch (err) {
      core.output.appendLine(`[sync] auto-fetch failed: ${String(err)}`);
    }
  }

  /**
   * Repositories worth fetching: those with at least one remote. A root with no
   * remote can only fail ("No remote repository specified"), and in a workspace
   * that mixes cloned and local-only repositories that failure is noise, not
   * news. `git remote` is a cheap read and the only reliable answer — remote
   * *refs* are absent until the first fetch, which is exactly when you want one.
   */
  async function fetchTargets(): Promise<Array<FetchTarget & { repo: RepoHandle }>> {
    const checked = await Promise.all(
      core.repos.map(async (repo) => {
        try {
          const res = await core.git.exec(repo.root, ['remote']);
          const hasRemote = res.stdout.split('\n').some((l) => l.trim().length > 0);
          return hasRemote ? { repo, root: repo.root, name: path.basename(repo.root) } : undefined;
        } catch {
          // Unreadable config is the repository's problem, not the fan-out's;
          // include it and let the fetch report the real error.
          return { repo, root: repo.root, name: path.basename(repo.root) };
        }
      }),
    );
    return checked.filter((t): t is FetchTarget & { repo: RepoHandle } => t !== undefined);
  }

  /** The summary line the fan-out is allowed to raise — one, never one per repo. */
  function reportFetchAll(outcomes: readonly FetchOutcome[]): void {
    const { ok, cancelled, failures, total } = summarizeFetch(outcomes);
    if (failures.length === 0) {
      if (cancelled > 0) {
        void vscode.window.showInformationMessage(
          vscode.l10n.t('Fetched {0} of {1} repositories — cancelled.', ok, total),
        );
      }
      return; // A clean fetch of everything speaks through the refreshed counts.
    }
    const named = failures
      .slice(0, 3)
      .map((f) => `${f.name}: ${f.message ?? ''}`.trim())
      .join(' · ');
    const more = failures.length > 3 ? vscode.l10n.t(' (+{0} more)', failures.length - 3) : '';
    void vscode.window.showWarningMessage(
      vscode.l10n.t('Fetched {0} of {1} repositories. {2}{3}', ok, total, named, more),
    );
  }

  /**
   * IntelliJ's Fetch: every root, one progress item, one report. A single-root
   * workspace takes the plain path so nothing changes for the common case —
   * same progress, same actionable error dialog.
   */
  async function fetchAll(): Promise<void> {
    const targets = await fetchTargets();
    if (targets.length === 0) {
      void vscode.window.showInformationMessage(
        core.repos.length === 0
          ? vscode.l10n.t('No repository is open.')
          : vscode.l10n.t('No repository has a remote configured.'),
      );
      return;
    }
    if (targets.length === 1) {
      await fetchOne(targets[0]!.repo);
      return;
    }
    const outcomes = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: vscode.l10n.t('Fetching {0} repositories…', targets.length),
        cancellable: true,
      },
      async (progress, token) =>
        runFetchAll(
          targets,
          // vscode's CancellationToken is structurally a CancelToken already.
          (target) => fetchOne(target.repo, { quietProgress: true, token }),
          {
            isCancelled: () => token.isCancellationRequested,
            onSettled: (outcome, done, total) => {
              progress.report({
                increment: 100 / total,
                message: vscode.l10n.t('{0} of {1} · {2}', done, total, outcome.name),
              });
            },
          },
        ),
    );
    reportFetchAll(outcomes);
  }

  async function push(repo: RepoHandle, extraArgs: string[] = []): Promise<void> {
    // POST-P14af: a plain push of a tracked branch goes through the shared
    // runner — IntelliJ's report, and its Merge / Rebase question when the
    // remote has moved on. A force push and a first publish keep this path.
    const snap = repo.model.snapshot;
    if (
      extraArgs.length === 0 &&
      !snap.detached &&
      snap.headRef !== undefined &&
      snap.upstream !== undefined
    ) {
      const results = await vscode.commands.executeCommand<unknown[] | undefined>(
        'gittree.push.run',
        repo.root,
      );
      if (results !== undefined) return;
    }
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

  // Argument presence decides the scope: a caller that knows which repository
  // it means says so, and everyone else gets IntelliJ's project-wide Fetch.
  register('gittree.fetch', async (repoRoot) => {
    if (typeof repoRoot === 'string') {
      const repo = core.getRepo(repoRoot);
      if (repo) await fetchOne(repo);
      return;
    }
    await fetchAll();
  });

  register('gittree.fetch.all', async () => {
    await fetchAll();
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
        void autoFetch(repo);
      }
    }
  }, 15_000);
  context.subscriptions.push(new vscode.Disposable(() => clearInterval(timer)));
}
