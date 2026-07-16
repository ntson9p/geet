/**
 * In-page mock host for the log app: answers log/* RPCs like logView.ts
 * would — 100k synthetic commits in 2000-row pages, details on demand.
 * Kept dependency-free (runs inside the page before modules load).
 */
export const mockLogHostScript = `
(() => {
  const TOTAL = 100000;
  const PAGE = 2000;
  const sha = (i) => (i.toString(16).padStart(8, '0')).repeat(5);
  const row = (i) => ({
    sha: sha(i),
    subject: 'commit ' + i,
    authorName: i % 3 === 0 ? 'Alice' : 'Bob',
    authorTime: Math.floor(Date.now() / 1000) - i * 3600,
    parents: i + 1 < TOTAL ? [sha(i + 1)] : [],
    refs: i === 0 ? [{ name: 'main', type: 'branch', isHeadTarget: true }] : [],
    graph: {
      nodeLane: 0,
      colorIdx: 0,
      lanesBefore: i === 0 ? [] : [{ lane: 0, colorIdx: 0 }],
      joins: [],
      forks: i + 1 < TOTAL ? [{ lane: 0, colorIdx: 0, kind: 'first' }] : [],
      continues: [],
    },
  });
  let state;
  const post = (msg) => setTimeout(() => window.postMessage(msg, '*'), 3);
  const api = {
    postMessage(msg) {
      (window.__postedMessages = window.__postedMessages || []).push(msg);
      if (!msg || msg.v !== 1 || msg.kind !== 'req') return;
      const res = (result) => post({ v: 1, id: msg.id, kind: 'res', result });
      switch (msg.method) {
        case 'log/init':
          res({ repoRoot: '/repo', repoLabel: 'repo', filter: (msg.params && msg.params.filter) || { sort: 'topo', refs: 'HEAD' }, laneWidth: 12, graphPalette: window.__mockGraphPalette });
          break;
        case 'log/page': {
          const page = msg.params.page;
          const start = page * PAGE;
          const rows = [];
          for (let i = start; i < Math.min(start + PAGE, TOTAL); i++) rows.push(row(i));
          res({ ok: true });
          post({ v: 1, id: 'evt' + page, kind: 'evt', method: 'log/rows', params: { page, rows, eof: start + PAGE >= TOTAL } });
          break;
        }
        case 'log/details': {
          const s = msg.params.sha;
          res({
            sha: s, parents: [], authorName: 'Alice', authorEmail: 'a@x.dev',
            authorTime: 1700000000, committerName: 'Alice', committerEmail: 'a@x.dev',
            committerTime: 1700000000, refs: [], body: 'body of ' + s.slice(0, 7),
            files: [
              { status: 'M', path: 'src/app.ts' },
              { status: 'R', path: 'src/new.ts', origPath: 'src/old.ts' },
            ],
          });
          break;
        }
        case 'log/setFilter': {
          res({ ok: true });
          post({ v: 1, id: 'evtreset', kind: 'evt', method: 'log/reset', params: { repoRoot: '/repo', repoLabel: 'repo', filter: msg.params.filter, laneWidth: 12 } });
          break;
        }
        default:
          res({ ok: true });
      }
    },
    getState() { return state; },
    setState(s) { state = s; },
  };
  window.acquireVsCodeApi = () => api;
})();
`;
