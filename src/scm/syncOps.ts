/**
 * Sync operations (P1-T5): fetch / pull / push / force-with-lease / sync +
 * auto-fetch. Pull honors the user's pull.rebase config (git does natively);
 * pushing without an upstream offers "Publish Branch"; the branches-popup
 * command is a checkout QuickPick stub that P2 swaps for the real popup.
 *
 * POST-P14o: `geet.fetch` is **project-scoped when it is given no argument**
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
import { notifySuccess } from '../ui/notify';
import type { StatusBarController } from '../ui/statusBar';
import { protectedBranches } from './dialogs/pushDialog';
import { isBranchProtected, remoteBranchName } from './dialogs/pushModel';
import { countPulled } from './dialogs/updateDialog';
import {
  fetchSuccessMessage,
  parsePrunedRefs,
  runFetchAll,
  summarizeFetch,
  type FetchOutcome,
  type FetchTarget,
  type PrunedRefs,
} from './fetchAll';
import { pullResultMessage } from './resultMessages';
import { chooseRepo } from '../ui/chooseRepo';
import { pullStrategyArgs } from './pullArgs';
import { showInfo } from '../ui/notices';
import { repoRootOf } from '../ui/rowContext';

type BranchesOpenHandler = (repoRoot?: string) => Promise<void>;
let branchesOpenHandler: BranchesOpenHandler | undefined;

/** P2 installs the real Branches popup over the same command id. */
export function setBranchesOpenHandler(handler: BranchesOpenHandler): void {
  branchesOpenHandler = handler;
}

/**
 * The repository a sync command acts on: the one it names, the active
 * editor's, the only one — else the user picks (POST-QA F6). It used to fall
 * back to the first repository, so in a multi-root workspace Geet: Push
 * could push one the user was not looking at.
 */
