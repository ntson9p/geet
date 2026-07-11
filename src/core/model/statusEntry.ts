/**
 * Status-entry helpers layered over the porcelain-v2 parser DTO. Views and
 * services classify entries through these predicates instead of poking at
 * x/y chars.
 */
export type { StatusEntry, StatusEntryKind, StatusHeader, StatusResult, UnmergedStages } from '../git/parsers/statusV2';
import type { StatusEntry } from '../git/parsers/statusV2';

/** Anything staged in the index (including staged half of partially staged files). */
export function isStaged(e: StatusEntry): boolean {
  return e.kind !== 'untracked' && e.kind !== 'ignored' && e.kind !== 'unmerged' && e.x !== '.';
}

/** Anything with worktree-side changes (unstaged half). */
export function isUnstaged(e: StatusEntry): boolean {
  return e.kind !== 'untracked' && e.kind !== 'ignored' && e.kind !== 'unmerged' && e.y !== '.';
}

export function isUntracked(e: StatusEntry): boolean {
  return e.kind === 'untracked';
}

export function isConflicted(e: StatusEntry): boolean {
  return e.kind === 'unmerged';
}

/** Working-tree "dirty" test used by checkout guards: anything but ignored. */
export function isDirty(e: StatusEntry): boolean {
  return e.kind !== 'ignored';
}

/**
 * Two-char porcelain code for UI badges, e.g. "M.", ".M", "R.", "??", "UU".
 */
export function shortCode(e: StatusEntry): string {
  if (e.kind === 'untracked') return '??';
  if (e.kind === 'ignored') return '!!';
  return `${e.x}${e.y}`;
}

/**
 * Cheap structural equality for change detection (section diffing) — compares
 * identity-bearing fields, not modes/shas.
 */
export function statusEntryEquals(a: StatusEntry, b: StatusEntry): boolean {
  return (
    a.kind === b.kind &&
    a.path === b.path &&
    a.origPath === b.origPath &&
    a.x === b.x &&
    a.y === b.y &&
    a.shaIndex === b.shaIndex &&
    a.shaHead === b.shaHead
  );
}
