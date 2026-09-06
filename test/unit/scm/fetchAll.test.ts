import { describe, expect, it } from 'vitest';
import {
  firstLine,
  runFetchAll,
  summarizeFetch,
  type FetchTarget,
} from '../../../src/scm/fetchAll';

/**
 * POST-P14o — Fetch is project-wide, as IntelliJ's is. What the fan-out has to
 * guarantee: one failing root never hides the others, the pool is bounded, and
 * cancelling reports honestly what was and was not done.
 */

const targets = (n: number): FetchTarget[] =>
  Array.from({ length: n }, (_, i) => ({ root: `X:/repo${i}`, name: `repo${i}` }));

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('runFetchAll', () => {
  it('fetches every target and reports them in input order', async () => {
    const seen: string[] = [];
    const outcomes = await runFetchAll(targets(5), async (t) => {
      // Reverse the completion order: the result must still be input-ordered.
      await sleep(t.name === 'repo0' ? 30 : 1);
      seen.push(t.name);
    });
    expect(outcomes.map((o) => o.name)).toEqual(['repo0', 'repo1', 'repo2', 'repo3', 'repo4']);
    expect(outcomes.every((o) => o.status === 'ok')).toBe(true);
    expect(seen).toHaveLength(5);
    expect(seen[seen.length - 1]).toBe('repo0');
  });

  it('one failing root does not stop the rest — every other root still fetches', async () => {
    const outcomes = await runFetchAll(targets(4), async (t) => {
      await sleep(1);
      if (t.name === 'repo1') throw new Error('fatal: could not read from remote\nhint: ignored');
    });
    expect(outcomes.map((o) => o.status)).toEqual(['ok', 'failed', 'ok', 'ok']);
    // Only the first line of the git failure is carried into the summary.
    expect(outcomes[1]?.message).toBe('fatal: could not read from remote');
  });

  it('never rejects, even when every root fails', async () => {
    const outcomes = await runFetchAll(targets(3), () => Promise.reject(new Error('boom')));
    expect(outcomes.map((o) => o.status)).toEqual(['failed', 'failed', 'failed']);
  });

  it('bounds the pool: never more than `concurrency` fetches in flight', async () => {
    let inFlight = 0;
    let peak = 0;
    await runFetchAll(
      targets(12),
      async () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await sleep(5);
        inFlight--;
      },
      { concurrency: 3 },
    );
    expect(peak).toBe(3);
  });

  it('cancelling stops scheduling: unstarted roots come back "cancelled"', async () => {
    let cancelled = false;
    const started: string[] = [];
    const outcomes = await runFetchAll(
      targets(6),
      async (t) => {
        started.push(t.name);
        await sleep(2);
        if (started.length >= 2) cancelled = true;
      },
      { concurrency: 1, isCancelled: () => cancelled },
    );
    expect(started).toEqual(['repo0', 'repo1']);
    expect(outcomes.map((o) => o.status)).toEqual([
      'ok',
      'ok',
      'cancelled',
      'cancelled',
      'cancelled',
      'cancelled',
    ]);
  });

  it('reports progress as each root settles, counting up to the total', async () => {
    const ticks: Array<[number, number]> = [];
    await runFetchAll(targets(3), () => Promise.resolve(), {
      concurrency: 1,
      onSettled: (_o, done, total) => ticks.push([done, total]),
    });
    expect(ticks).toEqual([
      [1, 3],
      [2, 3],
      [3, 3],
    ]);
  });

  it('handles an empty workspace without spawning a worker', async () => {
    let calls = 0;
    const outcomes = await runFetchAll([], () => {
      calls++;
      return Promise.resolve();
    });
    expect(outcomes).toEqual([]);
    expect(calls).toBe(0);
  });
});

describe('summarizeFetch', () => {
  it('counts what the one notification has to say', () => {
    const summary = summarizeFetch([
      { root: 'a', name: 'a', status: 'ok' },
      { root: 'b', name: 'b', status: 'failed', message: 'nope' },
      { root: 'c', name: 'c', status: 'cancelled' },
      { root: 'd', name: 'd', status: 'ok' },
    ]);
    expect(summary).toEqual({
      ok: 2,
      cancelled: 1,
      failures: [{ root: 'b', name: 'b', status: 'failed', message: 'nope' }],
      total: 4,
    });
  });
});

describe('firstLine', () => {
  it('takes the git message, not the hint block behind it', () => {
    expect(firstLine(new Error('fatal: repository not found\nhint: check the URL'))).toBe(
      'fatal: repository not found',
    );
  });

  it('survives a non-Error rejection', () => {
    expect(firstLine('plain string')).toBe('plain string');
  });
});
