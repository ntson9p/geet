/**
 * One name per repository root, shared by every surface that lists roots.
 *
 * Two repositories can share a basename — `web/api` and `mobile/api` — and
 * would otherwise render as two identical rows, so a colliding basename grows
 * its parent directory. The rule was written once inside `LogViewProvider` and
 * now has three consumers (the log's `Roots` section, the Repositories view and
 * the Branches view's header), which is exactly the arrangement POST-P14d
 * caught drifting: a repository called one thing in one surface and something
 * else in another is a repository the user cannot match up across two lists.
 */
import * as path from 'node:path';

/** Root → the name to show for it. Keyed by the exact strings passed in. */
export function repoLabels(roots: readonly string[]): Map<string, string> {
  const counts = new Map<string, number>();
  for (const root of roots) {
    const base = path.basename(root);
    counts.set(base, (counts.get(base) ?? 0) + 1);
  }
  const labels = new Map<string, string>();
  for (const root of roots) {
    const base = path.basename(root);
    labels.set(
      root,
      (counts.get(base) ?? 0) > 1 ? `${path.basename(path.dirname(root))}/${base}` : base,
    );
  }
  return labels;
}

/**
 * The roots ordered by the name the user reads, which is the only order a
 * user can predict. The full path breaks ties: two roots can still share a
 * label (`a/web/api` and `b/web/api`), and an unstable sort would let those
 * two rows swap places on an unrelated refresh.
 */
export function sortRootsByLabel(roots: readonly string[]): string[] {
  const labels = repoLabels(roots);
  return [...roots].sort(
    (a, b) => (labels.get(a) ?? a).localeCompare(labels.get(b) ?? b) || a.localeCompare(b),
  );
}
