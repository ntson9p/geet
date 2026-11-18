/**
 * Pure "What's new" gate (P10-T3) — vscode-free so it is unit-testable:
 * notify once per MINOR version change, never on fresh installs.
 */
/**
 * The changelog's names in the extension's folder, first the one to try (POST-P14cr).
 * vsce packages CHANGELOG.md as `changelog.md` (README.md as `readme.md`), so on a
 * case-sensitive file system (Linux) an installed GitTree has no `CHANGELOG.md`, and
 * "What's New" opened a preview of nothing. A development host runs from the
 * repository, where the name is `CHANGELOG.md`.
 */
export const CHANGELOG_NAMES = ['changelog.md', 'CHANGELOG.md'] as const;

/** The first of `CHANGELOG_NAMES` that `exists` in the extension's folder, or none. */
export function changelogName(exists: (name: string) => boolean): string | undefined {
  return CHANGELOG_NAMES.find((name) => exists(name));
}

export function whatsNewDecision(
  seenMinor: string | undefined,
  version: string,
): { minor: string; show: boolean } {
  const minor = version.split('.').slice(0, 2).join('.');
  if (seenMinor === undefined) return { minor, show: false }; // fresh install — no popup
  return { minor, show: seenMinor !== minor };
}
