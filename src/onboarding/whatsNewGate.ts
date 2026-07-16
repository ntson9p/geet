/**
 * Pure "What's new" gate (P10-T3) — vscode-free so it is unit-testable:
 * notify once per MINOR version change, never on fresh installs.
 */
export function whatsNewDecision(
  seenMinor: string | undefined,
  version: string,
): { minor: string; show: boolean } {
  const minor = version.split('.').slice(0, 2).join('.');
  if (seenMinor === undefined) return { minor, show: false }; // fresh install — no popup
  return { minor, show: seenMinor !== minor };
}