function pickRepo(core: Core, repoRoot: unknown): Promise<RepoHandle | undefined> {
  return chooseRepo(core, repoRoot);
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
  ): Promise<string[]> {
    bar(repo)?.setFetching(true);
    try {
      const output = await repo.queue.enqueue({
        label: vscode.l10n.t('Fetch'),
        kind: 'mutate',
        ...(options.quietProgress === true ? { quietProgress: true } : {}),
        run: async (git, queueToken) => {
          const outer = options.token;
          const linked = outer ? anyToken(queueToken, outer) : undefined;
          try {
            const res = await git.exec(repo.root, ['fetch', '--prune'], {
              token: linked?.token ?? queueToken,
            });
            return `${res.stderr}\n${res.stdout}`;
          } finally {
            linked?.dispose();
          }
        },
      });
      repo.model.update({ lastFetchAt: Date.now() });
      // The references the prune removed — IntelliJ names them in its result.
      return parsePrunedRefs(output);
    } finally {
      bar(repo)?.setFetching(false);
    }
  }

  /** One repository fetched on request: IntelliJ's *Fetch successful*. */
  async function fetchAndReport(repo: RepoHandle): Promise<void> {
    const pruned = await fetchOne(repo);
    notifySuccess(fetchSuccessMessage([{ name: path.basename(repo.root), refs: pruned }], false));
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
      core.repos.map(async (repo) =>
        (await hasRemote(repo)) ? { repo, root: repo.root, name: path.basename(repo.root) } : undefined,
      ),
    );
    return checked.filter((t): t is FetchTarget & { repo: RepoHandle } => t !== undefined);
  }

  /**
   * Whether `repo` has a remote to fetch from. Unreadable config counts as yes:
   * that is the repository's problem, and the fetch reports the real error.
   */
  async function hasRemote(repo: RepoHandle): Promise<boolean> {
    try {
      const res = await core.git.exec(repo.root, ['remote']);
      return res.stdout.split('\n').some((l) => l.trim().length > 0);
    } catch {
      return true;
    }
  }

  /** The summary line the fan-out is allowed to raise — one, never one per repo. */
  function reportFetchAll(outcomes: readonly FetchOutcome[], pruned: readonly PrunedRefs[]): void {
    const { ok, cancelled, failures, total } = summarizeFetch(outcomes);
    if (failures.length === 0) {
      if (cancelled > 0) {
        showInfo(
          vscode.l10n.t('Fetched {0} of {1} repositories — cancelled.', ok, total),
        );
        return;
      }
      // IntelliJ says so once every repository is fetched: the refreshed
      // counts alone do not tell anyone that the fetch has finished.
      notifySuccess(fetchSuccessMessage(pruned, true));
      return;
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
      showInfo(
        core.repos.length === 0
          ? vscode.l10n.t('No repository is open.')
          : vscode.l10n.t('No repository has a remote configured.'),
      );
      return;
    }
    if (targets.length === 1) {
      await fetchAndReport(targets[0]!.repo);
      return;
    }
    const pruned: PrunedRefs[] = [];
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
          async (target) => {
            const refs = await fetchOne(target.repo, { quietProgress: true, token });
            if (refs.length > 0) pruned.push({ name: target.name, refs });
          },
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
    reportFetchAll(outcomes, pruned);
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
        'geet.push.run',
        repo.root,
      );
      if (results !== undefined) return;
    }
    try {
      await mutate(repo, vscode.l10n.t('Push'), ['push', ...extraArgs]);
      const branch = repo.model.snapshot.headRef ?? 'HEAD';
      const upstream = repo.model.snapshot.upstream;
      notifySuccess(
        extraArgs.some((a) => a.startsWith('--force'))
          ? vscode.l10n.t('Force pushed {0} to {1}', branch, upstream ?? vscode.l10n.t('its upstream'))
          : vscode.l10n.t('Push successful'),
      );
    } catch (err) {
      // P5-T6: a stale lease means the remote moved since our last fetch —
      // never force through it; suggest fetching and re-inspecting instead.
      if (
        err instanceof GitError &&
        err.kind === 'not-fast-forward' &&
        extraArgs.some((a) => a.startsWith('--force-with-lease'))
      ) {
        // POST-QA F2: `--force-if-includes` refuses for a different reason —
        // the remote's commits were fetched but never brought into the
        // branch, and the push would delete them. Saying "fetch" sent the
        // user round in a circle.
        const upstream = await upstreamOf(repo);
        if (upstream !== undefined && !(await isAncestorOf(repo, upstream, 'HEAD'))) {
          void vscode.window.showErrorMessage(
            vscode.l10n.t(
              'Force push refused: {0} has commits that are not in "{1}", and the push would delete them. Bring them in first (Update Project, or merge or rebase onto {0}), then push.',
              upstream,
              repo.model.snapshot.headRef ?? 'HEAD',
            ),
          );
          return;
        }
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
              return vscode.commands.executeCommand('geet.fetch', repo.root);
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
          notifySuccess(vscode.l10n.t('Pushed {0} to new branch {1}', branch, `origin/${branch}`));
        }
        return;
      }
      throw err;
    }
  }

  // Argument presence decides the scope: a caller that knows which repository
  // it means says so, and everyone else gets IntelliJ's project-wide Fetch.
  register('geet.fetch', async (arg) => {
    // A root, or a Commit-window repository row (POST-P14cb): without this, its
    // row would have fetched every repository.
    const repoRoot = typeof arg === 'string' ? arg : repoRootOf(arg);
    if (repoRoot !== undefined) {
      const repo = core.getRepo(repoRoot);
      if (!repo) return;
      // Said plainly, rather than as git's "No remote repository specified":
      // a repository's own Fetch is offered whether or not it has a remote.
      if (!(await hasRemote(repo))) {
        showInfo(
          vscode.l10n.t('{0} has no remote to fetch from.', path.basename(repo.root)),
        );
        return;
      }
      await fetchAndReport(repo);
      return;
    }
    await fetchAll();
  });

  register('geet.fetch.all', async () => {
    await fetchAll();
  });

  /**
   * `git pull`, then what it brought in — or that there was nothing to bring.
   * False when the pull did not happen, so Sync does not push after it.
   */
  async function pullAndReport(repo: RepoHandle): Promise<boolean> {
    const before = await headOf(repo);
    try {
      const strategy = await pullStrategyArgs(core.git, repo.root, repo.model.snapshot.headRef);
      await mutate(repo, vscode.l10n.t('Pull'), ['pull', ...strategy]);
    } catch (err) {
      if (err instanceof GitError && /divergent branches|Not possible to fast-forward/iu.test(err.stderr)) {
        // POST-QA F6: pull.ff=only (or a git that will not guess) on a
        // diverged branch. Said plainly, with the way forward, instead of
        // "A git operation failed".
        const update = vscode.l10n.t('Update Project…');
        const choice = await vscode.window.showWarningMessage(
          vscode.l10n.t(
            '"{0}" and {1} have diverged, and your git settings allow a pull only to fast-forward. Update Project can merge or rebase them.',
            repo.model.snapshot.headRef ?? 'HEAD',
            repo.model.snapshot.upstream ?? vscode.l10n.t('its upstream'),
          ),
          update,
        );
        if (choice === update) await vscode.commands.executeCommand('geet.update.dialog', repo.root);
        return false;
      }
      throw err;
    }
    const counted = await countPulled(core, repo, before, '@{upstream}');
    notifySuccess(pullResultMessage(counted.commits, counted.files, repo.model.snapshot.upstream));
    return true;
  }

  async function headOf(repo: RepoHandle): Promise<string> {
    const res = await core.git.exec(repo.root, ['rev-parse', '--verify', '--quiet', 'HEAD'], {
      structured: true,
      allowNonZeroExit: true,
    });
    return res.exitCode === 0 ? res.stdout.trim() : '';
  }

  register('geet.pull', async (repoRoot) => {
    const repo = await pickRepo(core, repoRoot);
    if (repo) await pullAndReport(repo);
  });

  register('geet.push', async (repoRoot) => {
    const repo = await pickRepo(core, repoRoot);
    if (repo) await push(repo);
  });

  register('geet.pushForceWithLease', async (repoRoot) => {
    const repo = await pickRepo(core, repoRoot);
    if (!repo) return;
    const branch = repo.model.snapshot.headRef ?? 'HEAD';
    const upstream = await upstreamOf(repo);
    // POST-QA F2: what the Push dialog refuses, this refuses too.
    if (upstream !== undefined && isBranchProtected(remoteBranchName(upstream), protectedBranches())) {
      void vscode.window.showWarningMessage(
        vscode.l10n.t('{0} is a protected branch: Geet does not force-push it.', upstream),
      );
      return;
    }
    // The offer may be old: the branch may have been pushed, pulled or put
    // back since. Only a branch the upstream is not part of needs force.
    if (upstream !== undefined && (await isAncestorOf(repo, upstream, 'HEAD'))) {
      showInfo(
        vscode.l10n.t('"{0}" no longer needs a force push: {1} is already part of it. Use Push.', branch, upstream),
      );
      return;
    }
    const ok = await confirmModal(
      vscode.l10n.t('Force-push (with lease) "{0}"?', branch),
      vscode.l10n.t(
        '{0} will be replaced by your "{1}": the commits that are only on {0} will be gone from it. The push is refused if {0} has commits you have not fetched, or fetched and not brought into "{1}".',
        upstream ?? vscode.l10n.t('The remote branch'),
        branch,
      ),
      vscode.l10n.t('Force Push'),
    );
    if (!ok) return;
    const extra = ['--force-with-lease'];
    if (core.git.caps.forceIfIncludes) extra.push('--force-if-includes');
    await push(repo, extra);
  });

  async function upstreamOf(repo: RepoHandle): Promise<string | undefined> {
    const res = await core.git.exec(repo.root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], {
      structured: true,
      allowNonZeroExit: true,
    });
    const ref = res.stdout.trim();
    return res.exitCode === 0 && ref.length > 0 ? ref : undefined;
  }

  async function isAncestorOf(repo: RepoHandle, a: string, b: string): Promise<boolean> {
    const res = await core.git.exec(repo.root, ['merge-base', '--is-ancestor', a, b], {
      structured: true,
      allowNonZeroExit: true,
    });
    return res.exitCode === 0;
  }

  register('geet.sync', async (repoRoot) => {
    const repo = await pickRepo(core, repoRoot);
    if (!repo) return;
    if (!(await pullAndReport(repo))) return;
    if ((repo.model.snapshot.ahead ?? 0) > 0 || repo.model.snapshot.upstream === undefined) {
      await push(repo);
    }
  });

  // Branches popup — stub QuickPick until P2 replaces the handler.
  register('geet.branches.open', async (repoRoot) => {
    const repo = await pickRepo(core, repoRoot);
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
    const cfg = vscode.workspace.getConfiguration('geet.autofetch');
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
