/**
 * Day-bucket grouping for the Local History view (P9-T3). Pure — no vscode
 * dependency — so the date-boundary logic is unit-testable.
 */
import type { SnapshotManifest } from './snapshotStore';

/** Day bucket label for a timestamp. */
export function dayLabel(ts: number, now: number = Date.now()): string {
  const day = new Date(ts).toDateString();
  if (day === new Date(now).toDateString()) return 'Today';
  if (day === new Date(now - 86_400_000).toDateString()) return 'Yesterday';
  return new Date(ts).toLocaleDateString();
}

/** Groups manifests (already newest-first) into contiguous day buckets. */
export function groupByDay(
  manifests: readonly SnapshotManifest[],
  now: number = Date.now(),
): Array<{ label: string; manifests: SnapshotManifest[] }> {
  const groups: Array<{ label: string; manifests: SnapshotManifest[] }> = [];
  for (const m of manifests) {
    const label = dayLabel(m.ts, now);
    const last = groups[groups.length - 1];
    if (last && last.label === label) last.manifests.push(m);
    else groups.push({ label, manifests: [m] });
  }
  return groups;
}
