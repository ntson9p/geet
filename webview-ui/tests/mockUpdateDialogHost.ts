/**
 * Mock host for the Update Project dialog (P13-T2). Same routing contract as
 * the other dialog mocks: `dialog/init` is a request, accept/cancel are events
 * recorded in `__postedMessages`.
 */
export const mockUpdateDialogHostScript = `
(() => {
  window.__gittreeInitialState = { dialog: 'update' };

  const PARAMS = {
    repoRoot: 'D:/repos/demo-git',
    repoLabel: 'demo-git',
    branch: 'feature/x',
    upstream: 'origin/feature/x',
    remote: 'origin',
    ahead: 2,
    behind: 3,
    strategy: 'merge',
    showCommandLine: true,
  };

  const handlers = {
    'dialog/init': () => ({ dialog: 'update', params: JSON.parse(JSON.stringify(PARAMS)) }),
  };

  let state;
  const api = {
    postMessage(msg) {
      if (!msg || msg.v !== 1) return;
      (window.__postedMessages = window.__postedMessages || []).push(msg);
      if (msg.kind !== 'req') return;
      const handler = handlers[msg.method];
      let response;
      if (!handler) {
        response = {
          v: 1, id: msg.id, kind: 'res',
          error: { code: 'unknown-method', message: 'No handler for ' + msg.method },
        };
      } else {
        response = { v: 1, id: msg.id, kind: 'res', result: handler(msg.params) };
      }
      setTimeout(() => window.postMessage(response, '*'), 5);
    },
    getState() { return state; },
    setState(s) { state = s; },
  };
  window.acquireVsCodeApi = () => api;
})();
`;
