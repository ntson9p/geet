/**
 * diffRows (P11-T1): turns `(originalText, modifiedText, LineChange[])` into
 * aligned side-by-side display rows for InlineDiff. Pure and DOM-free so the
 * alignment math is unit-tested rather than eyeballed.
 *
 * The walk deliberately mirrors `core/patch/patchBuilder.applyLineChanges`, so
 * what the diff shows and what a partial commit/shelve actually writes cannot
 * drift apart. LineChange semantics (1-based): `originalEndLineNumber === 0`
 * is an insertion after `originalStartLineNumber`; `modifiedEndLineNumber === 0`
 * is a deletion.
 */
import type { LineChangeDto } from '../../../src/shared/protocol';

export interface DiffRowSide {
  readonly lineNumber: number;
  readonly text: string;
}

export interface DiffRow {
  /** Index into the change list, or -1 for an unchanged context row. */
  readonly changeIndex: number;
  readonly left?: DiffRowSide;
  readonly right?: DiffRowSide;
  /** First row of its change — where the include checkbox anchors. */
  readonly first: boolean;
}

function splitLines(text: string): string[] {
  if (text.length === 0) return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines;
}

export function buildDiffRows(
  originalText: string,
  modifiedText: string,
  changes: readonly LineChangeDto[],
): DiffRow[] {
  const orig = splitLines(originalText);
  const mod = splitLines(modifiedText);
  const rows: DiffRow[] = [];
  let origLine = 1;
  let modLine = 1;

  const context = (until: number): void => {
    while (origLine <= until && origLine <= orig.length) {
      rows.push({
        changeIndex: -1,
        left: { lineNumber: origLine, text: orig[origLine - 1] as string },
        right: { lineNumber: modLine, text: mod[modLine - 1] ?? (orig[origLine - 1] as string) },
        first: false,
      });
      origLine++;
      modLine++;
    }
  };

  for (let i = 0; i < changes.length; i++) {
    const c = changes[i] as LineChangeDto;
    const isInsertion = c.originalEndLineNumber === 0;
    const isDeletion = c.modifiedEndLineNumber === 0;
    context(isInsertion ? c.originalStartLineNumber : c.originalStartLineNumber - 1);

    const removed: DiffRowSide[] = [];
    if (!isInsertion) {
      for (let n = c.originalStartLineNumber; n <= c.originalEndLineNumber; n++) {
        removed.push({ lineNumber: n, text: orig[n - 1] ?? '' });
      }
    }
    const added: DiffRowSide[] = [];
    if (!isDeletion) {
      for (let n = c.modifiedStartLineNumber; n <= c.modifiedEndLineNumber; n++) {
        added.push({ lineNumber: n, text: mod[n - 1] ?? '' });
      }
    }

    const span = Math.max(removed.length, added.length);
    for (let k = 0; k < span; k++) {
      rows.push({
        changeIndex: i,
        left: removed[k],
        right: added[k],
        first: k === 0,
      });
    }

    if (!isInsertion) origLine = c.originalEndLineNumber + 1;
    if (!isDeletion) modLine = c.modifiedEndLineNumber + 1;
  }

  context(orig.length);
  return rows;
}

export interface UnifiedRow {
  /** Index into the change list, or -1 for an unchanged context row. */
  readonly changeIndex: number;
  readonly kind: 'context' | 'removed' | 'added';
  readonly oldLine?: number;
  readonly newLine?: number;
  readonly text: string;
  /** First row of its change — where the include checkbox anchors. */
  readonly first: boolean;
}

/**
 * The same rows in one column — each change's removed lines, then its added
 * ones — as IntelliJ's unified viewer shows them, for a pane too narrow for
 * two sides: a 350px sidebar cut both to `import {...` (POST-QA).
 */
export function unifiedRows(rows: readonly DiffRow[]): UnifiedRow[] {
  const out: UnifiedRow[] = [];
  let i = 0;
  while (i < rows.length) {
    const row = rows[i] as DiffRow;
    if (row.changeIndex < 0) {
      out.push({
        changeIndex: -1,
        kind: 'context',
        ...(row.left !== undefined ? { oldLine: row.left.lineNumber } : {}),
        ...(row.right !== undefined ? { newLine: row.right.lineNumber } : {}),
        text: row.right?.text ?? row.left?.text ?? '',
        first: false,
      });
      i++;
      continue;
    }
    // A change's rows are contiguous: take them all, removed sides first.
    let end = i;
    while (end < rows.length && (rows[end] as DiffRow).changeIndex === row.changeIndex) end++;
    const span = rows.slice(i, end);
    let first = true;
    for (const r of span) {
      if (r.left === undefined) continue;
      out.push({ changeIndex: row.changeIndex, kind: 'removed', oldLine: r.left.lineNumber, text: r.left.text, first });
      first = false;
    }
    for (const r of span) {
      if (r.right === undefined) continue;
      out.push({ changeIndex: row.changeIndex, kind: 'added', newLine: r.right.lineNumber, text: r.right.text, first });
      first = false;
    }
    i = end;
  }
  return out;
}

/** `N differences, M included` — the counter IntelliJ shows in the diff header. */
export function includedLabel(total: number, included: number, showIncluded: boolean): string {
  const diffs = `${total} ${total === 1 ? 'difference' : 'differences'}`;
  return showIncluded ? `${diffs}, ${included} included` : diffs;
}
