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
