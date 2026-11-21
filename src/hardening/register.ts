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
import {
  durationBucket,
  NOOP_SENDER,
  Telemetry,
  type TelemetryEventName,
  type TelemetrySender,
} from '../core/telemetry';
import { repoStoreKey } from '../localHistory/snapshotStore';
import { registerOnboarding } from '../onboarding/register';
import { collectIssueInfo, errorCopy, presentGitError, registerErrorReporting } from './errorUx';
import { newIssueUrl } from '../core/errorUx';
import type { GitErrorKind } from '../core/git/errors';

/** Tracked-file threshold above which the playbook prompt appears. */
const LARGE_REPO_FILES = 50_000;

function threshold(): number {
  const seeded = process.env['GEET_TEST_LARGE_REPO_THRESHOLD'];
  if (seeded !== undefined) {
    const n = Number.parseInt(seeded, 10);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return LARGE_REPO_FILES;
}

export function registerPhase10Hardening(
  context: vscode.ExtensionContext,
  core: Core,
  perf?: { activationSyncMs: number },
): void {
  const promptedKey = (repo: RepoHandle): string =>
    `geet.perfPlaybook.${repoStoreKey(canonicalKey(repo.root))}`;

  // ---- P10-T4: telemetry (double-gated, content-free, NO backend) ----------
  // The shipped sender is a no-op by owner decision — there is no service to
  // receive events. Tests swap in a buffering sender via the env seam.
  const testEvents: { name: string; props: Record<string, string> }[] = [];
  const sender: TelemetrySender =
    process.env['GEET_TEST'] === '1'
      ? { send: (name, props) => void testEvents.push({ name, props }) }
      : NOOP_SENDER;
  const telemetry = new Telemetry({
    envEnabled: () =>
      process.env['GEET_TEST_TELEMETRY_ENV'] === '1' || vscode.env.isTelemetryEnabled,
    settingEnabled: () =>
      vscode.workspace.getConfiguration('geet').get<boolean>('telemetry.enabled', false),
    sender,
  });
  telemetry.event('activation', { syncBucket: durationBucket(perf?.activationSyncMs ?? 0) });

  const instrumentRepo = (repo: RepoHandle): void => {
    const sub = repo.queue.onDidFinishMutation((e) => {
      telemetry.event('op.duration', {
        bucket: durationBucket(e.durationMs ?? 0),
        destructive: e.isDestructive,
      });
      if (!e.succeeded && e.errorKind !== undefined) {
        telemetry.event('op.errorKind', { kind: e.errorKind });
      }
    });
    context.subscriptions.push(new vscode.Disposable(() => sub.dispose()));
  };
  for (const repo of core.repos) instrumentRepo(repo);

  // ---- P10-T4: error UX (report command; presenter exported for features) --
  registerErrorReporting(context, core);

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
    const seeded = process.env['GEET_TEST_PLAYBOOK_CHOICE'];
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
  const sub = core.onDidAddRepo((repo) => {
    instrumentRepo(repo);
    void maybeOffer(repo);
  });
  context.subscriptions.push(new vscode.Disposable(() => sub.dispose()));

  // P10-T3: onboarding (walkthrough command, playground generator, what's new).
  const onboarding = registerOnboarding(context, core, telemetry);

  core.debugRegistry.set('phase10', {
    offerPlaybook: (repoRoot: string) => {
      const repo = core.repos.find((r) => canonicalKey(r.root) === canonicalKey(repoRoot));
      return repo ? maybeOffer(repo) : Promise.resolve();
    },
    ...onboarding,
    // P10-T4 seams: schema-gated telemetry buffer + error UX inspection.
    telemetryEvents: () => [...testEvents],
    sendTelemetry: (name: string, props: Record<string, string | number | boolean>) =>
      telemetry.event(name as TelemetryEventName, props),
    errorCopy: (kind: string) => errorCopy(kind as GitErrorKind),
    presentError: (err: unknown) => presentGitError(context, core, err),
    buildIssueUrl: (kind?: string) =>
      newIssueUrl(collectIssueInfo(context, core, kind as GitErrorKind | undefined)),
  });
}
