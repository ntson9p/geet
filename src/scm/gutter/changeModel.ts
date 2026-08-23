/**
 * Change model for the gutter bars (P14-T3): turns the `LineChange[]` that
 * `core/patch/lineDiff` already produces into editor-space rows plus the
 * navigation the change popup and the diff arrows drive.
 *
 * Pure and vscode-free, so the anchoring rules are unit-tested rather than
 * discovered in the UI. `LineChange` is VS Code-shaped and uses 1-based lines
 * with a 0 sentinel for "this side is empty":
 *   - pure insertion → `originalEndLineNumber === 0`
 *   - pure deletion  → `modifiedEndLineNumber === 0`
 * Editor APIs are 0-based, so every boundary is converted exactly once, here.
 */
import { computeLineChanges } from '../../core/patch/lineDiff';
import type { LineChange } from '../../core/patch/patchBuilder';

export type ChangeKind = 'added' | 'modified' | 'deleted';

export interface Change {
  readonly kind: ChangeKind;
  /** 0-based, inclusive. A deletion has no lines of its own: start === end. */
  readonly startLine: number;
  readonly endLine: number;
  /** The change this row stands for, as the hunk actions want it. */
  readonly source: LineChange;
}

/**
 * A deletion leaves nothing to paint, so the marker anchors to the line that
 * now follows the removed text — which is what IntelliJ shows and where the
 * user looks. `modifiedStartLineNumber` is the 1-based line *after which* the
 * text was removed, so the following line is that same number in 0-based
 * terms; a deletion at the very top of the file anchors to line 0.
 */
function deletionAnchor(c: LineChange): number {
  return Math.max(0, c.modifiedStartLineNumber);
}

export function toChanges(lineChanges: readonly LineChange[]): Change[] {
  const out: Change[] = [];
  for (const c of lineChanges) {
    if (c.modifiedEndLineNumber === 0) {
      const at = deletionAnchor(c);
      out.push({ kind: 'deleted', startLine: at, endLine: at, source: c });
      continue;
    }
    const start = Math.max(0, c.modifiedStartLineNumber - 1);
    const end = Math.max(start, c.modifiedEndLineNumber - 1);
    out.push({
      kind: c.originalEndLineNumber === 0 ? 'added' : 'modified',
      startLine: start,
      endLine: end,
      source: c,
    });
  }
  return out;
}

/** Convenience for callers holding the two texts rather than a diff. */
export function computeChanges(originalText: string, modifiedText: string): Change[] {
  return toChanges(computeLineChanges(originalText, modifiedText));
}

/** The change covering `line`, or undefined. Ranges never overlap. */
export function changeAt(changes: readonly Change[], line: number): Change | undefined {
  return changes.find((c) => line >= c.startLine && line <= c.endLine);
}

/**
 * The next change strictly after `line`. Deliberately NOT wrapping: the
 * cross-file navigation in T7 needs to know it has run off the end so it can
 * offer the next file instead of silently returning to the top — which is the
 * behaviour this whole phase exists to replace.
 */
export function nextChange(changes: readonly Change[], line: number): Change | undefined {
  let best: Change | undefined;
  for (const c of changes) {
    if (c.startLine > line && (best === undefined || c.startLine < best.startLine)) best = c;
  }
  return best;
}

/** The previous change strictly before `line`. Also non-wrapping. */
export function prevChange(changes: readonly Change[], line: number): Change | undefined {
  let best: Change | undefined;
  for (const c of changes) {
    if (c.endLine < line && (best === undefined || c.endLine > best.endLine)) best = c;
  }
  return best;
}

/** The original-side text a change replaced, for the popup's preview. */
export function originalLinesOf(originalText: string, change: Change): string[] {
  const c = change.source;
  if (c.originalEndLineNumber === 0) return []; // pure insertion — nothing was there
  const lines = originalText.split('\n');
  // Drop the trailing empty element a final newline produces, so a whole-file
  // deletion does not report one phantom blank line.
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines.slice(Math.max(0, c.originalStartLineNumber - 1), c.originalEndLineNumber);
}
