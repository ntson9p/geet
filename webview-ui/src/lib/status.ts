/**
 * File-status palette (P11-T8): IntelliJ's status colors mapped onto VS Code
 * theme colors, with per-status user overrides (`gittree.colors.<status>`).
 *
 * P14-T5: the defaults are GitTree's own `gittree.color.*` contributions, not
 * the built-in git extension's `gitDecoration-*` tokens — those belong to that
 * extension and go blank when a user disables it. Ours ship the same values, so
 * the change is invisible to anyone who liked the old colors, and they still
 * track the active theme (HC included) because they are real theme colors with
 * per-variant defaults. A color-blind user can pick a theme that separates them
 * or set explicit overrides. Pure and DOM-free: unit-tested under the root suite.
 */

export type StatusKind =
  | 'added'
  | 'modified'
  | 'deleted'
  | 'renamed'
  | 'untracked'
  | 'conflicted';

export type StatusColorOverrides = Partial<Record<StatusKind, string>>;

export const STATUS_ICONS: Record<StatusKind, string> = {
  added: 'diff-added',
  modified: 'diff-modified',
  deleted: 'diff-removed',
  renamed: 'diff-renamed',
  untracked: 'diff-added',
  conflicted: 'warning',
};

const THEME_VARS: Record<StatusKind, string> = {
  added: 'gittree-color-added',
  modified: 'gittree-color-modified',
  deleted: 'gittree-color-deleted',
  renamed: 'gittree-color-renamed',
  untracked: 'gittree-color-untracked',
  conflicted: 'gittree-color-conflicted',
};

/** CSS color for a status: the user override, else the theme variable. */
export function statusColor(kind: StatusKind, overrides?: StatusColorOverrides): string {
  const override = overrides?.[kind];
  if (override !== undefined && override.length > 0) return override;
  // Fallback to the plain foreground so an exotic theme never renders blank.
  return `var(--vscode-${THEME_VARS[kind]}, var(--vscode-foreground))`;
}

export function statusIcon(kind: StatusKind): string {
  return STATUS_ICONS[kind];
}

/**
 * `git diff --name-status` letter → status kind. `R`/`C` carry a similarity
 * score (`R100`), so only the first character is significant. Shared by the
 * log's Changed Files pane (P12-T3) and the Push dialog's file tree (P13-T1).
 */
export function kindOf(status: string): StatusKind {
  switch (status.charAt(0)) {
    case 'A':
      return 'added';
    case 'D':
      return 'deleted';
    case 'R':
    case 'C':
      return 'renamed';
    default:
      return 'modified';
  }
}

/**
 * The color a *directory* row takes (P11-T8 step 3, IntelliJ behaviour): a
 * folder whose descendants all share one status wears that status; mixed
 * descendants read as plain "modified". Undefined when nothing is known.
 */
export function dirStatusColor(
  kinds: ReadonlySet<StatusKind>,
  overrides?: StatusColorOverrides,
): string | undefined {
  if (kinds.size === 0) return undefined;
  if (kinds.size === 1) {
    const [only] = [...kinds];
    return only === undefined ? undefined : statusColor(only, overrides);
  }
  return statusColor('modified', overrides);
}
