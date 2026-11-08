/**
 * new-way-6: GitTree's plain notices leave on GitTree's own clock. The owner
 * found VS Code's ten seconds too long for *Fetch successful*: more while
 * VS Code is away or the pointer rests on the toast, which can look endless.
 */
import { describe, expect, it } from 'vitest';
import {
  afterFocusedTime,
  DEFAULT_NOTICE_SECONDS,
  MAX_NOTICE_SECONDS,
  noticeDurationMs,
  noticeLogLine,
  noticeSeconds,
  type NoticeClock,
  type WindowFocus,
} from '../../../src/ui/noticeTiming';

/** A clock the test moves by hand. */
function manualClock() {
  let now = 0;
  let nextId = 1;
  const timers = new Map<number, { at: number; run: () => void }>();
  const clock: NoticeClock = {
    now: () => now,
    setTimeout: (run, ms) => {
      const id = nextId++;
      timers.set(id, { at: now + ms, run });
      return id;
    },
    clearTimeout: (handle) => {
      timers.delete(handle as number);
    },
  };
  const advance = (ms: number): void => {
    const until = now + ms;
    for (;;) {
      const due = [...timers.entries()].filter(([, t]) => t.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
      if (due === undefined) break;
      timers.delete(due[0]);
      now = due[1].at;
      due[1].run();
    }
    now = until;
  };
  return { clock, advance, pending: () => timers.size };
}

/** A VS Code window the test brings to the front and sends away. */
function manualWindow(focusedAtFirst: boolean) {
  let focused = focusedAtFirst;
  const listeners = new Set<(focused: boolean) => void>();
  const focus: WindowFocus = {
    get focused() {
      return focused;
    },
    onDidChange(listener) {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
  };
  const set = (next: boolean): void => {
    focused = next;
    for (const listener of [...listeners]) listener(next);
  };
  return { focus, set, listening: () => listeners.size };
}

/** Whether `promise` has settled once the microtasks it waits on have run. */
async function isSettled(promise: Promise<void>): Promise<boolean> {
  let settled = false;
  void promise.then(() => {
    settled = true;
  });
  for (let i = 0; i < 5; i++) await Promise.resolve();
  return settled;
}

describe('the setting', () => {
  it('is five seconds when unset, or set to something that is not a number', () => {
    expect(DEFAULT_NOTICE_SECONDS).toBe(5);
    for (const raw of [undefined, null, '7', Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(noticeSeconds(raw)).toBe(DEFAULT_NOTICE_SECONDS);
    }
  });

  it('takes what is set, from 0 (ordinary notifications) to a minute', () => {
    expect(noticeSeconds(0)).toBe(0);
    expect(noticeSeconds(7)).toBe(7);
    expect(noticeSeconds(2.5)).toBe(2.5);
    expect(noticeSeconds(-3)).toBe(0);
    expect(noticeSeconds(1000)).toBe(MAX_NOTICE_SECONDS);
    expect(MAX_NOTICE_SECONDS).toBe(60);
  });
});

describe('how long a notice stays', () => {
  it('is the setting for a notice of a few words', () => {
    expect(noticeDurationMs('Fetch successful', 5)).toBe(5000);
    expect(noticeDurationMs('Checked out main', 5)).toBe(5000);
    expect(noticeDurationMs('one two three four five six seven eight nine ten', 5)).toBe(5000);
    // Words are words, however they are spaced.
    expect(noticeDurationMs('  Checked   out\nmain ', 5)).toBe(5000);
  });

  it('gives a sentence a second for every four words past ten, the time to read it', () => {
    const fourteen = 'one two three four five six seven eight nine ten eleven twelve thirteen fourteen';
    expect(noticeDurationMs(fourteen, 5)).toBe(6000);
    // 18 words: two seconds more.
    expect(
      noticeDurationMs(
        'Nothing to clean up: no branch is merged into the main branch or has lost its remote branch.',
        5,
      ),
    ).toBe(7000);
  });

  it('never more than twice the setting', () => {
    const forty = Array.from({ length: 40 }, (_, i) => `w${i}`).join(' ');
    expect(noticeDurationMs(forty, 5)).toBe(10_000);
    expect(noticeDurationMs(forty, 3)).toBe(6000);
    const fourteen = Array.from({ length: 14 }, (_, i) => `w${i}`).join(' ');
    expect(noticeDurationMs(fourteen, 3)).toBe(4000);
  });
});

describe('the clock a notice runs on', () => {
  it('ends the notice after its time with VS Code in front, and lets go of the window', async () => {
    const { clock, advance } = manualClock();
    const win = manualWindow(true);
    const done = afterFocusedTime(5000, win.focus, clock);
    advance(4999);
    expect(await isSettled(done)).toBe(false);
    advance(1);
    expect(await isSettled(done)).toBe(true);
    expect(win.listening()).toBe(0);
  });

  it('does not run while VS Code is away: the notice waits for you to come back', async () => {
    const { clock, advance, pending } = manualClock();
    const win = manualWindow(false);
    const done = afterFocusedTime(5000, win.focus, clock);
    advance(60_000);
    expect(await isSettled(done)).toBe(false);
    expect(pending()).toBe(0);
    win.set(true);
    advance(4999);
    expect(await isSettled(done)).toBe(false);
    advance(1);
    expect(await isSettled(done)).toBe(true);
  });

  it('finishes what is left of its time when you are back, as IntelliJ does, rather than starting again', async () => {
    const { clock, advance } = manualClock();
    const win = manualWindow(true);
    const done = afterFocusedTime(5000, win.focus, clock);
    advance(3000);
    win.set(false);
    advance(60_000);
    expect(await isSettled(done)).toBe(false);
    win.set(true);
    advance(1999);
    expect(await isSettled(done)).toBe(false);
    advance(1);
    expect(await isSettled(done)).toBe(true);
  });

  it('is not started over by word that VS Code is still in front', async () => {
    const { clock, advance } = manualClock();
    const win = manualWindow(true);
    const done = afterFocusedTime(5000, win.focus, clock);
    advance(2000);
    win.set(true);
    advance(3000);
    expect(await isSettled(done)).toBe(true);
  });

  it('has nothing to wait for with no time to run', async () => {
    const { clock } = manualClock();
    const win = manualWindow(true);
    expect(await isSettled(afterFocusedTime(0, win.focus, clock))).toBe(true);
    expect(win.listening()).toBe(0);
  });
});

describe('the output log', () => {
  it('writes down when a notice was said, and what', () => {
    expect(noticeLogLine('Checked out main', new Date(2026, 10, 8, 9, 5, 7))).toBe('[notice] 09:05:07 Checked out main');
  });
});
