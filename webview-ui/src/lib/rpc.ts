/**
 * Typed RPC client over master §8 Msg (webview side). Features per P0-T9:
 * request timeout and re-send-on-rehydrate — pending requests are re-posted
 * when the host signals EVT_REHYDRATE after a view is restored, so handlers
 * must be idempotent or guarded.
 */
import { EVT_REHYDRATE, isMsg, PROTOCOL_VERSION, type Msg, type RpcError } from '../../../src/shared/protocol';
import { getVsCodeApi, type VsCodeApi } from './vscodeApi';

export class RpcRequestError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

interface Pending {
  msg: Msg & { kind: 'req' };
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  timeoutMs: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;

export class RpcClient {
  private readonly api: VsCodeApi;
  private readonly pending = new Map<string, Pending>();
  private readonly eventListeners = new Map<string, Set<(params: unknown) => void>>();
  private seq = 0;

  constructor(api: VsCodeApi = getVsCodeApi()) {
    this.api = api;
    window.addEventListener('message', (e: MessageEvent<unknown>) => this.onMessage(e.data));
  }

  request<T>(method: string, params: unknown = undefined, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<T> {
    const id = `w${++this.seq}-${Date.now().toString(36)}`;
    const msg: Msg & { kind: 'req' } = { v: PROTOCOL_VERSION, id, kind: 'req', method, params };
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new RpcRequestError('timeout', `RPC ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, {
        msg,
        resolve: resolve as (v: unknown) => void,
        reject,
        timer,
        timeoutMs,
      });
      this.api.postMessage(msg);
    });
  }

  /** Fire-and-forget webview→host event. */
  sendEvent(method: string, params: unknown = undefined): void {
    const msg: Msg = {
      v: PROTOCOL_VERSION,
      id: `e${++this.seq}`,
      kind: 'evt',
      method,
      params,
    };
    this.api.postMessage(msg);
  }

  /** Subscribes to host→webview events; returns an unsubscribe function. */
  onEvent(method: string, listener: (params: unknown) => void): () => void {
    let set = this.eventListeners.get(method);
    if (!set) {
      set = new Set();
      this.eventListeners.set(method, set);
    }
    set.add(listener);
    return () => {
      set.delete(listener);
    };
  }

  private onMessage(data: unknown): void {
    if (!isMsg(data)) return;
    if (data.kind === 'res') {
      const pending = this.pending.get(data.id);
      if (!pending) return;
      this.pending.delete(data.id);
      clearTimeout(pending.timer);
      if (data.error) {
        pending.reject(new RpcRequestError(data.error.code, data.error.message));
      } else {
        pending.resolve(data.result);
      }
      return;
    }
    if (data.kind === 'evt') {
      if (data.method === EVT_REHYDRATE) this.resendPending();
      const listeners = this.eventListeners.get(data.method);
      if (listeners) {
        for (const l of [...listeners]) l(data.params);
      }
    }
  }

  /** Re-post in-flight requests after the view was restored (same ids). */
  private resendPending(): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.timer = setTimeout(() => {
        this.pending.delete(pending.msg.id);
        pending.reject(
          new RpcRequestError('timeout', `RPC ${pending.msg.method} timed out after rehydrate`),
        );
      }, pending.timeoutMs);
      this.api.postMessage(pending.msg);
    }
  }
}

export type { RpcError };
