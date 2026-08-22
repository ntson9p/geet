/**
 * useElementSize (P11-T1): VirtualList needs a pixel height, but a tool window
 * pane is a flex box that resizes with the sidebar and the splitters. This
 * observes the host element so the tree fills its pane instead of guessing.
 */
import { useEffect, useRef, useState, type MutableRefObject } from 'react';

export interface Size {
  readonly width: number;
  readonly height: number;
}

export function useElementSize<T extends HTMLElement>(): [MutableRefObject<T | null>, Size] {
  const ref = useRef<T | null>(null);
  const [size, setSize] = useState<Size>({ width: 0, height: 0 });

  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const measure = (): void => {
      setSize((prev) =>
        prev.width === el.clientWidth && prev.height === el.clientHeight
          ? prev
          : { width: el.clientWidth, height: el.clientHeight },
      );
    };
    measure();
    // ResizeObserver exists in every VS Code webview; guard anyway so the
    // Playwright harness and older hosts fall back to a window listener.
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure);
      return () => window.removeEventListener('resize', measure);
    }
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return [ref, size];
}
