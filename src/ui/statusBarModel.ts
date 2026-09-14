/**
 * Status-bar widget shaping (POST-P14r). vscode-free so the width rules are
 * unit-testable — which is the point, because width is what broke.
 *
 * The defect this file exists to prevent: the sync item rendered
 * `$(arrow-down) 26050 $(arrow-up) 10893` once a fetch landed in a repository
 * far behind its upstream. Nothing bounded it, the status bar is a fixed-width
 * strip, and GitTree's entries sit at the low-priority end of it — so the
 * branch widget stopped being drawn and looked, to the user, like it had
 * vanished. Every rule here is about keeping the widget's footprint bounded and
 * about not paying width for something VS Code's own widget already shows.
 */
import type { RepoSnapshot } from '../core/model/repositoryModel';
import { isConflicted } from '../core/model/statusEntry';

/** What the user asked for. `auto` resolves against the built-in Git extension. */
export type StatusBarMode = 'auto' | 'button' | 'full' | 'off';
/** What `auto` resolved to — the only thing the renderer ever sees. */
export type ResolvedStatusBarMode = 'button' | 'full' | 'off';

/**
 * `auto` is the whole point of the setting: the compact button while something
 * else is already drawing a branch readout, the full widget when nothing is.
 * Detection is deliberately conservative — see `builtInGitPresent` in
 * `scm/register.ts` for what it can and cannot observe.
 */
export function resolveStatusBarMode(
  configured: StatusBarMode,
  builtInGitPresent: boolean,
): ResolvedStatusBarMode {
  if (configured !== 'auto') return configured;
  return builtInGitPresent ? 'button' : 'full';
}

/**
 * IntelliJ shows `↙99+ ↗99+` rather than the true number, and that cap is the
 * fix: five digits a side is ten characters of status bar no layout budgeted
 * for. The exact figures live in the tooltip, which costs nothing.
 */
export function formatCount(n: number): string {
  return n > 99 ? '99+' : String(n);
}

/** `REBASING 2/5` — the in-progress half, shared by both modes. */
export function opLabel(snap: RepoSnapshot): string | undefined {
  const op = snap.inProgressOp;
  if (!op) return undefined;
  const name =
    op.kind === 'merge'
      ? 'MERGING'
      : op.kind === 'cherry-pick'
        ? 'CHERRY-PICKING'
        : op.kind === 'revert'
          ? 'REVERTING'
          : 'REBASING';
  const steps = op.step !== undefined && op.total !== undefined ? ` ${op.step}/${op.total}` : '';
  return `${name}${steps}`;
}

export function conflictCount(snap: RepoSnapshot): number {
  return snap.statusEntries.filter(isConflicted).length;
}

export function headLabel(snap: RepoSnapshot): string {
  return snap.detached
    ? `$(git-commit) ${(snap.headSha ?? '').slice(0, 7)}`
    : `$(git-branch) ${snap.headRef ?? '…'}`;
}

/**
 * The widget's text. Returns `''` for `off`, which the controller reads as
 * "contribute no item at all".
 */
export function renderStatusBarText(
  snap: RepoSnapshot,
  fetching: boolean,
  mode: ResolvedStatusBarMode,
): string {
  if (mode === 'off') return '';

  let text: string;
  if (mode === 'button') {
    // Constant width. `$(sync~spin)` occupies the same box as `$(git-branch)`,
    // so a fetch is visible without the widget changing size at all.
    text = `${fetching ? '$(sync~spin)' : '$(git-branch)'}$(chevron-down)`;
  } else {
    text = headLabel(snap);
    if (fetching) {
      text += ' $(sync~spin)';
    } else {
      const behind = snap.behind ?? 0;
      const ahead = snap.ahead ?? 0;
      // A zero side is not information — IntelliJ omits it too, and printing
      // `$(arrow-up) 0` cost width on every repository that was merely behind.
      if (behind > 0) text += ` $(arrow-down) ${formatCount(behind)}`;
      if (ahead > 0) text += ` $(arrow-up) ${formatCount(ahead)}`;
    }
  }

  // The growth rule, and the only one: add what VS Code's own widget does not
  // show. Anything else here would be the duplicate this reshape removed.
  const op = opLabel(snap);
  if (op !== undefined) text += ` $(warning) ${op}`;
  const conflicts = conflictCount(snap);
  if (conflicts > 0) text += ` $(error) ${formatCount(conflicts)}`;

  return text;
}
