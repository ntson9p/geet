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
        case 'log/branches': {
          res({
            current: 'main', detached: false,
            locals: [
              { name: 'main', favorite: false },
              { name: 'release', favorite: true },
              { name: 'feature/f1', favorite: false },
              { name: 'feature/f1-1', favorite: false },
              { name: 'feature/f2', favorite: false },
            ],
            remotes: [{ remote: 'origin', branches: ['origin/main', 'origin/dev'] }],
            tags: ['v1.0'],
            myAuthor: 'a@x.dev',
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
    // Webview state survives a reload in the product; the mock stores it where
    // a reload can find it, or layout-persistence tests prove nothing.
    getState() {
      if (state === undefined) {
        const raw = sessionStorage.getItem('gt-mock-log-state');
        state = raw ? JSON.parse(raw) : undefined;
      }
      return state;
    },
    setState(s) {
      state = s;
      sessionStorage.setItem('gt-mock-log-state', JSON.stringify(s));
    },
  };
  window.acquireVsCodeApi = () => api;
})();
`;
