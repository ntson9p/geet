/**
 * In-page mock host for the rebase app: answers rebase/* RPCs like
 * rebaseView.ts would. `window.__rebaseInit` (set by the spec before load)
 * overrides the initial state. Start/continue/skip/abort record messages and
 * walk the phase machine so specs can assert the progress UI.
 */
export const mockRebaseHostScript = `
(() => {
  const sha = (i) => (i.toString(16).padStart(2, '0')).repeat(20);
  const row = (i, subject) => ({
    sha: sha(i),
    shortSha: sha(i).slice(0, 7),
    subject: subject,
    authorName: i % 2 === 0 ? 'Alice' : 'Bob',
    authorTime: 1760000000 - i * 3600,
    message: subject + '\\n\\nbody ' + i,
    action: 'pick',
  });
  const defaults = {
    repoRoot: '/repo',
    branch: 'feature/x',
    baseSha: sha(99),
    baseShort: sha(99).slice(0, 7),
    rows: [0, 1, 2, 3, 4].map((i) => row(i, 'commit ' + i)),
    published: false,
    phase: 'edit',
    log: [],
  };
  let state = Object.assign({}, defaults, window.__rebaseInit || {});
  const post = (msg) => setTimeout(() => window.postMessage(msg, '*'), 3);
  const pushState = () => post({ v: 1, id: 'evt' + Math.random(), kind: 'evt', method: 'rebase/state', params: state });
  const api = {
    postMessage(msg) {
      (window.__postedMessages = window.__postedMessages || []).push(msg);
      if (!msg || msg.v !== 1 || msg.kind !== 'req') return;
      const res = (result) => post({ v: 1, id: msg.id, kind: 'res', result });
      switch (msg.method) {
        case 'rebase/init':
          res(state);
          break;
        case 'rebase/start':
          if (state.published && !msg.params.forceAcknowledged) {
            res({ ok: false, error: 'published-not-acknowledged' });
            break;
          }
          state = Object.assign({}, state, { phase: 'running', log: ['Rebasing…'] });
          res({ ok: true });
          pushState();
          break;
        case 'rebase/continue':
          state = Object.assign({}, state, { phase: 'done', outcome: 'completed', log: state.log.concat(['Rebase completed.']) });
          res({ ok: true });
          pushState();
          break;
        case 'rebase/abort':
          state = Object.assign({}, state, { phase: 'done', outcome: 'aborted', log: state.log.concat(['Rebase aborted.']) });
          res({ ok: true });
          pushState();
          break;
        default:
          res({ ok: true });
      }
    },
    getState() { return this._s; },
    setState(s) { this._s = s; },
  };
  window.acquireVsCodeApi = () => api;
  window.__pushRebaseState = (patch) => { state = Object.assign({}, state, patch); pushState(); };
})();
`;
