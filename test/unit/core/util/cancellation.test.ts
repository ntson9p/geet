import { describe, expect, it } from 'vitest';
import { anyToken, CancellationSource } from '../../../../src/core/util/cancellation';

/**
 * POST-P14o: an operation inside the queue is handed the queue's own token, so
 * work that must also answer to an outer cancellation (fetch-all's Cancel)
 * needs the two joined rather than one of them dropped.
 */
describe('anyToken', () => {
  it('cancels when the first input cancels', () => {
    const a = new CancellationSource();
    const b = new CancellationSource();
    const joined = anyToken(a.token, b.token);
    expect(joined.token.isCancellationRequested).toBe(false);
    a.cancel();
    expect(joined.token.isCancellationRequested).toBe(true);
    joined.dispose();
  });

  it('cancels when the second input cancels', () => {
    const a = new CancellationSource();
    const b = new CancellationSource();
    const joined = anyToken(a.token, b.token);
    b.cancel();
    expect(joined.token.isCancellationRequested).toBe(true);
    joined.dispose();
  });

  it('is already cancelled when an input was cancelled before joining', () => {
    const a = new CancellationSource();
    a.cancel();
    const joined = anyToken(a.token, new CancellationSource().token);
    expect(joined.token.isCancellationRequested).toBe(true);
    joined.dispose();
  });

  it('fires its listeners exactly once, whichever input wins', async () => {
    const a = new CancellationSource();
    const b = new CancellationSource();
    const joined = anyToken(a.token, b.token);
    let fired = 0;
    joined.token.onCancellationRequested(() => fired++);
    a.cancel();
    b.cancel();
    await new Promise((r) => setTimeout(r, 5));
    expect(fired).toBe(1);
    joined.dispose();
  });

  it('stops listening after dispose — a later cancel touches nothing', () => {
    const a = new CancellationSource();
    const joined = anyToken(a.token);
    joined.dispose();
    a.cancel();
    expect(joined.token.isCancellationRequested).toBe(false);
  });
});
