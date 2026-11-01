/**
 * Lane color assignment (P4-T2): stable per lane-birth, 12-color palette.
 * Indices only — the render side maps them to theme-aware colors.
 */
export const PALETTE_SIZE = 12;

export class ColorAllocator {
  private next = 0;

  allocate(): number {
    const idx = this.next % PALETTE_SIZE;
    this.next++;
    return idx;
  }

  reset(): void {
    this.next = 0;
  }
}

/** Theme-aware palette (webview side): hues chosen for dark+light legibility. */
export const GRAPH_HUES = [210, 30, 120, 275, 0, 170, 55, 320, 90, 240, 15, 145];

/**
 * Each repository's palette slot, the colour that marks it wherever GitTree
 * tells repositories apart: the log's `Roots` and the Branches panel. One rule,
 * so a repository is the same colour in both: roots in path order, the slots
 * handed out in turn.
 */
export function rootColorIndices(roots: readonly string[]): Map<string, number> {
  const sorted = [...roots].sort((a, b) => a.localeCompare(b));
  return new Map(sorted.map((root, idx) => [root, idx % PALETTE_SIZE]));
}
