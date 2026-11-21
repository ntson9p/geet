/**
 * Status-bar widget shaping (POST-P14r, branded by POST-P14t). vscode-free so
 * the rules are unit-testable.
 *
 * Two things this file is responsible for, and it is worth keeping them apart.
 *
 * **Footprint.** `$(arrow-down) 26050 $(arrow-up) 10893` had nothing bounding
 * either side, in a fixed-width strip where Geet's entries sit at the
 * low-priority end. That is a real cost and the caps here are the answer to it.
 * It was *not* the cause of the "branch button disappears" report, whatever an
 * earlier version of this comment claimed — that was a shared `StatusBarItem`
 * id, fixed in POST-P14s; see `statusBar.ts`.
 *
 * **Identity.** The compact button was an unlabelled `$(git-branch)` sitting
 * beside the built-in Git extension's own `$(git-branch)` — the same glyph,
 * two entries apart. It read as a duplicate of VS Code's widget rather than as
 * Geet, and told someone who had just installed the extension nothing about
 * where to click. So the button carries the product's name and a mark that is
 * deliberately not git's. `full` keeps `$(git-branch)`: there the widget *is*
 * the branch readout, the branch name is the label, and nothing else is
 * drawing one.
 */
import type { RepoSnapshot } from '../core/model/repositoryModel';
import { isConflicted } from '../core/model/statusEntry';

/**
 * The brand slot. A stock codicon for now — `contributes.icons` would let this
 * be `media/geet-mark.svg` as a font glyph, which is the only way an SVG can
 * reach status-bar text. `$(list-tree)` is chosen for what it is *not*:
 * `$(git-branch)`, `$(source-control)` and `$(git-commit)` all already appear
 * in this strip, drawn by VS Code or by us.
 */
export const BRAND_ICON = '$(list-tree)';

/** Never localized, never abbreviated: it is the product's name. */
export const BRAND_LABEL = 'Geet';

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
    // Constant width, and the spinner takes the *mark's* box — the label and
    // the chevron never move, so a fetch is a glyph swap with no reflow at all.
    // The chevron stays through it: it is what says "this opens a menu", and a
    // fetch is no reason to stop saying so.
    text = `${fetching ? '$(sync~spin)' : BRAND_ICON} ${BRAND_LABEL} $(chevron-down)`;
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
