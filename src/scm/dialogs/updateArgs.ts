/**
 * Update Project argv (P13-T2), vscode-free so the flag matrix is unit-testable
 * and the dialog's "will run" line is built from the same source the host runs.
 *
 * IntelliJ's Update Project is fetch-then-integrate, and GitTree runs it that
 * way rather than as a bare `git pull`, for two reasons:
 *   - the radio is authoritative. `git pull` obeys `pull.rebase` config, so a
 *     user who picked "Merge" could silently get a rebase; an explicit
 *     `merge`/`rebase` against the tracking ref cannot be overridden.
 *   - the fetch boundary is measurable. Holding the upstream sha from before
 *     and after the fetch is what lets the result notification say how many
 *     commits actually came in, for a rebase as well as a merge — `HEAD` before
 *     and after would over-count rewritten local commits (see docs deviation
 *     D9: this notification replaces IntelliJ's `Update Info` tab).
 */

export type UpdateStrategy = 'merge' | 'rebase';

/** How `gittree.update.strategy` is stored: `ask` keeps the dialog. */
export type UpdateStrategySetting = 'ask' | UpdateStrategy;

export function normalizeStrategySetting(raw: string | undefined): UpdateStrategySetting {
  return raw === 'merge' || raw === 'rebase' ? raw : 'ask';
}

/** The fetch half — always pruned, matching the P1 `gittree.fetch` behaviour. */
export function buildUpdateFetchArgs(remote?: string): string[] {
  return remote !== undefined && remote.length > 0
    ? ['fetch', '--prune', remote]
    : ['fetch', '--prune'];
}

/**
 * The integrate half, against the tracking ref the fetch just moved. Merge is
 * plain — it fast-forwards when the branch has not diverged, which is what
 * "update" means; forcing `--no-ff` here would manufacture a merge commit on
 * every pull (the `--no-ff` option belongs to P13-T3's Merge dialog).
 */
export function buildIntegrateArgs(strategy: UpdateStrategy, upstreamRef: string): string[] {
  return strategy === 'rebase' ? ['rebase', upstreamRef] : ['merge', upstreamRef];
}

/** `Reset to the Remote Branch` — the destructive footer action. */
export function buildResetToRemoteArgs(upstreamRef: string): string[] {
  return ['reset', '--hard', upstreamRef];
}

/**
 * Every command the chosen action will run, in order — the source of both the
 * dialog's preview line and the host's execution.
 */
export function buildUpdatePlan(
  action: 'update' | 'reset',
  strategy: UpdateStrategy,
  upstreamRef: string,
  remote?: string,
): string[][] {
  const fetch = buildUpdateFetchArgs(remote);
  return action === 'reset'
    ? [fetch, buildResetToRemoteArgs(upstreamRef)]
    : [fetch, buildIntegrateArgs(strategy, upstreamRef)];
}
