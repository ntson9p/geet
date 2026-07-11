/**
 * Singleton wrapper for acquireVsCodeApi() — callable only once per webview.
 * Tests inject a mock via window.acquireVsCodeApi before modules load.
 */
export interface VsCodeApi {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare global {
  interface Window {
    acquireVsCodeApi?: () => VsCodeApi;
    __gittreeInitialState?: unknown;
  }
}

let cached: VsCodeApi | undefined;

export function getVsCodeApi(): VsCodeApi {
  if (!cached) {
    if (typeof window.acquireVsCodeApi !== 'function') {
      throw new Error('acquireVsCodeApi unavailable — not running inside a VS Code webview?');
    }
    cached = window.acquireVsCodeApi();
  }
  return cached;
}

/** Initial state injected by the host HTML factory (webviewHost.ts). */
export function getInitialState<T>(): T | undefined {
  return window.__gittreeInitialState as T | undefined;
}
