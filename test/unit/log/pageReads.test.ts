import { describe, expect, it, vi, type Mock } from 'vitest';
import { PageReads } from '../../../src/log/pageReads';

/** A read the test finishes by hand. */
function held(): { promise: Promise<void>; finish: () => void; fail: (err: Error) => void } {
  let finish!: () => void;
  let fail!: (err: Error) => void;
  const promise = new Promise<void>((resolve, reject) => {
    finish = resolve;
    fail = reject;
  });
  return { promise, finish, fail };
}

function actions(read: () => Promise<void> = () => Promise.resolve()): {
  read: Mock<() => Promise<void>>;
  replay: Mock<() => void>;
} {
  return { read: vi.fn(read), replay: vi.fn<() => void>() };
}

describe('PageReads: a page asked for twice is read once', () => {
  it('the next page is read', async () => {
    const reads = new PageReads();
    const act = actions();
    const { kind, done } = reads.request(0, 0, act);
    expect(kind).toBe('read');
    await done;
    expect(act.read).toHaveBeenCalledTimes(1);
    expect(act.replay).not.toHaveBeenCalled();
  });

  it('asked for again while it is being read, the page is read once and both wait for it', async () => {
    const reads = new PageReads();
    const gate = held();
    const act = actions(() => gate.promise);
    const first = reads.request(0, 0, act);
    // What `rehydrate` re-posts: the same page, the session still waiting on it.
    const second = reads.request(0, 0, act);
    expect(second.kind).toBe('join');
    expect(act.read).toHaveBeenCalledTimes(1);
    let answered = false;
    void second.done.then(() => {
      answered = true;
    });
    await Promise.resolve();
    expect(answered).toBe(false);
    gate.finish();
    await Promise.all([first.done, second.done]);
    expect(answered).toBe(true);
    expect(act.read).toHaveBeenCalledTimes(1);
    expect(act.replay).not.toHaveBeenCalled();
  });

  it('a page already sent is replayed, not read again', async () => {
    const reads = new PageReads();
    const act = actions();
    const { kind, done } = reads.request(0, 1, act);
    expect(kind).toBe('replay');
    await done;
    expect(act.replay).toHaveBeenCalledTimes(1);
    expect(act.read).not.toHaveBeenCalled();
  });

  it("a page past the next one was meant for a replaced session: nothing is read or sent", async () => {
    const reads = new PageReads();
    const act = actions();
    const { kind, done } = reads.request(3, 1, act);
    expect(kind).toBe('stale');
    await done;
    expect(act.read).not.toHaveBeenCalled();
    expect(act.replay).not.toHaveBeenCalled();
  });

  it('once its read is done, the page is no longer joined', async () => {
    const reads = new PageReads();
    const act = actions();
    await reads.request(0, 0, act).done;
    expect(reads.isReading(0)).toBe(false);
    // The session has moved on to page 1: page 0 again is a replay.
    expect(reads.request(0, 1, act).kind).toBe('replay');
  });

  it('a failed read fails whoever joined it, and the page can be asked for again', async () => {
    const reads = new PageReads();
    const gate = held();
    const act = actions(() => gate.promise);
    const first = reads.request(0, 0, act);
    const second = reads.request(0, 0, act);
    gate.fail(new Error('git log failed'));
    await expect(first.done).rejects.toThrow('git log failed');
    await expect(second.done).rejects.toThrow('git log failed');
    expect(reads.isReading(0)).toBe(false);
    const retry = actions();
    const again = reads.request(0, 0, retry);
    expect(again.kind).toBe('read');
    await again.done;
    expect(retry.read).toHaveBeenCalledTimes(1);
  });

  it('the read of the page after is its own: a page whose rows were all hidden reads on', async () => {
    const reads = new PageReads();
    const gate = held();
    const act = actions(() => gate.promise);
    // Page 0 is being read and has moved the session on to page 1 (logView's
    // read of an all-hidden page asks for the next one before it returns).
    reads.request(0, 0, act);
    const next = actions();
    const page1 = reads.request(1, 1, next);
    expect(page1.kind).toBe('read');
    await page1.done;
    expect(next.read).toHaveBeenCalledTimes(1);
    gate.finish();
  });
});
