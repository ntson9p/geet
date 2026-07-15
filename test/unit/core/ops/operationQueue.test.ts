import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GitError } from '../../../../src/core/git/errors';
import type { CancelToken, GitExecutor } from '../../../../src/core/git/executor';
import { OperationQueue, type Operation } from '../../../../src/core/ops/operationQueue';
import { buildCapabilities } from '../../../../src/core/git/capabilities';

/** The queue never touches the executor itself — ops do. A stub suffices. */
const stubGit: GitExecutor = {
  version: '2.43.0',
  caps: buildCapabilities('2.43.0'),
  gitPath: 'git',
  exec: () => Promise.resolve({ stdout: '', stderr: '', exitCode: 0 }),
  stream: () => ({ cancel: () => undefined, done: Promise.resolve({ stdout: '', stderr: '', exitCode: 0 }) }),
};

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

interface Span {
  label: string;
  kind: 'read' | 'mutate';
  start: number;
  end: number;
}

let queues: OperationQueue[] = [];
function makeQueue(opts: ConstructorParameters<typeof OperationQueue>[2] = {}): OperationQueue {
  const q = new OperationQueue('X:/repo', stubGit, { lockRetryBaseMs: 5, ...opts });
  queues.push(q);
  return q;
}

afterEach(() => {
  for (const q of queues) q.dispose();
  queues = [];
});

function op<T>(
  label: string,
  kind: 'read' | 'mutate',
  run: (git: GitExecutor, token: CancelToken) => Promise<T>,
  extra: Partial<Operation<T>> = {},
): Operation<T> {
  return { label, kind, run, ...extra };
}

describe('OperationQueue serialization', () => {
  it('stress: 20 interleaved reads + 5 mutations — mutations never overlap anything', async () => {
    const q = makeQueue();
    const spans: Span[] = [];
    const jobs: Promise<unknown>[] = [];

    const track =
      (label: string, kind: 'read' | 'mutate', ms: number) =>
      async (_git: GitExecutor, token: CancelToken): Promise<string> => {
        const start = Date.now();
        await sleep(ms);
        if (kind === 'read' && token.isCancellationRequested) {
          throw new Error('cancelled');
        }
        spans.push({ label, kind, start, end: Date.now() });
        return label;
      };

    for (let i = 0; i < 25; i++) {
      if (i % 5 === 2) {
        jobs.push(q.enqueue(op(`m${i}`, 'mutate', track(`m${i}`, 'mutate', 15))));
      } else {
        jobs.push(q.enqueue(op(`r${i}`, 'read', track(`r${i}`, 'read', 8))));
      }
      if (i % 7 === 0) await sleep(3); // interleave arrivals
    }
    const results = await Promise.all(jobs);
    expect(results).toHaveLength(25);

    const mutations = spans.filter((s) => s.kind === 'mutate');
    expect(mutations).toHaveLength(5);
    // No mutation interval may overlap any other completed span.
    for (const m of mutations) {
      for (const other of spans) {
        if (other === m) continue;
        const overlaps = m.start < other.end && other.start < m.end;
        expect(overlaps, `${m.label} overlaps ${other.label}`).toBe(false);
      }
    }
  }, 30_000);

  it('caps reader concurrency at the pool size', async () => {
    const q = makeQueue({ readerConcurrency: 4 });
    let running = 0;
    let peak = 0;
    const jobs = Array.from({ length: 12 }, (_, i) =>
      q.enqueue(
        op(`r${i}`, 'read', async () => {
          running++;
          peak = Math.max(peak, running);
          await sleep(10);
          running--;
        }),
      ),
    );
    await Promise.all(jobs);
    expect(peak).toBeLessThanOrEqual(4);
    expect(peak).toBeGreaterThan(1);
  });

  it('cancels and requeues in-flight readers when a mutation arrives; their promises still resolve', async () => {
    const q = makeQueue();
    const events: string[] = [];
    let readerAttempts = 0;

    const slowRead = q.enqueue(
      op('slow-read', 'read', async (_g, token) => {
        readerAttempts++;
        const attempt = readerAttempts;
        for (let i = 0; i < 20; i++) {
          await sleep(5);
          if (token.isCancellationRequested) {
            events.push(`read-cancelled-attempt-${attempt}`);
            throw new Error('cancelled');
          }
        }
        events.push(`read-done-attempt-${attempt}`);
        return 'read-result';
      }),
    );

    await sleep(12); // let the reader get going
    const mutation = q.enqueue(
      op('mutation', 'mutate', async () => {
        events.push('mutation-ran');
        await sleep(5);
        return 'mut-result';
      }),
    );

    await expect(mutation).resolves.toBe('mut-result');
    await expect(slowRead).resolves.toBe('read-result');
    expect(readerAttempts).toBe(2);
    expect(events).toEqual(['read-cancelled-attempt-1', 'mutation-ran', 'read-done-attempt-2']);
  }, 15_000);
});

