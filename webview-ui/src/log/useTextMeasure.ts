/**
 * Text widths for laying out the commit list's columns and ref labels before
 * they are drawn — IntelliJ's `FontMetrics.stringWidth`, from a canvas in the
 * fonts the rows use. Widths are cached per font: the same author names,
 * dates and branch names are measured on every repaint.
 */
import { useMemo } from 'react';

export interface TextMeasure {
  /** The row's own font: messages and author names. */
  text: (s: string) => number;
  /** The row font in bold: what IntelliJ sizes its fixed columns by, for slack. */
  bold: (s: string) => number;
  /** The ref labels' font, one pixel smaller (`LabelPainter.getReferenceFont`). */
  label: (s: string) => number;
}

function measurer(ctx: CanvasRenderingContext2D | null, font: string): (s: string) => number {
  const cache = new Map<string, number>();
  return (s: string): number => {
    if (s.length === 0) return 0;
    let width = cache.get(s);
    if (width === undefined) {
      if (ctx === null) {
        // No canvas (a test page without one): a plain average, never zero.
        width = s.length * 7;
      } else {
        ctx.font = font;
        width = ctx.measureText(s).width;
      }
      cache.set(s, width);
    }
    return width;
  };
}

/**
 * The rows inherit the page's font (VS Code's `--vscode-font-family` and
 * `--vscode-font-size` on `body`), so that is what is read. `key` re-reads it —
 * pass something that changes with the theme.
 */
export function useTextMeasure(key: unknown): TextMeasure {
  return useMemo(() => {
    const style = getComputedStyle(document.body);
    const family = style.fontFamily || 'sans-serif';
    const size = Number.parseFloat(style.fontSize) || 13;
    const ctx = document.createElement('canvas').getContext('2d');
    return {
      text: measurer(ctx, `${size}px ${family}`),
      bold: measurer(ctx, `bold ${size}px ${family}`),
      label: measurer(ctx, `${size - 1}px ${family}`),
    };
    // Rebuilt when `key` (the theme) changes: fonts and sizes follow it.
  }, [key]);
}
