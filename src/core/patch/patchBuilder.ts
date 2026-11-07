/**
 * PatchBuilder (P1-T3, shared with P3-T4 hunk staging and P7-T5 partial
 * unshelve): pure text→patch machinery around VS Code's dirty-diff
 * LineChange shape. No vscode imports — exhaustively unit-tested.
 *
 * LineChange semantics (1-based): `originalEndLineNumber === 0` marks an
 * insertion (originalStartLineNumber = line AFTER which content is added);
 * `modifiedEndLineNumber === 0` marks a deletion (same convention).
 */

export interface LineChange {
  originalStartLineNumber: number;
  originalEndLineNumber: number;
  modifiedStartLineNumber: number;
  modifiedEndLineNumber: number;
}

interface SplitText {
  lines: string[];
  hadFinalNewline: boolean;
}

/** Split on LF only — CR stays attached so CRLF content round-trips byte-exact. */
function split(text: string): SplitText {
  if (text.length === 0) return { lines: [], hadFinalNewline: true };
  const hadFinalNewline = text.endsWith('\n');
  const lines = text.split('\n');
  if (hadFinalNewline) lines.pop();
  return { lines, hadFinalNewline };
}

function join(lines: string[], finalNewline: boolean): string {
  if (lines.length === 0) return '';
  return lines.join('\n') + (finalNewline ? '\n' : '');
}

/**
 * Returns `original` with only the given changes applied — the workhorse for
 * hunk rollback (apply the complement) and stage-selected verification.
 * Changes must be non-overlapping and sorted by original position (the
 * dirty-diff widget guarantees both).
 */
export function applyLineChanges(original: string, modified: string, changes: readonly LineChange[]): string {
  const orig = split(original);
  const mod = split(modified);
  const out: string[] = [];
  let origLine = 1; // next original line to copy (1-based)
  let takeFinalNewlineFromModified = false;

  for (const c of changes) {
    const isInsertion = c.originalEndLineNumber === 0;
    const copyUntil = isInsertion ? c.originalStartLineNumber : c.originalStartLineNumber - 1;
    while (origLine <= copyUntil) {
      out.push(orig.lines[origLine - 1] as string);
      origLine++;
    }
    if (!isInsertion) {
      origLine = c.originalEndLineNumber + 1; // skip replaced/deleted original lines
    }
    if (c.modifiedEndLineNumber !== 0) {
      for (let m = c.modifiedStartLineNumber; m <= c.modifiedEndLineNumber; m++) {
        out.push(mod.lines[m - 1] as string);
      }
      if (c.modifiedEndLineNumber === mod.lines.length) {
        takeFinalNewlineFromModified = true;
      }
    }
    if (!isInsertion && c.originalEndLineNumber === orig.lines.length) {
      // The change consumed the original's last line — the result's final
      // newline is governed by the modified side.
      takeFinalNewlineFromModified = true;
    }
  }
  while (origLine <= orig.lines.length) {
    out.push(orig.lines[origLine - 1] as string);
    origLine++;
  }

  const finalNewline = takeFinalNewlineFromModified ? mod.hadFinalNewline : orig.hadFinalNewline;
  return join(out, out.length === 0 ? true : finalNewline);
}

export interface BuildPatchOptions {
  /** a/ and b/ path (repo-relative, forward slashes). */
  relPath: string;
  originalText: string;
  modifiedText: string;
  changes: readonly LineChange[];
}

/**
 * Minimal zero-context unified diff for `git apply --cached --unidiff-zero -`,
 * applied **forwards** to `originalText`. One @@ hunk per change, "\ No newline
 * at end of file" markers included. `changes` may be any subset of a diff's
 * changes, in order.
 *
 * The new-side line numbers are where each hunk lands in the result of
 * applying exactly these changes — not where it sits in `modifiedText`. git
 * places a zero-context hunk at its new-side start (apply.c: `pos = newpos -
 * 1`), and a pure insertion has no preimage to search for, so it lands there
 * unchecked. Numbered against the whole of `modifiedText`, every change left
 * out above it would push it down by that change's net line count: the bug
 * that put a staged line after the closing brace it was typed above.
 *
 * To take changes back out of a text, invert them (`invertChanges`) and apply
 * the patch forwards to the other side; `git apply --reverse` would read the
 * old-side numbers, which only describe the whole diff.
 */
