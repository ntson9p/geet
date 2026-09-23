/**
 * Update Project argv (P13-T2), vscode-free so the flag matrix is unit-testable
 * and the question's command lines are built from the same source the host
 * runs.
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

import { formatGitCommands } from './commandLine';

export type UpdateStrategy = 'merge' | 'rebase';

/** How `gittree.update.strategy` is stored: `ask` keeps the question. */
export type UpdateStrategySetting = 'ask' | UpdateStrategy;

/** One button of the Update Project question. */
export type UpdateChoice = UpdateStrategy | 'reset';

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

/**
 * The Update Project question as data (POST-P14ab).
 *
 * IntelliJ asks with a small modal dialog: two radio buttons, `Don't show
 * again`, OK. VS Code gives an extension no modal surface that can hold a
 * radio button (D30), but it does give a native modal message box, and a
 * two-way choice is exactly what a pair of buttons is for — so each radio
 * becomes a button, and pressing it is the OK.
 */
export interface UpdateQuestion {
  /**
   * Button order. The strategy chosen last time comes first, because the
   * first button is the default: Enter repeats it, which is what IntelliJ's
   * pre-selected radio plus OK does. `Reset to the Remote Branch` is always
   * last — the destructive answer is never the one Enter reaches.
   */
  readonly choices: readonly UpdateChoice[];
  /** What each button runs, formatted as the dim command line. */
  readonly commands: Readonly<Record<UpdateChoice, string>>;
}

export function buildUpdateQuestion(
  remembered: UpdateStrategy,
  upstreamRef: string,
  remote?: string,
): UpdateQuestion {
  const strategies: UpdateStrategy[] =
    remembered === 'rebase' ? ['rebase', 'merge'] : ['merge', 'rebase'];
  return {
    choices: [...strategies, 'reset'],
    commands: {
      merge: formatGitCommands(buildUpdatePlan('update', 'merge', upstreamRef, remote)),
      rebase: formatGitCommands(buildUpdatePlan('update', 'rebase', upstreamRef, remote)),
      reset: formatGitCommands(buildUpdatePlan('reset', 'merge', upstreamRef, remote)),
    },
  };
}
