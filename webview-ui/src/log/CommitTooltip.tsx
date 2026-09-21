/**
 * The commit-row hover card (POST-P14x). IntelliJ shows a commit's **whole**
 * message on hover, which is the only place a body is visible without giving
 * up the selection — the Details pane follows the selection, so reading one
 * commit's body means losing the one you were comparing it against.
 *
 * Why not a native `title` attribute: the body is fetched lazily (see
 * `LOG_METHODS.commitMessage`), and a `title` written after the browser has
 * already started its own hover timer is not read again. A card of our own
 * also keeps the message's line breaks, which `title` collapses in some
 * renderers and not others.
 */
import { useLayoutEffect, useRef, useState } from 'react';

export interface CommitTooltipProps {
  /** Full message, newlines intact. */
  text: string;
  /** Anchor — the hovered row's rectangle, in viewport coordinates. */
  anchor: { left: number; top: number; bottom: number };
}

/** Gap between the row and the card, and the margin it keeps from the edges. */
const GAP = 6;
const MARGIN = 8;

export function CommitTooltip({ text, anchor }: CommitTooltipProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  // Rendered off-screen for one frame, then placed: the card's height depends
  // on the message, and flipping it above the row needs that height. Measuring
  // in a layout effect keeps the visible frame count at one.
  const [placed, setPlaced] = useState<{ left: number; top: number } | undefined>(undefined);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const below = anchor.bottom + GAP;
    // Below the row unless that would run off the bottom, in which case above
    // it — never clamped to the bottom edge, which would cover the row and put
    // the card under the pointer, closing itself.
    const top =
      below + height + MARGIN <= window.innerHeight
        ? below
        : Math.max(MARGIN, anchor.top - GAP - height);
    const left = Math.max(MARGIN, Math.min(anchor.left, window.innerWidth - width - MARGIN));
    setPlaced({ left, top });
  }, [anchor, text]);

  return (
    <div
      ref={ref}
      className="gt-commit-tooltip"
      role="tooltip"
      data-testid="commit-tooltip"
      style={
        placed === undefined
          ? { visibility: 'hidden', left: 0, top: 0 }
          : { left: placed.left, top: placed.top }
      }
    >
      {text}
    </div>
  );
}
