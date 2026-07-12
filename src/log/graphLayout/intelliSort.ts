/**
 * IntelliSort (P4-T2 step 3): DFS topological re-order that emits each
 * merge's second-parent chain contiguously below the merge — IntelliJ's
 * "branch blocks read linearly" effect. Operates on a page window: commits
 * whose ordering constraints cross the boundary keep their incoming order
 * (spill defers to the next page naturally since lane state is streaming).
 */
import type { GraphInputCommit } from './layout';

export function intelliSort<T extends GraphInputCommit>(commits: readonly T[]): T[] {
  const inWindow = new Map<string, T>();
  for (const c of commits) inWindow.set(c.sha, c);

  // pendingChildren[sha] = number of children (within the window) not yet
  // emitted. A commit becomes available once all its in-window children are
  // out — the DFS stack then prefers the most recently freed (second-parent
  // chains sit on top because parents are pushed [p1, p2, …] and popped LIFO).
  const pendingChildren = new Map<string, number>();
  for (const c of commits) {
    for (const p of c.parents) {
      if (inWindow.has(p)) {
        pendingChildren.set(p, (pendingChildren.get(p) ?? 0) + 1);
      }
    }
  }

  const emitted = new Set<string>();
  const out: T[] = [];
  const stack: T[] = [];

  const emit = (c: T): void => {
    emitted.add(c.sha);
    out.push(c);
    // Free this commit's parents; push in [p1, …, pN] order so the LAST
    // parent (the merged branch) pops first and its chain runs contiguously.
    for (const p of c.parents) {
      const remaining = (pendingChildren.get(p) ?? 0) - 1;
      pendingChildren.set(p, remaining);
      const parent = inWindow.get(p);
      if (parent && remaining === 0 && !emitted.has(p)) {
        stack.push(parent);
      }
    }
  };

  for (const c of commits) {
    if (emitted.has(c.sha)) continue;
    // Roots of the traversal appear in input (git topo) order.
    if ((pendingChildren.get(c.sha) ?? 0) > 0) continue; // reached later via stack
    emit(c);
    while (stack.length > 0) {
      const next = stack.pop() as T;
      if (!emitted.has(next.sha)) emit(next);
    }
  }
  // Any commit still unemitted has children outside the window — keep input
  // order at the tail (page-boundary spill).
  for (const c of commits) {
    if (!emitted.has(c.sha)) {
      emitted.add(c.sha);
      out.push(c);
    }
  }
  return out;
}
