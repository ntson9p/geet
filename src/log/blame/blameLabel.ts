/**
 * Pure label/age helpers for the blame gutter (P4-T7), split out of
 * `blameUi` so they can be unit-tested without a `vscode` host.
 */
import type { LineBlame } from './blameService';

/**
 * Steps in the annotation age gradient.
 *
 * IntelliJ carries a commit's age in the *background* of its annotation cell,
 * shading it from five anchor colours on the colour-scheme page (Version
 * Control → Annotations) interpolated across the revisions the file actually
 * has. A VS Code extension cannot read a resolved `ThemeColor`, so that
 * interpolation cannot happen here: the five anchors are contributed verbatim
 * as themable colours and the ramp is quantised to five steps instead, which
 * is about the resolution the eye gets out of the interpolated version anyway.
 */
export const AGE_STEPS = 5;

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

/**
 * Age step of a commit: `0` = newest, `AGE_STEPS - 1` = oldest.
 *
 * Ranked over the distinct commit times *in this file*, not against the wall
 * clock — this is IntelliJ's "Order" colouring, and ranking is the whole point
 * of it: absolute age would leave a file whose history is all from one release
 * as a single flat colour. The cost is that "faded" means "oldest of this
 * file" rather than "old", so a file touched only last week still spans the
 * full gradient.
 */
export function ageStep(time: number, sortedTimes: readonly number[]): number {
  // Nothing to rank against. A file with one revision is that revision's
  // newest, not its oldest — the far end of the ramp would read as stale.
  if (sortedTimes.length <= 1) return 0;
  let idx = sortedTimes.findIndex((t) => t >= time);
  if (idx === -1) idx = sortedTimes.length - 1;
  const distanceFromNewest = 1 - idx / (sortedTimes.length - 1);
  return Math.min(AGE_STEPS - 1, Math.floor(distanceFromNewest * AGE_STEPS));
}
