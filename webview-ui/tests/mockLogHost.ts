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
  // Opt-in (window.__mockWideDetails): a commit whose message line and file
  // path are far wider than the pane that shows them. Off by default so the
  // rest of the suite keeps its narrow fixtures.
  const wide = () => window.__mockWideDetails === true;
  // Opt-in (window.__mockLongDetails): a message far taller than the pane, for
  // the tests about what scrolls and what stays put while you read it.
  const long = () => window.__mockLongDetails === true;
  const WIDE_LINE =
    'Applied from change-resource-sheet2.csv: envoy [sidecar] cpu 50m, memory request 256Mi (limit left as-is for burst headroom), go-actuator [sidecar] cpu 10m, memory 128Mi (request = limit)';
  const WIDE_PATH =
    'service-group/src/main/java/jp/example/backend/group/firebase/component/UserLogicComponentFactory.java';
  const post = (msg) => setTimeout(() => window.postMessage(msg, '*'), 3);
  const api = {
    postMessage(msg) {
      (window.__postedMessages = window.__postedMessages || []).push(msg);
      if (!msg || msg.v !== 1 || msg.kind !== 'req') return;
      const res = (result) => post({ v: 1, id: msg.id, kind: 'res', result });
      switch (msg.method) {
        case 'log/init':
          res({
            repoRoot: '/repo', repoLabel: 'repo',
            roots: [
              { root: '/repo', label: 'repo', colorIdx: 0 },
              { root: '/other', label: 'other', colorIdx: 1 },
            ],
            filter: (msg.params && msg.params.filter) || { sort: 'topo', refs: 'HEAD' },
            laneWidth: 12, graphPalette: window.__mockGraphPalette,
            issue: { pattern: 'GT-\\\\d+', url: 'https://tracker.example/browse/$0' },
            presets: [
              { name: 'mine only', filter: { sort: 'topo', refs: 'HEAD', authors: ['a@x.dev'] } },
            ],
          });
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
          const first = s === sha(0);
          res({
            sha: s, parents: [sha(2), sha(3)], authorName: 'Alice', authorEmail: 'a@x.dev',
            authorTime: 1700000000, committerName: first ? 'Carol' : 'Alice', committerEmail: 'c@x.dev',
            committerTime: 1700000001,
            signature: first ? 'G' : 'N',
            refs: first ? ['HEAD -> main', 'tag: v1.0'] : [],
            body:
              'subject of ' + s.slice(0, 7) + '\\n\\nSee https://example.com/doc and GT-123 for context.' +
              (wide() ? '\\n\\n' + WIDE_LINE : '') +
              (long() ? '\\n\\n' + Array(40).fill(WIDE_LINE).join('\\n') : ''),
            files: wide()
              ? [{ status: 'M', path: WIDE_PATH }]
              : [
                  { status: 'M', path: 'src/app.ts' },
                  { status: 'R', path: 'src/new.ts', origPath: 'src/old.ts' },
                ],
          });
          break;
        }
        case 'log/commitMessage': {
          window.__messageCalls = (window.__messageCalls || 0) + 1;
          res({ message: 'commit ' + msg.params.sha.slice(0, 7) + '\\n\\nBody line one.\\nBody line two.' });
          break;
        }
        case 'log/containedBranches': {
          window.__containsCalls = (window.__containsCalls || 0) + 1;
          res({ branches: ['main', 'release'] });
          break;
        }
        case 'log/goTo': {
          res({ ok: true });
          post({ v: 1, id: 'evtgo', kind: 'evt', method: 'log/reveal', params: { sha: msg.params.sha } });
          break;
        }
        case 'log/changedFiles': {
          const shas = msg.params.shas || [];
          if (shas.length <= 1) {
            res({
              files: wide()
                ? [{ status: 'M', path: WIDE_PATH }]
                : [
                    { status: 'M', path: 'src/app.ts' },
                    { status: 'R', path: 'src/new.ts', origPath: 'src/old.ts' },
                  ],
              newest: shas[0],
            });
          } else {
            res({
              files: [
                { status: 'M', path: 'src/app.ts' },
                { status: 'A', path: 'src/agg-added.ts' },
                { status: 'D', path: 'docs/agg-gone.md' },
              ],
              newest: shas[0],
              base: 'basebasebase',
            });
          }
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
            myName: 'Alice',
          });
          break;
        }
        case 'log/console': {
          const after = (msg.params && msg.params.afterSeq) || 0;
          const all = [
            { seq: 1, ts: 1700000000000, argv: ['status', '--porcelain'], exitCode: 0, durationMs: 12, output: '' },
            { seq: 2, ts: 1700000001000, argv: ['fetch', 'https://***@example.com/r.git'], exitCode: 128, durationMs: 88, output: 'fatal: could not read from remote' },
            { seq: 3, ts: 1700000002000, argv: ['log', '--format=%H'], exitCode: 0, durationMs: 30, output: 'abc123' },
          ];
          res({ entries: window.__consoleCleared ? [] : all.filter((e) => e.seq > after) });
          break;
        }
        case 'log/consoleClear': {
          window.__consoleCleared = true;
          res({ ok: true });
          break;
        }
        case 'log/worktrees': {
          res({
            repos: [
              {
                root: '/repo', label: 'repo',
                worktrees: [
                  { path: '/repo', branch: 'main', head: 'aaaaaaaaaaaa', isMain: true, bare: false, locked: false, prunable: false },
                  { path: '/repo-topic', branch: 'topic', head: 'bbbbbbbbbbbb', isMain: false, bare: false, locked: true, lockReason: 'on a usb stick', prunable: false },
                  { path: '/repo-gone', head: 'cccccccccccc', isMain: false, bare: false, locked: false, prunable: true, prunableReason: 'directory is missing' },
                ],
              },
            ],
          });
          break;
        }
        case 'log/worktreeAction': {
          window.__worktreeActions = window.__worktreeActions || [];
          window.__worktreeActions.push(msg.params);
          res({ ok: true });
          break;
        }
        case 'log/authors': {
          res({ authors: ['Alice <a@x.dev>', 'Bob <b@x.dev>', 'Carol <c@x.dev>'] });
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