export function buildPatch({ relPath, originalText, modifiedText, changes }: BuildPatchOptions): string {
  const orig = split(originalText);
  const mod = split(modifiedText);
  const p = relPath.replace(/\\/g, '/');
  const out: string[] = [`diff --git a/${p} b/${p}`, `--- a/${p}`, `+++ b/${p}`];
  const NO_NEWLINE = '\\ No newline at end of file';
  /** Net lines added by the hunks already written. */
  let delta = 0;

  for (const c of changes) {
    const isInsertion = c.originalEndLineNumber === 0;
    const isDeletion = c.modifiedEndLineNumber === 0;
    const origStart = c.originalStartLineNumber;
    const origCount = isInsertion ? 0 : c.originalEndLineNumber - c.originalStartLineNumber + 1;
    const modCount = isDeletion ? 0 : c.modifiedEndLineNumber - c.modifiedStartLineNumber + 1;
    // The same conventions `git diff -U0` writes: an insertion's new side
    // starts on its first added line, which follows original line `origStart`;
    // a deletion's names the line before the gap it leaves.
    const modStart = isInsertion
      ? origStart + delta + 1
      : isDeletion
        ? origStart - 1 + delta
        : origStart + delta;
    delta += modCount - origCount;

    out.push(`@@ -${origStart},${origCount} +${modStart},${modCount} @@`);
    if (!isInsertion) {
      for (let i = c.originalStartLineNumber; i <= c.originalEndLineNumber; i++) {
        out.push('-' + (orig.lines[i - 1] ?? ''));
        if (i === orig.lines.length && !orig.hadFinalNewline) out.push(NO_NEWLINE);
      }
    }
    if (!isDeletion) {
      for (let i = c.modifiedStartLineNumber; i <= c.modifiedEndLineNumber; i++) {
        out.push('+' + (mod.lines[i - 1] ?? ''));
        if (i === mod.lines.length && !mod.hadFinalNewline) out.push(NO_NEWLINE);
      }
    }
  }
  return out.join('\n') + '\n';
}

/** Convenience: the subset of `changes` complementing `indices` (rollback keeps the rest). */
export function complementChanges(changes: readonly LineChange[], indices: readonly number[]): LineChange[] {
  const drop = new Set(indices);
  return changes.filter((_, i) => !drop.has(i));
}

/**
 * The same changes seen from the other side: original → modified becomes
 * modified → original. An insertion turns into a deletion at the same anchor
 * and back, and the order stays sorted. Unstaging builds its patch this way.
 */
export function invertChanges(changes: readonly LineChange[]): LineChange[] {
  return changes.map((c) => ({
    originalStartLineNumber: c.modifiedStartLineNumber,
    originalEndLineNumber: c.modifiedEndLineNumber,
    modifiedStartLineNumber: c.originalStartLineNumber,
    modifiedEndLineNumber: c.originalEndLineNumber,
  }));
}

const isDeletionChange = (c: LineChange): boolean => c.modifiedEndLineNumber === 0;

/**
 * The changes of `fresh` that stand for `picked`.
 *
 * `picked` is a change the user acted on: its bar may have been measured a
 * moment ago, or against HEAD while the staging target is the index. Both
 * diffs share their modified side — the working tree — so they are matched
 * there: the identical change if there is one, else every fresh change on the
 * picked lines (a deletion counts when its gap lies between two of them), and
 * for a picked deletion the fresh deletion at the same gap. Changes are always
 * separated by an unchanged line, so nothing next to the picked lines can be
 * swept in.
 */
export function correspondingChanges(fresh: readonly LineChange[], picked: LineChange): LineChange[] {
  const exact = fresh.find(
    (c) =>
      c.modifiedStartLineNumber === picked.modifiedStartLineNumber &&
      c.modifiedEndLineNumber === picked.modifiedEndLineNumber &&
      (c.originalEndLineNumber === 0) === (picked.originalEndLineNumber === 0),
  );
  if (exact) return [exact];
  if (isDeletionChange(picked)) {
    return fresh.filter(
      (c) => isDeletionChange(c) && c.modifiedStartLineNumber === picked.modifiedStartLineNumber,
    );
  }
  const start = picked.modifiedStartLineNumber;
  const end = picked.modifiedEndLineNumber;
  return fresh.filter((c) =>
    isDeletionChange(c)
      ? c.modifiedStartLineNumber >= start && c.modifiedStartLineNumber < end
      : c.modifiedStartLineNumber <= end && c.modifiedEndLineNumber >= start,
  );
}
