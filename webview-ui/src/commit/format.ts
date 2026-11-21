/**
 * Formatting helpers for the commit window's message dropdowns (P11-T4).
 * Webview strings are English by convention (no l10n bundle ships to
 * webviews); the host-side QuickPick equivalent localises via vscode.l10n.
 */

import type { LogDateFormat } from '../../../src/shared/protocol';
import { createDetailsDate } from '../log/dateFormat';

export function firstLine(message: string): string {
  return message.split('\n', 1)[0] ?? message;
}

/**
 * Mirrors `src/commit/messageHistory.ts` `relativeTime`: an age within the
 * day, the date after it — written as the log writes dates
 * (`geet.log.dateFormat`), not the locale's `11/5/2026` beside a log
 * reading `2026/11/05` (POST-QA).
 */
export function relativeTime(ts: number, now: number, dateFormat: LogDateFormat = 'locale'): string {
  const minutes = Math.round((now - ts) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return createDetailsDate(dateFormat)(Math.floor(ts / 1000)).date;
}
