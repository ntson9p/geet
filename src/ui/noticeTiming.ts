/**
 * How long GitTree's plain notices stay on screen (new-way-6). Pure, so every
 * rule is unit-tested; `notices.ts` shows them.
 *
 * VS Code hides an extension's information toast after 10 seconds (15 before
 * 1.105). It counts only while its window is in front, starts the whole time
 * again when it gets there late, and never hides a toast under the pointer, so
 * *Fetch successful* could sit in the corner for a minute. An extension can
 * neither set that time nor take one toast down. A notice with nothing to
 * click is shown instead as a progress notification that GitTree ends on its
 * own clock: `gittree.notifications.durationSeconds` while VS Code is in
 * front, a little longer for a long one.
 */

/** `gittree.notifications.durationSeconds` when it is not set. */
export const DEFAULT_NOTICE_SECONDS = 5;
/** The most the setting takes: past a minute, a notice is no longer a short one. */
export const MAX_NOTICE_SECONDS = 60;

/** The setting's value, made usable: seconds from 0 (ordinary notifications) to the most. */
export function noticeSeconds(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return DEFAULT_NOTICE_SECONDS;
  return Math.min(MAX_NOTICE_SECONDS, Math.max(0, raw));
}

/** Words the setting's time is for; past them, each four add a second. */
const WORDS_IN_TIME = 10;
/** About how fast one reads: 240 words a minute. */
const WORDS_PER_SECOND = 4;

/**
 * How long `message` stays, in milliseconds: the setting's seconds, and a
 * second more for every four words past ten, up to twice the setting. Most
 * notices are a few words (*Checked out main*); a sentence of explanation gets
 * the time to read it.
 */
export function noticeDurationMs(message: string, seconds: number): number {
  const words = message.split(/\s+/u).filter((w) => w.length > 0).length;
  const extra = Math.max(0, words - WORDS_IN_TIME) / WORDS_PER_SECOND;
  return Math.round(Math.min(seconds * 2, seconds + extra) * 1000);
}

/** Whether VS Code's window is in front, and word when that changes. */
export interface WindowFocus {
  readonly focused: boolean;
  onDidChange(listener: (focused: boolean) => void): { dispose(): void };
}

/** The clock a notice's time runs on: the real one, outside the tests. */
export interface NoticeClock {
  now(): number;
  setTimeout(run: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const realClock: NoticeClock = {
  now: () => Date.now(),
  setTimeout: (run, ms) => setTimeout(run, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * Resolves once VS Code's window has been in front for `ms` in all. Away in
 * another application, the notice waits, and finishes what is left of its
 * time when you are back: IntelliJ's way, where VS Code starts it again.
 */
export function afterFocusedTime(ms: number, focus: WindowFocus, clock: NoticeClock = realClock): Promise<void> {
  return new Promise<void>((resolve) => {
    let left = Math.max(0, ms);
    /** When the running stretch began; none while the window is away. */
    let since: number | undefined;
    let handle: unknown;
    let done = false;
    /** The window's word, listened to until the time is up. */
    const listening: { sub?: { dispose(): void } } = {};
    const finish = (): void => {
      if (done) return;
      done = true;
      listening.sub?.dispose();
      resolve();
    };
    const run = (): void => {
      if (done || since !== undefined) return;
      if (left <= 0) {
        finish();
        return;
      }
      since = clock.now();
      handle = clock.setTimeout(() => {
        since = undefined;
        left = 0;
        finish();
      }, left);
    };
    const pause = (): void => {
      if (done || since === undefined) return;
      clock.clearTimeout(handle);
      left = Math.max(0, left - (clock.now() - since));
      since = undefined;
    };
    listening.sub = focus.onDidChange((focused) => (focused ? run() : pause()));
    if (focus.focused) run();
  });
}

/**
 * The output log's line for a notice, which leaves no entry in VS Code's
 * notification centre: when it was said, and what.
 */
export function noticeLogLine(message: string, at: Date): string {
  const two = (n: number): string => String(n).padStart(2, '0');
  return `[notice] ${two(at.getHours())}:${two(at.getMinutes())}:${two(at.getSeconds())} ${message}`;
}