describe('OperationQueue index.lock retry', () => {
  it('retries with growing backoff until the artificial lock is released', async () => {
    const q = makeQueue({ lockRetryBaseMs: 10 });
    const lockDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gittree-lock-'));
    const lockPath = path.join(lockDir, 'index.lock');
    fs.writeFileSync(lockPath, '');
    setTimeout(() => fs.rmSync(lockPath, { force: true }), 60);

    let attempts = 0;
    const result = await q.enqueue(
      op('locked-commit', 'mutate', () => {
        attempts++;
        if (fs.existsSync(lockPath)) {
          return Promise.reject(
            new GitError('index-lock', 'index.lock exists', {
              args: ['commit'],
              exitCode: 128,
              stderr: "fatal: Unable to create 'index.lock': File exists.",
              stdout: '',
            }),
          );
        }
        return Promise.resolve('committed');
      }),
    );
    expect(result).toBe('committed');
    expect(attempts).toBeGreaterThanOrEqual(2);
    fs.rmSync(lockDir, { recursive: true, force: true });
  });

  it('surfaces the GitError after max attempts', async () => {
    const q = makeQueue({ lockRetryBaseMs: 2, lockMaxAttempts: 3 });
    let attempts = 0;
    await expect(
      q.enqueue(
        op('always-locked', 'mutate', () => {
          attempts++;
          return Promise.reject(
            new GitError('index-lock', 'locked', { args: [], exitCode: 128, stderr: '', stdout: '' }),
          );
        }),
      ),
    ).rejects.toMatchObject({ kind: 'index-lock' });
    expect(attempts).toBe(3);
  });

  it('does not retry non-lock errors', async () => {
    const q = makeQueue();
    let attempts = 0;
    await expect(
      q.enqueue(
        op('conflict', 'mutate', () => {
          attempts++;
          return Promise.reject(
            new GitError('merge-conflict', 'conflict', { args: [], exitCode: 1, stderr: '', stdout: '' }),
          );
        }),
      ),
    ).rejects.toMatchObject({ kind: 'merge-conflict' });
    expect(attempts).toBe(1);
  });
});

describe('OperationQueue destructive hook + suppression', () => {
  it('fires onWillRunDestructive and waits for waitUntil before running', async () => {
    const q = makeQueue();
    const order: string[] = [];
    q.onWillRunDestructive((e) => {
      expect(e.label).toBe('reset-hard');
      expect(e.snapshotLabel).toBe('Before reset');
      e.waitUntil(
        (async () => {
          await sleep(20);
          order.push('snapshot-taken');
        })(),
      );
    });
    await q.enqueue(
      op(
        'reset-hard',
        'mutate',
        () => {
          order.push('op-ran');
          return Promise.resolve();
        },
        { isDestructive: true, snapshotLabel: 'Before reset' },
      ),
    );
    expect(order).toEqual(['snapshot-taken', 'op-ran']);
  });

  it('proceeds when the snapshot hook fails (logged, not blocking)', async () => {
    const traces: string[] = [];
    const q = makeQueue({ trace: (l) => traces.push(l) });
    q.onWillRunDestructive((e) => e.waitUntil(Promise.reject(new Error('store broken'))));
    const result = await q.enqueue(
      op('drop', 'mutate', () => Promise.resolve('dropped'), { isDestructive: true }),
    );
    expect(result).toBe('dropped');
    expect(traces.some((t) => t.includes('store broken'))).toBe(true);
  });

  it('does not fire the hook for non-destructive mutations', async () => {
    const q = makeQueue();
    let fired = 0;
    q.onWillRunDestructive(() => fired++);
    await q.enqueue(op('plain-commit', 'mutate', () => Promise.resolve()));
    expect(fired).toBe(0);
  });

  it('marks the suppression window around mutations', async () => {
    const q = makeQueue({ suppressionGraceMs: 200 });
    const before = Date.now() - 5;
    expect(q.isSelfInflicted(Date.now())).toBe(false);

    let during = 0;
    await q.enqueue(
      op('mut', 'mutate', async () => {
        during = Date.now();
        expect(q.isMutationActive).toBe(true);
        expect(q.isSelfInflicted(during)).toBe(true);
        await sleep(5);
      }),
    );
    expect(q.isMutationActive).toBe(false);
    expect(q.isSelfInflicted(during)).toBe(true); // inside window
    expect(q.isSelfInflicted(Date.now())).toBe(true); // grace period
    expect(q.isSelfInflicted(before)).toBe(false); // predates the mutation
    await sleep(250);
    expect(q.isSelfInflicted(Date.now())).toBe(false); // grace expired
  });
});

