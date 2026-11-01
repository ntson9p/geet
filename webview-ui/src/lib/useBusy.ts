/**
 * A button's "working on it" state: true from the click until the work it
 * started settles, and for at least `MIN_BUSY_MS` — a refresh that answers in
 * twenty milliseconds still shows it ran, rather than nothing moving at all.
 */
import { useCallback, useRef, useState } from 'react';

export const MIN_BUSY_MS = 450;

/**
 * `[busy, track]`. `track(work)` runs `work` unless the last one is still
 * going: a second click on a spinning Refresh does not queue a second refresh.
 * Failure ends the busy state too; reporting it stays with the caller.
 */
export function useBusy(): [boolean, (work: () => Promise<unknown>) => void] {
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  const track = useCallback((work: () => Promise<unknown>) => {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    const started = Date.now();
    const end = () => {
      const finish = () => {
        running.current = false;
        setBusy(false);
      };
      const left = MIN_BUSY_MS - (Date.now() - started);
      if (left > 0) setTimeout(finish, left);
      else finish();
    };
    let promise: Promise<unknown>;
    try {
      promise = work();
    } catch {
      end();
      return;
    }
    promise.then(end, end);
  }, []);
  return [busy, track];
}
