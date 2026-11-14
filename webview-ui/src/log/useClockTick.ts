/**
 * Draws a view again every so often while `enabled` (POST-P14cg): IntelliJ's
 * dates ("Moments ago", "5 minutes ago", "Today 2:19 PM") are written from the
 * clock, and a list written once would go on saying "Moments ago" an hour later.
 * IntelliJ's table repaints on any event; a webview's list only when told.
 *
 * Nothing happens while the page is hidden (a panel closed with its view kept);
 * on coming back it draws at once.
 */
import { useEffect, useState } from 'react';

/** Half a minute: "Moments ago" turns into "A minute ago" at thirty seconds. */
export const CLOCK_TICK_MS = 30_000;

export function useClockTick(enabled: boolean, periodMs: number = CLOCK_TICK_MS): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!enabled) return undefined;
    const draw = (): void => setTick((t) => t + 1);
    const timer = setInterval(() => {
      if (document.visibilityState !== 'hidden') draw();
    }, periodMs);
    const onVisibility = (): void => {
      if (document.visibilityState === 'visible') draw();
    };
    document.addEventListener('visibilitychange', onVisibility);
    // Back in front (a tab switched to, the format just chosen): time has passed.
    draw();
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [enabled, periodMs]);
  return tick;
}
