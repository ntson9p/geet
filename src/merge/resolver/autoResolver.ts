/**
 * P6-T5 — Magic Wand rule cascade (pure, deterministic, order-fixed per the
 * master plan): identical → one-side-is-base → disjoint interleave →
 * whitespace-only divergence (configurable) → manual. Lines carry their
 * terminators (T2 model), so every rule is byte-exact including CRLF.
 */
import type { ConflictBlock } from '../mergeCompute';
import { baseAnchoredEdits, weaveDisjoint } from './lineDiff3';

export interface WandOptions {
  /** `geet.merge.autoResolveWhitespace` (default on). */
  whitespace: boolean;
}

export type WandRule =
  | 'identical'
  | 'ours-is-base'
  | 'theirs-is-base'
  | 'interleave'
  | 'whitespace';

export type WandOutcome =
  | { resolved: true; lines: string[]; rule: WandRule }
  | { resolved: false };

const joined = (lines: readonly string[]): string => lines.join('');
const normalized = (lines: readonly string[]): string => lines.join('').replace(/\s+/gu, '');

export function resolveBlock(
  block: Pick<ConflictBlock, 'base' | 'ours' | 'theirs'>,
  opts: WandOptions,
): WandOutcome {
  const { base, ours, theirs } = block;

  // 1 — both sides made the identical change.
  if (joined(ours) === joined(theirs)) return { resolved: true, lines: [...ours], rule: 'identical' };

  // 2 — one side equals base (git's conservative adjacency grouping).
  if (joined(ours) === joined(base)) return { resolved: true, lines: [...theirs], rule: 'ours-is-base' };
  if (joined(theirs) === joined(base)) return { resolved: true, lines: [...ours], rule: 'theirs-is-base' };

  // 3 — disjoint interleave: weave both base-anchored edit sets.
  const woven = weaveDisjoint(base, baseAnchoredEdits(base, ours), baseAnchoredEdits(base, theirs));
  if (woven) return { resolved: true, lines: woven, rule: 'interleave' };

  // 4 — whitespace-only divergence on one side → take the substantive side.
  if (opts.whitespace) {
    const oursWsOnly = normalized(ours) === normalized(base);
    const theirsWsOnly = normalized(theirs) === normalized(base);
    if (oursWsOnly && !theirsWsOnly) return { resolved: true, lines: [...theirs], rule: 'whitespace' };
    if (theirsWsOnly && !oursWsOnly) return { resolved: true, lines: [...ours], rule: 'whitespace' };
    if (oursWsOnly && theirsWsOnly) return { resolved: true, lines: [...ours], rule: 'whitespace' };
  }

  // 5 — leave manual.
  return { resolved: false };
}

/** Cascade over every unresolved block; returns how many were resolved. */
export function resolveAllBlocks(
  blocks: readonly ConflictBlock[],
  opts: WandOptions,
  apply: (block: ConflictBlock, lines: string[]) => void,
): number {
  let count = 0;
  for (const block of blocks) {
    if (block.resolution !== undefined) continue;
    const outcome = resolveBlock(block, opts);
    if (outcome.resolved) {
      apply(block, outcome.lines);
      count++;
    }
  }
  return count;
}
