/**
 * Line diff (P3-T4/T7 dependency): computes VS Code-shaped LineChange[]
 * between two texts. Myers O(ND) on line hashes with common prefix/suffix
 * trimming — plenty for commit-check range math and hunk CodeLenses. Pure
 * and vscode-free.
 */
import type { LineChange } from './patchBuilder';

function splitLines(text: string): { lines: string[]; hadFinalNewline: boolean } {
  if (text.length === 0) return { lines: [], hadFinalNewline: true };
  const hadFinalNewline = text.endsWith('\n');
  const lines = text.split('\n');
  if (hadFinalNewline) lines.pop();
  return { lines, hadFinalNewline };
}

/**
 * Edit blocks [aStart, aEnd, bStart, bEnd) (0-based, end-exclusive) over the
 * trimmed middle, via DP LCS — simple and provably correct. Middles larger
 * than the cap collapse into one replace block (coarser hunks, still an
 * exact diff — the fuzz round-trip property holds either way).
 */
const LCS_CELL_CAP = 4_000_000;

/** Exported for P6-T5's base-anchored diff3 weave (same exact-diff contract). */
export function lcsBlocks(a: string[], b: string[]): Array<[number, number, number, number]> {
  const n = a.length;
  const m = b.length;
  if (n === 0 && m === 0) return [];
  if (n === 0) return [[0, 0, 0, m]];
  if (m === 0) return [[0, n, 0, 0]];
  if (n * m > LCS_CELL_CAP) return [[0, n, 0, m]];

  // dp[i][j] = LCS length of a[i:], b[j:], flattened row-major (n+1)×(m+1).
  const width = m + 1;
  const dp = new Int32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    const row = i * width;
    const below = (i + 1) * width;
    for (let j = m - 1; j >= 0; j--) {
      dp[row + j] =
        a[i] === b[j]
          ? (dp[below + j + 1] as number) + 1
          : Math.max(dp[below + j] as number, dp[row + j + 1] as number);
    }
  }

  // Walk the table, emitting maximal non-matching blocks.
  const blocks: Array<[number, number, number, number]> = [];
  let i = 0;
  let j = 0;
  let blockAStart = -1;
  let blockBStart = -1;
  const flush = (aEnd: number, bEnd: number): void => {
    if (blockAStart !== -1) {
      blocks.push([blockAStart, aEnd, blockBStart, bEnd]);
      blockAStart = -1;
      blockBStart = -1;
    }
  };
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      flush(i, j);
      i++;
      j++;
    } else {
      if (blockAStart === -1) {
        blockAStart = i;
        blockBStart = j;
      }
      if ((dp[(i + 1) * width + j] as number) >= (dp[i * width + j + 1] as number)) {
        i++; // delete a[i]
      } else {
        j++; // insert b[j]
      }
    }
  }
  if (i < n || j < m) {
    if (blockAStart === -1) {
      blockAStart = i;
      blockBStart = j;
    }
    i = n;
    j = m;
  }
  flush(i, j);
  return blocks;
}

/**
 * Trim common prefix/suffix for speed and cleaner blocks. When the final
 * newline state differs, the last lines are NOT equal at the byte level —
 * keep them inside the diff so the change list carries the EOL fix.
 */
function trimmedMiddle(
  a: readonly string[],
  b: readonly string[],
  eolMismatch: boolean,
): { start: number; endA: number; endB: number } {
  let start = 0;
  const maxStart = eolMismatch ? Math.min(a.length, b.length) - 1 : Math.min(a.length, b.length);
  while (start < maxStart && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  if (!eolMismatch) {
    while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
      endA--;
      endB--;
    }
  }
  return { start, endA, endB };
}

/**
 * True when `computeLineChanges` would answer these texts with one coarse block
 * from the first change to the last: still an exact diff, but it no longer says
 * where the changes are.
 */
