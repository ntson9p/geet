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
 * Minimal zero-context unified diff for `git apply --cached --unidiff-zero -`.
 * One @@ hunk per change, "\ No newline at end of file" markers included.
 */
export function buildPatch({ relPath, originalText, modifiedText, changes }: BuildPatchOptions): string {
  const orig = split(originalText);
  const mod = split(modifiedText);
  const p = relPath.replace(/\\/g, '/');
  const out: string[] = [`diff --git a/${p} b/${p}`, `--- a/${p}`, `+++ b/${p}`];
  const NO_NEWLINE = '\\ No newline at end of file';

  for (const c of changes) {
    const isInsertion = c.originalEndLineNumber === 0;
    const isDeletion = c.modifiedEndLineNumber === 0;
    const origStart = isInsertion ? c.originalStartLineNumber : c.originalStartLineNumber;
    const origCount = isInsertion ? 0 : c.originalEndLineNumber - c.originalStartLineNumber + 1;
    const modStart = isDeletion ? c.modifiedStartLineNumber : c.modifiedStartLineNumber;
    const modCount = isDeletion ? 0 : c.modifiedEndLineNumber - c.modifiedStartLineNumber + 1;

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
