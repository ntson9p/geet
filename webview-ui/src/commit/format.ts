/**
 * Formatting helpers for the commit window's message dropdowns (P11-T4).
 * Webview strings are English by convention (no l10n bundle ships to
 * webviews); the host-side QuickPick equivalent localises via vscode.l10n.
 */

export function firstLine(message: string): string {
  return message.split('\n', 1)[0] ?? message;
}

/** Mirrors `src/commit/messageHistory.ts` `relativeTime`. */
export function relativeTime(ts: number, now: number): string {
  const minutes = Math.round((now - ts) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return new Date(ts).toLocaleDateString();
}
