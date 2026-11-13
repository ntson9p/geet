/**
 * The divider between the list of changes and the message area (POST-P14ca).
 * Dragging it gives the message box the height it ends at; a double-click, or
 * Enter, gives back the box's first height. The arrows move it a line at a
 * time, the way the pointer would: Up makes the box taller.
 *
 * It only reports a wanted height. The window clamps it (the box keeps a line,
 * the list a few rows) and remembers it.
 */
import { useRef } from 'react';

export interface MessageDividerProps {
  /** The box's height now, px: where a drag or a key starts from. */
  height: number;
  /** A wanted height, px, before clamping. */
  onResize: (next: number) => void;
  /** Back to the box's first height. */
  onReset: () => void;
  /** One arrow press, px: a line of the box. */
  step: number;
}

export function MessageDivider({ height, onResize, onReset, step }: MessageDividerProps) {
  const drag = useRef<{ readonly y: number; readonly height: number } | null>(null);

  return (
    <div
      role="separator"
      aria-label="Resize the commit message"
      aria-orientation="horizontal"
      aria-valuenow={Math.round(height)}
      tabIndex={0}
      title="Drag to resize the commit message. Double-click to reset."
      className="gt-split-sash gt-commit-message-sash"
      data-testid="commit-message-divider"
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = { y: e.clientY, height };
      }}
      onPointerMove={(e) => {
        const start = drag.current;
        if (start === null || !e.currentTarget.hasPointerCapture(e.pointerId)) return;
        // Up the screen is a taller box.
        onResize(start.height + (start.y - e.clientY));
      }}
      onPointerUp={(e) => {
        drag.current = null;
        if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
      }}
      onPointerCancel={() => {
        drag.current = null;
      }}
      onDoubleClick={onReset}
      onKeyDown={(e) => {
        switch (e.key) {
          case 'ArrowUp':
            onResize(height + step);
            break;
          case 'ArrowDown':
            onResize(height - step);
            break;
          case 'Home':
            onResize(Number.MAX_SAFE_INTEGER);
            break;
          case 'End':
            onResize(0);
            break;
          case 'Enter':
          case ' ':
            onReset();
            break;
          default:
            return;
        }
        e.preventDefault();
      }}
    />
  );
}