describe('OperationQueue progress adapter', () => {
  it('wraps mutations (not reads) and its token cancels the op', async () => {
    const wrapped: string[] = [];
    const q = makeQueue({
      progress: async (info, run) => {
        wrapped.push(info.label);
        const src = new (await import('../../../../src/core/util/cancellation')).CancellationSource();
        setTimeout(() => src.cancel(), 15);
        return run(src.token);
      },
    });

    await q.enqueue(op('a-read', 'read', () => Promise.resolve()));
    expect(wrapped).toHaveLength(0);

    const result = await q.enqueue(
      op('long-mutation', 'mutate', async (_g, token) => {
        for (let i = 0; i < 50; i++) {
          await sleep(5);
          if (token.isCancellationRequested) return 'cancelled-by-progress';
        }
        return 'completed';
      }),
    );
    expect(wrapped).toEqual(['long-mutation']);
    expect(result).toBe('cancelled-by-progress');
  });
});

describe('P6-T7 mutation lane holds', () => {
  it('holds block plain mutations; reads and bypass ops flow; release pumps', async () => {
    const q = makeQueue();
    const order: string[] = [];
    const hold = q.holdMutations('conflict pause');

    const plain = q.enqueue(
      op('plain', 'mutate', () => {
        order.push('plain');
        return Promise.resolve();
      }),
    );
    expect(await q.enqueue(op('read', 'read', () => Promise.resolve('r')))).toBe('r');

    await q.enqueue(
      op(
        'bypass',
        'mutate',
        () => {
          order.push('bypass');
          return Promise.resolve();
        },
        { bypassHold: true },
      ),
    );
    expect(order).toEqual(['bypass']);

    hold.dispose();
    await plain;
    expect(order).toEqual(['bypass', 'plain']);
  });

  it('nested holds: the lane stays held until the last hold releases', async () => {
    const q = makeQueue();
    const h1 = q.holdMutations('a');
    const h2 = q.holdMutations('b');
    let ran = false;
    const plain = q.enqueue(
      op('m', 'mutate', () => {
        ran = true;
        return Promise.resolve();
      }),
    );
    h1.dispose();
    await q.enqueue(op('read', 'read', () => Promise.resolve(undefined)));
    expect(ran).toBe(false);
    h2.dispose();
    await plain;
    expect(ran).toBe(true);
  });

  it('failed mutations report the classified GitError kind', async () => {
    const q = makeQueue();
    const kinds: Array<string | undefined> = [];
    q.onDidFinishMutation((e) => kinds.push(e.errorKind));
    await q
      .enqueue(
        op('conflicting', 'mutate', () =>
          Promise.reject(
            new GitError('merge-conflict', 'CONFLICT (content)', {
              args: ['merge'],
              exitCode: 1,
              stdout: '',
              stderr: 'CONFLICT (content)',
            }),
          ),
        ),
      )
      .catch(() => undefined);
    expect(kinds).toEqual(['merge-conflict']);
  });
});
