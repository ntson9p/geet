/**
 * Pure label/heat helpers for the blame gutter (P4-T7), split out of
 * `blameUi` so they can be unit-tested without a `vscode` host.
 */
import type { LineBlame } from './blameService';

export const BUCKETS = 10;

/**
 * Non-breaking space. VS Code renders `before.contentText` straight into a
 * CSS `content:'…'` on a `::before` pseudo-element, and `.view-lines` carries
 * `white-space: nowrap` — so runs of U+0020 collapse to one and leading ones
 * vanish entirely, which destroys the fixed-width column (Monaco escapes its
 * own line text to `&nbsp;` but nothing rewrites a decoration's content).
 * Pad and render with U+00A0, which is not collapsible.
 */
export const NBSP = '\u00a0';

/** Make a label safe to hand to `DecorationRenderOptions.before.contentText`. */
export function toDecorationText(label: string): string {
  return label.replace(/ /g, NBSP);
}

export function formatBlameLabel(
  format: string,
  blame: LineBlame,
  now: number = Date.now(),
): string {
  const date = blame.isUncommitted ? '' : relativeDate(blame.authorTime, now);
  return format
    .replace(/\$\{author(?:\|(\d+))?\}/g, (_, w) => fit(blame.author, w ? Number(w) : 12))
    .replace(/\$\{date(?:\|relative)?\}/g, () => fit(date, 10))
    .replace(/\$\{sha(?:\|(\d+))?\}/g, (_, w) => {
      const width = w ? Number(w) : 7;
      return fit(blame.isUncommitted ? '*' : blame.sha.slice(0, width), width);
    });
}

function fit(s: string, width: number): string {
  return s.length > width ? s.slice(0, width - 1) + '…' : s.padEnd(width);
}

export function relativeDate(unixSeconds: number, now: number): string {
  const days = Math.floor((now / 1000 - unixSeconds) / 86_400);
  if (days < 1) return 'today';
  if (days < 30) return `${days}d ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

/** Decile bucket of a commit time across the file's blame span (0 = newest). */
export function heatBucket(time: number, sortedTimes: readonly number[]): number {
  if (sortedTimes.length === 0) return BUCKETS - 1;
  let idx = sortedTimes.findIndex((t) => t >= time);
  if (idx === -1) idx = sortedTimes.length - 1;
  const percentileFromNewest = 1 - idx / Math.max(1, sortedTimes.length - 1 || 1);
  return Math.min(BUCKETS - 1, Math.floor(percentileFromNewest * BUCKETS));
}
