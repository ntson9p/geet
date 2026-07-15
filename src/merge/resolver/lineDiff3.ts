/**
 * P6-T5 — base-anchored line diff for the Magic Wand's disjoint-interleave
 * rule: diff each side against the block's base (exact LCS from P0's patch
 * kit), then weave both edit sets onto the base when the base ranges they
 * touch are disjoint. Pure and deterministic.
 */
import { lcsBlocks } from '../../core/patch/lineDiff';

/** Replace base[start, end) with `lines` (start === end is a pure insert). */
export interface BaseEdit {
  start: number;
  end: number;
  lines: string[];
}

export function baseAnchoredEdits(base: string[], side: string[]): BaseEdit[] {
  return lcsBlocks(base, side).map(([aStart, aEnd, bStart, bEnd]) => ({
    start: aStart,
    end: aEnd,
    lines: side.slice(bStart, bEnd),
  }));
}

/**
 * Weave two edit sets onto the base in base order, or undefined when any
 * ours/theirs pair touches intersecting base ranges. Same-start edits are
 * ambiguous (two insertions at one point have no defined order) and refuse;
 * an insertion at the boundary AFTER a replace is fine.
 */
export function weaveDisjoint(
  base: string[],
  ours: BaseEdit[],
  theirs: BaseEdit[],
): string[] | undefined {
  for (const o of ours) {
    for (const t of theirs) {
      // Same anchor line: insert-vs-insert and insert-before-edit have no
      // defined order. The strict intersection test below also rejects a
      // pure insertion strictly inside the other side's replaced range.
      if (o.start === t.start) return undefined;
      if (o.start < t.end && t.start < o.end) return undefined;
    }
  }
  const edits = [...ours, ...theirs].sort((a, b) => a.start - b.start);
  const out: string[] = [];
  let cursor = 0;
  for (const e of edits) {
    out.push(...base.slice(cursor, e.start), ...e.lines);
    cursor = Math.max(cursor, e.end);
  }
  out.push(...base.slice(cursor));
  return out;
}
