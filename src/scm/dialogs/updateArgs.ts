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

import type { StatusEntry } from '../../core/git/parsers/statusV2';
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
export function buildIntegrateArgs(
  strategy: UpdateStrategy,
  upstreamRef: string,
  autostash = false,
): string[] {
  return [strategy, ...(autostash ? ['--autostash'] : []), upstreamRef];
}

/** `Reset to the Remote Branch` — the destructive footer action. */
export function buildResetToRemoteArgs(upstreamRef: string): string[] {
  return ['reset', '--hard', upstreamRef];
}

/**
 * What an update puts aside around its merge or rebase, and restores after
 * (POST-P14ac).
 *
 * IntelliJ never refuses an update because you are mid-work: it shelves or
 * stashes your uncommitted changes, integrates, and puts them back. A bare
 * `git rebase` refuses outright on **any** uncommitted change, and a bare
 * `git merge` refuses whenever an incoming commit touches a file you edited —
 * which is what made an update that asks nothing unsafe to offer.
 */
export interface SetAside {
  /**
   * Pass `--autostash`: git stashes tracked changes before the integrate step
   * and re-applies them after it — and, when that step stops on a conflict,
   * after the user finishes it, which is the part a hand-rolled stash could
   * not reproduce.
   */
  readonly autostash: boolean;
  /**
   * Intent-to-add entries (`git add -N`, which `Add to VCS` and the changelist
   * commit path both create) taken out of the index around the integrate step
   * and put back after. `git stash` cannot save them — "Cannot save the current
   * worktree state" — so `--autostash` alone would *break* an update that plain
   * `git merge` handles. Out of the index they are ordinary untracked files,
   * which every step here leaves alone.
   */
  readonly detach: readonly string[];
}

export const NOTHING_SET_ASIDE: SetAside = { autostash: false, detach: [] };

/** `git add -N` entries: tracked, but with nothing of theirs in the index yet. */
export function intentToAddPaths(entries: readonly StatusEntry[]): string[] {
  return entries.filter((e) => e.kind === 'ordinary' && e.x === '.' && e.y === 'A').map((e) => e.path);
}

/**
 * Tracked changes `--autostash` would actually stash — anything modified,
 * staged or not, apart from intent-to-add entries, which are detached instead.
 * A clean tree stashes nothing, so its re-apply can conflict with nothing.
 */
export function hasStashableChanges(entries: readonly StatusEntry[]): boolean {
  return entries.some(
    (e) =>
      (e.kind === 'ordinary' || e.kind === 'renamed' || e.kind === 'copied') &&
      !(e.x === '.' && e.y === 'A'),
  );
}

/** Any entry with content in the index — the staged half of the staging paradigm. */
export function hasStagedChanges(entries: readonly StatusEntry[]): boolean {
  return entries.some(
    (e) => (e.kind === 'ordinary' || e.kind === 'renamed' || e.kind === 'copied') && e.x !== '.',
  );
}

/**
 * Decides what to put aside, from a status read at the moment the update runs.
 *
 * The rule is **set aside only what can come back exactly as it was.**
 * `--autostash` restores content but not the index: a half-staged file comes
 * back wholly unstaged (measured — `MM` returns as ` M`). In the changelists
 * paradigm the index holds nothing but intent-to-add entries, which are
 * detached separately, so nothing is lost. With real staged content — the
 * staging paradigm, or a `git add` from a terminal — autostash would silently
 * undo the user's staging, so it is not passed: the plain command runs, and
 * git either proceeds with the index intact (a merge that touches none of it)
 * or refuses in its own words, before changing anything.
 */
export function planSetAside(
  entries: readonly StatusEntry[],
  strategy: UpdateStrategy,
  mergeAutostash: boolean,
): SetAside {
  const supported = strategy === 'rebase' || mergeAutostash;
  return {
    autostash: supported && !hasStagedChanges(entries),
    detach: intentToAddPaths(entries),
  };
}

/** Out of the index, left on disk: an intent-to-add entry becomes untracked. */
export function buildDetachArgs(paths: readonly string[]): string[] {
  return ['rm', '--cached', '-q', '--', ...paths];
}

/** Back to intent-to-add, exactly what `Add to VCS` made them. */
export function buildReattachArgs(paths: readonly string[]): string[] {
  return ['add', '-N', '--', ...paths];
}

/**
 * Every command the chosen action will run, in order — the source of both the
 * question's command lines and the host's execution. The reset path ignores
 * `aside`: putting changes aside around a `reset --hard` would defeat the one
 * thing it is for.
 */
export function buildUpdatePlan(
  action: 'update' | 'reset',
  strategy: UpdateStrategy,
  upstreamRef: string,
  remote?: string,
  aside: SetAside = NOTHING_SET_ASIDE,
): string[][] {
  const fetch = buildUpdateFetchArgs(remote);
  if (action === 'reset') return [fetch, buildResetToRemoteArgs(upstreamRef)];
  const integrate = buildIntegrateArgs(strategy, upstreamRef, aside.autostash);
  return aside.detach.length === 0
    ? [fetch, integrate]
    : [fetch, buildDetachArgs(aside.detach), integrate, buildReattachArgs(aside.detach)];
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

/**
 * `asideFor` says what each strategy would put aside, judged from the status
 * the question was built from; the run re-reads status and decides again, so
 * the lines describe the likely run rather than bind it.
 */
export function buildUpdateQuestion(
  remembered: UpdateStrategy,
  upstreamRef: string,
  remote?: string,
  asideFor: (strategy: UpdateStrategy) => SetAside = () => NOTHING_SET_ASIDE,
): UpdateQuestion {
  const strategies: UpdateStrategy[] =
    remembered === 'rebase' ? ['rebase', 'merge'] : ['merge', 'rebase'];
  const plan = (strategy: UpdateStrategy): string =>
    formatGitCommands(buildUpdatePlan('update', strategy, upstreamRef, remote, asideFor(strategy)));
  return {
    choices: [...strategies, 'reset'],
    commands: {
      merge: plan('merge'),
      rebase: plan('rebase'),
      reset: formatGitCommands(buildUpdatePlan('reset', 'merge', upstreamRef, remote)),
    },
  };
}
