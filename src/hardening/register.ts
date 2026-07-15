/**
 * Phase 10 registration (T1 large-repo playbook; T3/T4 append onboarding and
 * telemetry here). Single entry point per master §0.6.
 *
 * Large-repo playbook (P10-T1 step 4): repositories with more than 50k
 * tracked files get a ONE-TIME prompt offering git's built-in FSMonitor and
 * the untracked cache — the two biggest `git status` accelerators. Gated on
 * `caps.fsmonitor` (git ≥ 2.37); the answer (either way) is remembered in
 * globalState per repo identity. Commit-graph maintenance already runs via
 * P4-T1's throttled maintenance task.
 */
import * as vscode from 'vscode';
import type { Core, RepoHandle } from '../core/core';
import { canonicalKey } from '../core/repoDiscovery';
import { repoStoreKey } from '../localHistory/snapshotStore';

/** Tracked-file threshold above which the playbook prompt appears. */
const LARGE_REPO_FILES = 50_000;

function threshold(): number {
  const seeded = process.env['GITTREE_TEST_LARGE_REPO_THRESHOLD'];
  if (seeded !== undefined) {
    const n = Number.parseInt(seeded, 10);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return LARGE_REPO_FILES;
}

export function registerPhase10Hardening(context: vscode.ExtensionContext, core: Core): void {
  const promptedKey = (repo: RepoHandle): string =>
    `gittree.perfPlaybook.${repoStoreKey(canonicalKey(repo.root))}`;

  const maybeOffer = async (repo: RepoHandle): Promise<void> => {
    if (context.globalState.get<boolean>(promptedKey(repo)) === true) return;

    // Capability gate (executor-owned caps) + tracked-file count in one cheap
    // read op; the count is NUL-counted (no path decoding).
    const count = await repo.queue.enqueue({
      label: 'perf playbook file count',
      kind: 'read',
      run: async (git, token) => {
        if (!git.caps.fsmonitor) return -1;
        const out = await git.exec(repo.root, ['ls-files', '-z'], {
          structured: true,
          noOptionalLocks: true,
          token,
        });
        let n = 0;
        for (let i = 0; i < out.stdout.length; i++) if (out.stdout.charCodeAt(i) === 0) n++;
        return n;
      },
    });
    if (count < 0 || count <= threshold()) return;

    const enable = vscode.l10n.t('Enable');
    const never = vscode.l10n.t("Don't Ask Again");
    const seeded = process.env['GITTREE_TEST_PLAYBOOK_CHOICE'];
    const choice =
      seeded !== undefined
        ? seeded === 'enable'
          ? enable
          : never
        : await vscode.window.showInformationMessage(
            vscode.l10n.t(
              'Large repository detected ({0} tracked files). Enable git\'s file-system monitor and untracked cache to speed up status refreshes?',
              count.toLocaleString(),
            ),
            enable,
            never,
          );
    if (choice === undefined) return; // dismissed — ask again next session
    await context.globalState.update(promptedKey(repo), true);
    if (choice !== enable) return;

    await repo.queue.enqueue({
      label: vscode.l10n.t('Enable FSMonitor'),
      kind: 'mutate',
      run: async (git, token) => {
        await git.exec(repo.root, ['config', 'core.fsmonitor', 'true'], { token });
        await git.exec(repo.root, ['config', 'core.untrackedCache', 'true'], { token });
      },
    });
    core.output.appendLine(`[perf] fsmonitor + untrackedCache enabled for ${repo.root}`);
  };

  for (const repo of core.repos) void maybeOffer(repo);
  const sub = core.onDidAddRepo((repo) => void maybeOffer(repo));
  context.subscriptions.push(new vscode.Disposable(() => sub.dispose()));

  core.debugRegistry.set('phase10', {
    offerPlaybook: (repoRoot: string) => {
      const repo = core.repos.find((r) => canonicalKey(r.root) === canonicalKey(repoRoot));
      return repo ? maybeOffer(repo) : Promise.resolve();
    },
  });
}