export function exceedsLineDiffCap(originalText: string, modifiedText: string): boolean {
  const aSplit = splitLines(originalText);
  const bSplit = splitLines(modifiedText);
  const eolMismatch = aSplit.hadFinalNewline !== bSplit.hadFinalNewline;
  const { start, endA, endB } = trimmedMiddle(aSplit.lines, bSplit.lines, eolMismatch);
  return (endA - start) * (endB - start) > LCS_CELL_CAP;
}

/**
 * Computes LineChange[] (1-based; end 0 marks pure insert/delete — the same
 * convention the dirty-diff widget uses, so PatchBuilder consumes either).
 */
export function computeLineChanges(originalText: string, modifiedText: string): LineChange[] {
  const aSplit = splitLines(originalText);
  const bSplit = splitLines(modifiedText);
  const a = aSplit.lines;
  const b = bSplit.lines;

  const eolMismatch = aSplit.hadFinalNewline !== bSplit.hadFinalNewline;
  const { start, endA, endB } = trimmedMiddle(a, b, eolMismatch);

  let blocks = lcsBlocks(a.slice(start, endA), b.slice(start, endB));
  if (eolMismatch) {
    // Force the last line of both sides into a change block so applying the
    // change transfers the modified side's final-newline state.
    const lastA = a.length - start; // local coords, end-exclusive target
    const lastB = b.length - start;
    const touchesEnd = blocks.some(([, aE, , bE]) => aE >= lastA && bE >= lastB);
    if (!touchesEnd && lastA > 0 && lastB > 0) {
      const merged = blocks.filter(([, aE, , bE]) => aE < lastA || bE < lastB);
      merged.push([lastA - 1, lastA, lastB - 1, lastB]);
      blocks = merged;
    } else if (lastA === 0 || lastB === 0) {
      blocks = [[0, lastA, 0, lastB]];
    }
  }
  const changes: LineChange[] = [];
  for (const [aS, aE, bS, bE] of blocks) {
    const origStart = start + aS;
    const origEnd = start + aE;
    const modStart = start + bS;
    const modEnd = start + bE;
    if (origStart === origEnd) {
      // pure insertion after original line origStart (0 = top)
      changes.push({
        originalStartLineNumber: origStart,
        originalEndLineNumber: 0,
        modifiedStartLineNumber: modStart + 1,
        modifiedEndLineNumber: modEnd,
      });
    } else if (modStart === modEnd) {
      // pure deletion after modified line modStart
      changes.push({
        originalStartLineNumber: origStart + 1,
        originalEndLineNumber: origEnd,
        modifiedStartLineNumber: modStart,
        modifiedEndLineNumber: 0,
      });
    } else {
      changes.push({
        originalStartLineNumber: origStart + 1,
        originalEndLineNumber: origEnd,
        modifiedStartLineNumber: modStart + 1,
        modifiedEndLineNumber: modEnd,
      });
    }
  }
  return changes;
}

/** 0-based [startLine, endLineInclusive] ranges of modified-side changed lines. */
export function modifiedRanges(changes: readonly LineChange[]): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  for (const c of changes) {
    if (c.modifiedEndLineNumber === 0) continue; // deletion: nothing on modified side
    ranges.push([c.modifiedStartLineNumber - 1, c.modifiedEndLineNumber - 1]);
  }
  // merge adjacent
  ranges.sort((x, y) => x[0] - y[0]);
  const merged: Array<[number, number]> = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1] + 1) last[1] = Math.max(last[1], r[1]);
    else merged.push(r);
  }
  return merged;
}

/** Added lines (1-based modified line numbers) — the TODO check's input. */
export function addedLineNumbers(changes: readonly LineChange[]): number[] {
  const out: number[] = [];
  for (const c of changes) {
    if (c.modifiedEndLineNumber === 0) continue;
    for (let l = c.modifiedStartLineNumber; l <= c.modifiedEndLineNumber; l++) out.push(l);
  }
  return out;
}
