/**
 * useElementSize (P11-T1): VirtualList needs a pixel height, but a tool window
 * pane is a flex box that resizes with the sidebar and the splitters. This
 * observes the host element so the tree fills its pane instead of guessing.
 *
 * A **callback ref**, not an object ref, and the effect keys on the element it
 * received. An object ref is captured once on mount, so when the measured
 * element is replaced — the commit tree moving in and out of the preview
 * splitter is exactly that — the observer stays bound to the detached node,
 * whose `clientHeight` is 0, and the list silently renders into nothing.
 */
import { useEffect, useState } from 'react';

export interface Size {
  readonly width: number;
  readonly height: number;
}

export type SizeRef<T extends HTMLElement> = (node: T | null) => void;

export function useElementSize<T extends HTMLElement>(): [SizeRef<T>, Size] {
  // useState, so a new element triggers a render and re-runs the effect;
  // React keeps the setter identity stable, so this does not thrash the ref.
  const [element, setElement] = useState<T | null>(null);
  const [size, setSize] = useState<Size>({ width: 0, height: 0 });

  useEffect(() => {
    if (!element) return undefined;
    const measure = (): void => {
      setSize((prev) =>
        prev.width === element.clientWidth && prev.height === element.clientHeight
          ? prev
          : { width: element.clientWidth, height: element.clientHeight },
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
    ro.observe(element);
    return () => ro.disconnect();
  }, [element]);

  return [setElement, size];
}
