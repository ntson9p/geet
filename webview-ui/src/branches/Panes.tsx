/**
 * The Repositories panel's panes (new-way-6): a header that folds its pane, as
 * the headers of VS Code's own views do, and the divider between the two
 * panes that the pointer drags. What they are sized to is `paneLayout.ts`'s;
 * `App.tsx` owns the state.
 */
import {
  forwardRef,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import type { PaneId } from './paneLayout';
import { Codicon } from './Rows';

export interface PaneHeaderProps {
  readonly pane: PaneId;
  /** Shown in capitals, as VS Code shows a view's. */
  readonly title: string;
  readonly open: boolean;
  readonly count?: number;
  /** What a screen reader hears for the whole header. */
  readonly ariaLabel: string;
  /** The id of the list the header folds. */
  readonly controls: string;
  /** Between the title and the actions: the REPOSITORIES pane's selected repositories. */
  readonly label?: ReactNode;
  /** At the end of the header; a press on one never folds the pane. */
  readonly actions?: ReactNode;
  /**
   * The divider between the panes lies along this header's top edge, so its top
   * border is the line that marks it (`gittree.sectionBorder`).
   */
  readonly sashAbove?: boolean;
  readonly onToggle: () => void;
  readonly onKeyDown: (e: ReactKeyboardEvent<HTMLDivElement>) => void;
}

/**
 * A pane's header: a click, Enter or Space folds or opens it; Left shuts it and
 * Right opens it, as on VS Code's. It is one stop of the Tab order, between
 * the list above and its own.
 */
export const PaneHeader = forwardRef<HTMLDivElement, PaneHeaderProps>(function PaneHeader(
  { pane, title, open, count, ariaLabel, controls, label, actions, sashAbove, onToggle, onKeyDown },
  ref,
) {
  return (
    <div
      ref={ref}
      className={`gtp-pane-header${open ? ' gtp-expanded' : ''}${sashAbove === true ? ' gtp-sash-above' : ''}`}
      data-pane={pane}
      role="button"
      tabIndex={0}
      aria-expanded={open}
      aria-controls={controls}
      aria-label={ariaLabel}
      onClick={(e) => {
        if (e.target instanceof Element && e.target.closest('button, a') !== null) return;
        onToggle();
      }}
      onKeyDown={onKeyDown}
    >
      <Codicon name={open ? 'chevron-down' : 'chevron-right'} className="gtp-pane-twisty" />
      <span className="gtp-pane-title">{title}</span>
      {count !== undefined ? <span className="gtp-count">{count}</span> : null}
      {label}
      {actions !== undefined ? <span className="gtp-pane-actions">{actions}</span> : null}
    </div>
  );
});

/** The divider's height, centred on the line between the panes, as VS Code's sash is. */
export const SASH = 4;

/**
 * The divider between the panes; the header under it draws the line that marks
 * it (`PaneHeader`'s `sashAbove`). Dragged, it moves the line between them; a
 * double-click gives the REPOSITORIES pane back its automatic size. A press
 * that never moves changes nothing, so a click is not a resize.
 */
export function Sash({
  top,
  onStart,
  onMove,
  onEnd,
  onReset,
}: {
  /** Where the line between the panes is, from the top of the panes. */
  top: number;
  onStart: () => void;
  /** How far the pointer has moved since the press, in pixels. */
  onMove: (delta: number) => void;
  /** `moved`: the pointer moved while pressed, so there is a new size to keep. */
  onEnd: (moved: boolean) => void;
  onReset: () => void;
}) {
  const from = useRef<number | undefined>(undefined);
  const moved = useRef(false);
  const [active, setActive] = useState(false);
  const finish = (): void => {
    if (from.current === undefined) return;
    from.current = undefined;
    setActive(false);
    onEnd(moved.current);
  };
  return (
    <div
      className={`gtp-sash${active ? ' gtp-sash-active' : ''}`}
      style={{ top: top - SASH / 2, height: SASH }}
      aria-hidden="true"
      onPointerDown={(e: ReactPointerEvent<HTMLDivElement>) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        from.current = e.clientY;
        moved.current = false;
        setActive(true);
        onStart();
      }}
      onPointerMove={(e) => {
        if (from.current === undefined) return;
        const delta = e.clientY - from.current;
        if (delta !== 0) moved.current = true;
        if (moved.current) onMove(delta);
      }}
      onPointerUp={finish}
      onPointerCancel={finish}
      onLostPointerCapture={finish}
      onDoubleClick={onReset}
    />
  );
}
