/**
 * SplitPane (P11-T1): resizable two-pane splitter with a keyboard-operable
 * separator. P12 nests these to build the four-pane Git tool window; P11 uses
 * one for the commit window's tree/message split.
 *
 * The ratio is owned by the caller so it can be persisted through
 * `getState`/`setState` — losing pane sizes on reload is one of the things
 * that makes a webview feel unlike a tool window.
 */
import { useCallback, useRef, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';

export interface SplitPaneProps {
  direction: 'horizontal' | 'vertical';
  first: ReactNode;
  second: ReactNode;
  /** Fraction of the container given to `first`, 0..1. */
  ratio: number;
  onRatioChange: (ratio: number) => void;
  /** Minimum px for each side; the drag clamps to these. */
  minFirst?: number;
  minSecond?: number;
  /** Double-clicking the separator returns here. Defaults to the initial ratio. */
  defaultRatio?: number;
  ariaLabel: string;
  className?: string;
}

const KEY_STEP = 0.02;

export function SplitPane({
  direction,
  first,
  second,
  ratio,
  onRatioChange,
  minFirst = 80,
  minSecond = 80,
  defaultRatio,
  ariaLabel,
  className,
}: SplitPaneProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const initialRatio = useRef<number>(defaultRatio ?? ratio);
  const horizontal = direction === 'horizontal';

  const clampToPixels = useCallback(
    (next: number): number => {
      const host = hostRef.current;
      if (!host) return Math.min(1, Math.max(0, next));
      const total = horizontal ? host.clientWidth : host.clientHeight;
      if (total <= 0) return next;
      const lo = minFirst / total;
      const hi = 1 - minSecond / total;
      if (lo > hi) return 0.5;
      return Math.min(hi, Math.max(lo, next));
    },
    [horizontal, minFirst, minSecond],
  );

  const onPointerDown = (e: PointerEvent<HTMLDivElement>): void => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: PointerEvent<HTMLDivElement>): void => {
    if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
    const host = hostRef.current;
    if (!host) return;
    const box = host.getBoundingClientRect();
    const total = horizontal ? box.width : box.height;
    if (total <= 0) return;
    const offset = horizontal ? e.clientX - box.left : e.clientY - box.top;
    onRatioChange(clampToPixels(offset / total));
  };

  const onPointerUp = (e: PointerEvent<HTMLDivElement>): void => {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    const back = horizontal ? 'ArrowLeft' : 'ArrowUp';
    const fwd = horizontal ? 'ArrowRight' : 'ArrowDown';
    switch (e.key) {
      case back:
        onRatioChange(clampToPixels(ratio - KEY_STEP));
        break;
      case fwd:
        onRatioChange(clampToPixels(ratio + KEY_STEP));
        break;
      case 'Home':
        onRatioChange(clampToPixels(0));
        break;
      case 'End':
        onRatioChange(clampToPixels(1));
        break;
      case 'Enter':
      case ' ':
        onRatioChange(clampToPixels(initialRatio.current));
        break;
      default:
        return;
    }
    e.preventDefault();
  };

  const firstPct = `${(ratio * 100).toFixed(3)}%`;
  return (
    <div
      ref={hostRef}
      className={`gt-split gt-split-${direction}${className !== undefined ? ` ${className}` : ''}`}
    >
      <div className="gt-split-pane" style={horizontal ? { width: firstPct } : { height: firstPct }}>
        {first}
      </div>
      <div
        role="separator"
        aria-label={ariaLabel}
        aria-orientation={horizontal ? 'vertical' : 'horizontal'}
        aria-valuenow={Math.round(ratio * 100)}
        aria-valuemin={0}
        aria-valuemax={100}
        tabIndex={0}
        className="gt-split-sash"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDoubleClick={() => onRatioChange(clampToPixels(initialRatio.current))}
        onKeyDown={onKeyDown}
      />
      <div className="gt-split-pane gt-split-rest">{second}</div>
    </div>
  );
}
