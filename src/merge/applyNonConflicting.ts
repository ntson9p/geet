/**
 * Apply non-conflicting changes — Left · All · Right (P13-T8, gap analysis
 * §3.5). IntelliJ's merge toolbar offers **three** actions; Geet's magic
 * wand implemented only the "All" one, so a user who wanted just their own
 * side's safe changes had no way to ask for it.
 *
 * Pure and deterministic, over the same `ConflictBlock` model the wand uses.
 *
 * What "non-conflicting" means per side, in this three-way model:
 *   - **left**  — only the LEFT side moved (`theirs === base`), so taking
 *     `ours` cannot lose anything;
 *   - **right** — only the RIGHT side moved (`ours === base`), take `theirs`;
 *   - a block where both sides made the *identical* change belongs to neither
 *     and both: either button resolves it, and the content is the same;
 *   - everything else (disjoint interleave, whitespace-only divergence) is a
 *     genuinely two-sided resolution and belongs to **All** alone — which is
 *     exactly the wand's cascade.
 */
import type { ConflictBlock } from './mergeCompute';
import { resolveBlock, type WandOptions } from './resolver/autoResolver';

export type ApplySide = 'left' | 'all' | 'right';

const joined = (lines: readonly string[]): string => lines.join('');

/** The side(s) a block can be resolved from without weighing one against the other. */
export function nonConflictingSide(
  block: Pick<ConflictBlock, 'base' | 'ours' | 'theirs'>,
): 'left' | 'right' | 'both' | undefined {
  const base = joined(block.base);
  const ours = joined(block.ours);
  const theirs = joined(block.theirs);
  if (ours === theirs) return 'both'; // identical change on both sides
  if (theirs === base) return 'left'; // only the left side moved
  if (ours === base) return 'right'; // only the right side moved
  return undefined;
}

/** The lines a one-sided apply would write, or undefined when it does not apply. */
export function sideResolution(
  block: Pick<ConflictBlock, 'base' | 'ours' | 'theirs'>,
  side: 'left' | 'right',
): string[] | undefined {
  const which = nonConflictingSide(block);
  if (which === undefined) return undefined;
  if (which === 'both') return [...block.ours];
  if (which !== side) return undefined;
  return side === 'left' ? [...block.ours] : [...block.theirs];
}

export interface ApplyOutcome {
  /** Blocks this call resolved. */
  applied: number;
  /** Unresolved blocks left afterwards. */
  remaining: number;
}

/**
 * Applies one side's (or every) non-conflicting change. `All` runs the wand's
 * full cascade — including the two-sided rules a one-sided apply must not use.
 */
export function applyNonConflicting(
  blocks: readonly ConflictBlock[],
  side: ApplySide,
  opts: WandOptions,
  apply: (block: ConflictBlock, lines: string[]) => void,
): ApplyOutcome {
  let applied = 0;
  for (const block of blocks) {
    if (block.resolution !== undefined) continue;
    if (side === 'all') {
      const outcome = resolveBlock(block, opts);
      if (!outcome.resolved) continue;
      apply(block, outcome.lines);
      applied++;
      continue;
    }
    const lines = sideResolution(block, side);
    if (lines === undefined) continue;
    apply(block, lines);
    applied++;
  }
  return {
    applied,
    remaining: blocks.filter((b) => b.resolution === undefined).length,
  };
}

export interface MergeCounts {
  /** Unresolved blocks the wand could still resolve — IntelliJ's "changes". */
  changes: number;
  /** Unresolved blocks needing a human — IntelliJ's "conflicts". */
  conflicts: number;
  /** Unresolved blocks resolvable from the left side alone. */
  left: number;
  /** Unresolved blocks resolvable from the right side alone. */
  right: number;
}

export function countMerge(
  blocks: readonly ConflictBlock[],
  opts: WandOptions,
): MergeCounts {
  let changes = 0;
  let conflicts = 0;
  let left = 0;
  let right = 0;
  for (const block of blocks) {
    if (block.resolution !== undefined) continue;
    if (resolveBlock(block, opts).resolved) changes++;
    else conflicts++;
    if (sideResolution(block, 'left') !== undefined) left++;
    if (sideResolution(block, 'right') !== undefined) right++;
  }
  return { changes, conflicts, left, right };
}

/**
 * The live toolbar string, in IntelliJ's wording:
 * `No changes. 2 conflicts.` / `3 changes, 1 conflict.` / `All changes applied.`
 */
export function mergeStatusText(counts: MergeCounts): string {
  const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;
  if (counts.changes === 0 && counts.conflicts === 0) return 'All changes applied.';
  if (counts.changes === 0) return `No changes. ${plural(counts.conflicts, 'conflict')}.`;
  if (counts.conflicts === 0) return `${plural(counts.changes, 'change')}, no conflicts.`;
  return `${plural(counts.changes, 'change')}, ${plural(counts.conflicts, 'conflict')}.`;
}
