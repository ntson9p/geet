/**
 * Minimal cancellation primitives, shape-compatible with vscode's
 * CancellationToken so either can flow into GitExecutor.
 */
import type { CancelToken } from '../git/executor';
import { Emitter } from './events';

export class CancellationSource {
  private _cancelled = false;
  private readonly emitter = new Emitter<void>();
  readonly token: CancelToken;

  constructor() {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    this.token = {
      get isCancellationRequested(): boolean {
        return self._cancelled;
      },
      onCancellationRequested(listener: () => void) {
        if (self._cancelled) {
          // Fire asynchronously like vscode does to avoid re-entrancy surprises.
          const t = setTimeout(listener, 0);
          return { dispose: () => clearTimeout(t) };
        }
        return self.emitter.event(listener);
      },
    };
  }

  get isCancellationRequested(): boolean {
    return this._cancelled;
  }

  cancel(): void {
    if (this._cancelled) return;
    this._cancelled = true;
    this.emitter.fire();
  }

  dispose(): void {
    this.emitter.dispose();
  }
}

export const NONE_TOKEN: CancelToken = {
  isCancellationRequested: false,
  onCancellationRequested: () => ({ dispose: () => undefined }),
};

/**
 * A token cancelled when *any* of its inputs is. An operation running inside
 * the queue is handed the queue's own token, so work that also answers to an
 * outer cancellation (the fetch-all progress notification's Cancel) needs the
 * two joined rather than one of them dropped. Dispose to release the listeners.
 */
export function anyToken(...tokens: readonly CancelToken[]): {
  token: CancelToken;
  dispose(): void;
} {
  const source = new CancellationSource();
  const subs = tokens.map((t) => t.onCancellationRequested(() => source.cancel()));
  // A token already cancelled before we subscribed still counts.
  if (tokens.some((t) => t.isCancellationRequested)) source.cancel();
  return {
    token: source.token,
    dispose: (): void => {
      for (const s of subs) s.dispose();
      source.dispose();
    },
  };
}
