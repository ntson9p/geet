/**
 * Injected into the page before any module runs: a mock acquireVsCodeApi
 * whose postMessage loops requests back like the host RPC router would
 * (echo handler + rehydrate support), plus getState/setState in-memory.
 * Mirrors src/shared/protocol.ts (kept dependency-free — runs in-page).
 */
export const mockVsCodeApiScript = `
(() => {
  let state;
  const api = {
    postMessage(msg) {
      if (!msg || msg.v !== 1) return;
      if (msg.kind === 'req') {
        let response;
        if (msg.method === 'demo/echo') {
          response = { v: 1, id: msg.id, kind: 'res', result: { echoed: msg.params && msg.params.text } };
        } else {
          response = { v: 1, id: msg.id, kind: 'res', error: { code: 'unknown-method', message: 'No handler for ' + msg.method } };
        }
        setTimeout(() => window.postMessage(response, '*'), 5);
      }
      (window.__postedMessages = window.__postedMessages || []).push(msg);
    },
    getState() { return state; },
    setState(s) { state = s; },
  };
  window.acquireVsCodeApi = () => api;
})();
`;
