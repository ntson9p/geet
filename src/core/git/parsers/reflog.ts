/**
 * Reflog checkout extraction: `git reflog --format` events used for the
 * "Recent branches" ranking (P2) and reset/branch-deletion detection (P9).
 */

export const REFLOG_FORMAT = '%at%x00%gs%x1e';
export const REFLOG_RECORD_SEPARATOR = '\x1e';

export interface ReflogEntry {
  /** Unix seconds. */
  time: number;
  subject: string;
}

export interface CheckoutEvent {
  from: string;
  to: string;
  /** Unix seconds. */
  time: number;
}

export function parseReflog(output: string): ReflogEntry[] {
  const entries: ReflogEntry[] = [];
  for (const frameRaw of output.split(REFLOG_RECORD_SEPARATOR)) {
    const frame = frameRaw.startsWith('\n') ? frameRaw.slice(1) : frameRaw;
    if (frame.length === 0) continue;
    const nul = frame.indexOf('\0');
    if (nul === -1) continue;
    entries.push({
      time: Number.parseInt(frame.slice(0, nul), 10),
      subject: frame.slice(nul + 1),
    });
  }
  return entries;
}

// Branch names cannot contain spaces, so anchoring the target at the last
// token is unambiguous even though the source is matched greedily.
const CHECKOUT = /^checkout: moving from (.+) to (\S+)$/;

export function parseCheckoutEvents(output: string): CheckoutEvent[] {
  const events: CheckoutEvent[] = [];
  for (const { time, subject } of parseReflog(output)) {
    const m = CHECKOUT.exec(subject);
    if (m) {
      events.push({ from: m[1] as string, to: m[2] as string, time });
    }
  }
  return events;
}
