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
