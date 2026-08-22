/**
 * File-status palette (P11-T8): IntelliJ's status colors mapped onto VS Code
 * theme colors, with per-status user overrides (`gittree.colors.<status>`).
 *
 * The defaults are the theme's own `gitDecoration-*` variables, so status
 * colors track the active theme (HC included) exactly like the SCM viewlet —
 * and a color-blind user can either pick a theme that separates them or set
 * explicit overrides. Pure and DOM-free: unit-tested under the root suite.
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
  added: 'gitDecoration-addedResourceForeground',
  modified: 'gitDecoration-modifiedResourceForeground',
  deleted: 'gitDecoration-deletedResourceForeground',
  renamed: 'gitDecoration-renamedResourceForeground',
  untracked: 'gitDecoration-untrackedResourceForeground',
  conflicted: 'gitDecoration-conflictingResourceForeground',
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
