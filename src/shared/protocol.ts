/**
 * Host ⇄ webview RPC protocol (master §8). Single source of truth compiled
 * into both the extension host and every webview bundle. No `any` (lint-
 * enforced). Every request must be idempotent or guarded — webviews reload
 * and re-send pending requests on rehydrate.
 */

export const PROTOCOL_VERSION = 1 as const;

export interface RpcError {
  code: string;
  message: string;
}

export type Msg =
  | { v: 1; id: string; kind: 'req'; method: string; params: unknown }
  | { v: 1; id: string; kind: 'res'; result?: unknown; error?: RpcError }
  | { v: 1; id: string; kind: 'evt'; method: string; params: unknown };

export function isMsg(x: unknown): x is Msg {
  if (typeof x !== 'object' || x === null) return false;
  const m = x as Record<string, unknown>;
  if (m['v'] !== PROTOCOL_VERSION) return false;
  if (m['kind'] === 'req' || m['kind'] === 'evt') {
    return typeof m['id'] === 'string' && typeof m['method'] === 'string';
  }
  if (m['kind'] === 'res') {
    return typeof m['id'] === 'string';
  }
  return false;
}

/** Host→webview event fired when a hidden/restored view should rehydrate. */
export const EVT_REHYDRATE = '$rehydrate';

/** Built-in demo methods (P0-T9 acceptance surface). */
export const DEMO_METHODS = {
  echo: 'demo/echo',
  rows: 'demo/rows',
} as const;
