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
    // Every fifth commit was committed by someone else: the Author column's *.
    committedByOther: i % 5 === 4 ? true : undefined,
    authorTime: Math.floor(Date.now() / 1000) - i * 3600,
    parents: i + 1 < TOTAL ? [sha(i + 1)] : [],
    refs:
      i === 0
        ? [{ name: 'main', type: 'branch', isHeadTarget: true }]
        : i === 7
          ? [{ name: 'v1.0', type: 'tag' }, { name: 'v1.0.1', type: 'tag' }]
          : [],
    graph: {
      nodeLane: 0,
      colorIdx: 0,
      lanesBefore: i === 0 ? [] : [{ lane: 0, colorIdx: 0 }],
      joins: [],
      forks: i + 1 < TOTAL ? [{ lane: 0, colorIdx: 0, kind: 'first' }] : [],
      continues: [],
    },
  });
  // Opt-in (window.__mockNewCommits = n): n commits made since the list was
  // read, newest first, above the 100k: what a commit, a pull or a cherry-pick
  // puts at the top of page 0 before the host's preserving reset.
  const fresh = () => window.__mockNewCommits || 0;
  const freshSha = (k) => ('e' + k.toString(16).padStart(7, '0')).repeat(5);
  const freshRow = (i) => {
    const k = fresh() - i; // 1 is the oldest new commit
    return {
      sha: freshSha(k),
      subject: 'new commit ' + k,
      authorName: 'Alice',
      authorTime: Math.floor(Date.now() / 1000) + k * 60,
      parents: [k > 1 ? freshSha(k - 1) : sha(0)],
      refs: i === 0 ? [{ name: 'main', type: 'branch', isHeadTarget: true }] : [],
      graph: {
        nodeLane: 0,
        colorIdx: 0,
        lanesBefore: i === 0 ? [] : [{ lane: 0, colorIdx: 0 }],
        joins: [],
        forks: [{ lane: 0, colorIdx: 0, kind: 'first' }],
        continues: [],
      },
    };
  };
  // Row i of the history as it stands: the new commits, then the 100k.
  const rowAt = (i) => (i < fresh() ? freshRow(i) : row(i - fresh()));
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
  // The presentation settings as the host holds them. Opt-in starting values
  // (window.__mockPresentation, merged over these); IntelliJ's defaults otherwise.
  const presentation = () =>
    (window.__mockPresentation = Object.assign(
      {
        showTagNames: false,
        showTags: true,
        compactReferences: true,
        referencesOnLeft: false,
        showAuthorColumn: true,
        showDateColumn: true,
        showHashColumn: false,
        showGraph: true,
        dateFormat: 'YYYY/MM/DD HH:mm',
        filterChips: 'compact',
      },
      window.__mockPresentation || {},
    ));
  // POST-P14bh: the workspace's two repositories, each with its own refs.
  // Paths ▾ · Roots moves a tab between them, keeping its filter as logView does.
  const ROOTS = [
    { root: '/repo', label: 'repo', colorIdx: 0 },
    { root: '/other', label: 'other', colorIdx: 1 },
  ];
  const REFS = {
    '/repo': {
      locals: [
        { name: 'main', favorite: false, upstream: 'origin/main' },
        { name: 'release', favorite: true },
        { name: 'feature/f1', favorite: false },
        { name: 'feature/f1-1', favorite: false },
        { name: 'feature/f2', favorite: false },
      ],
      remotes: [{ remote: 'origin', branches: ['origin/main', 'origin/dev'] }],
      tags: ['v1.0'],
    },
    '/other': {
      locals: [
        { name: 'main', favorite: false },
        { name: 'only-in-other', favorite: false },
      ],
      remotes: [],
      tags: [],
    },
  };
  const rootByTab = {};
  const rootOf = (tab) => rootByTab[tab] || '/repo';
  const rootLabel = (tab) => (ROOTS.find((r) => r.root === rootOf(tab)) || ROOTS[0]).label;
  const refNames = (root) => {
    const r = REFS[root];
    return r.locals.map((b) => b.name).concat(...r.remotes.map((x) => x.branches), r.tags);
  };
  // As LogService answers: the names the filter picks that this repository lacks.
  const missingIn = (root, filter) =>
    filter && Array.isArray(filter.refs) ? filter.refs.filter((n) => !refNames(root).includes(n)) : [];
  // The Log tabs as logView keeps them: the main tab first, extras appended.
  // Opt-in starting list (window.__mockTabs) for the restore tests.
  const tabsState = () =>
    (window.__mockTabsState = window.__mockTabsState || {
      tabs: window.__mockTabs || [{ id: 'log', filter: { sort: 'topo', refs: 'HEAD' }, closable: false }],
      active: window.__mockActiveTab || 'log',
      next: 1,
    });
  const tabOf = (params) => (params && typeof params.logTab === 'string' ? params.logTab : 'log');
  const tabsDto = (show) => {
    const s = tabsState();
    return { tabs: s.tabs, active: s.active, ...(show ? { show } : {}) };
  };
  const postTabs = (show) =>
    post({ v: 1, id: 'evttabs', kind: 'evt', method: 'log/tabsChanged', params: tabsDto(show) });
  // A command opening a tab of its own (File History and the like), as a test drives it.
  // With several repositories the host also says which one the tab shows.
  window.__mockOpenTab = (filter, repo) => {
    const s = tabsState();
    const id = 'log-' + s.next++;
    s.tabs.push(repo ? { id, filter, closable: true, repo } : { id, filter, closable: true });
    s.active = id;
    postTabs(id);
    return id;
  };
  const api = {
    postMessage(msg) {
      (window.__postedMessages = window.__postedMessages || []).push(msg);
      if (!msg || msg.v !== 1 || msg.kind !== 'req') return;
      const res = (result) => post({ v: 1, id: msg.id, kind: 'res', result });
      switch (msg.method) {
        case 'log/tabs':
          // Opt-in (window.__mockInitTab): a tab asked for before the view
          // could hear the event, as logView.showTab hands it over.
          res(tabsDto(window.__mockInitTab));
          break;
        case 'log/openTab': {
          const s = tabsState();
          const from = s.tabs.find((t) => t.id === (msg.params && msg.params.from)) || s.tabs[0];
          const id = 'log-' + s.next++;
          s.tabs.push({ id, filter: from.filter, closable: true });
          s.active = id;
          res({ logTab: id });
          postTabs();
          break;
        }
        case 'log/closeTabs': {
          const s = tabsState();
          const closing = (msg.params && msg.params.tabs) || [];
          s.tabs = s.tabs.filter((t) => !t.closable || !closing.includes(t.id));
          if (!s.tabs.some((t) => t.id === s.active)) s.active = 'log';
          res({ ok: true });
          postTabs();
          break;
        }
        case 'log/activateTab': {
          const s = tabsState();
          if (s.tabs.some((t) => t.id === tabOf(msg.params))) s.active = tabOf(msg.params);
          res({ ok: true });
          break;
        }
        case 'log/init': {
          const tab = tabsState().tabs.find((t) => t.id === tabOf(msg.params));
          res({
            repoRoot: '/repo', repoLabel: 'repo',
            roots: ROOTS,
            filter: (msg.params && msg.params.filter) || (tab && tab.filter) || { sort: 'topo', refs: 'HEAD' },
            laneWidth: 12, graphPalette: window.__mockGraphPalette,
            issue: { pattern: 'GT-\\\\d+', url: 'https://tracker.example/browse/$0' },
            presets: [
              { name: 'mine only', filter: { sort: 'topo', refs: 'HEAD', authors: ['a@x.dev'] } },
            ],
            presentation: presentation(),
            logTab: tabOf(msg.params),
          });
          break;
        }
        case 'log/setPresentation': {
          // As logView answers: what the settings say once written.
          window.__mockPresentation = Object.assign({}, presentation(), msg.params);
          res(window.__mockPresentation);
          break;
        }
        case 'log/page': {
          const page = msg.params.page;
          const logTab = tabOf(msg.params);
          const tab = tabsState().tabs.find((t) => t.id === logTab);
          const filter = tab && tab.filter;
          const missing = missingIn(rootOf(logTab), filter);
          res({ ok: true });
          if (missing.length > 0 && missing.length === filter.refs.length) {
            // Nothing the repository has: an empty, finished log that says why.
            post({ v: 1, id: 'evt' + page, kind: 'evt', method: 'log/rows', params: { page, rows: [], eof: true, logTab, missingRefs: missing } });
            break;
          }
          const start = page * PAGE;
          const total = TOTAL + fresh();
          const rows = [];
          for (let i = start; i < Math.min(start + PAGE, total); i++) rows.push(rowAt(i));
          const params = { page, rows, eof: start + PAGE >= total, logTab };
          if (missing.length > 0) params.missingRefs = missing;
          post({ v: 1, id: 'evt' + page, kind: 'evt', method: 'log/rows', params });
          break;
        }
        case 'log/setRoot': {
          const logTab = tabOf(msg.params);
          const tab = tabsState().tabs.find((t) => t.id === logTab);
          rootByTab[logTab] = msg.params.root;
          const label = (ROOTS.find((r) => r.root === msg.params.root) || { label: 'repo' }).label;
          res({ ok: true });
          // The tab's filter rides along, the Branch selection included.
          post({ v: 1, id: 'evtreset-root', kind: 'evt', method: 'log/reset', params: { repoRoot: msg.params.root, repoLabel: label, roots: ROOTS, filter: (tab && tab.filter) || { sort: 'topo', refs: 'HEAD' }, laneWidth: 12, logTab } });
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
        case 'log/rangeCounts': {
          res(window.__mockRangeCounts === undefined ? { left: 2, right: 3 } : window.__mockRangeCounts);
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
            // As the host merges several commits: each file carries its ends.
            const oldest = shas[shas.length - 1];
            res({
              files: [
                { status: 'M', path: 'src/app.ts', before: oldest + '^', after: shas[0] },
                { status: 'A', path: 'src/agg-added.ts', after: shas[0] },
                { status: 'D', path: 'docs/agg-gone.md', before: oldest + '^' },
              ],
              newest: shas[0],
              shas,
            });
          }
          break;
        }
        case 'log/branches': {
          // The refs of the repository the tab shows.
          const refs = REFS[rootOf(tabOf(msg.params))];
          res({
            current: 'main', detached: false,
            locals: refs.locals,
            remotes: refs.remotes,
            tags: refs.tags,
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
        case 'log/refresh': {
          // As logView does: re-read in place — a preserving reset, after
          // which the webview pages again. Opt-in (window.__mockHoldRefresh):
          // the reset waits for window.__releaseRefresh(), as a slow re-read.
          const logTab = tabOf(msg.params);
          const tab = tabsState().tabs.find((t) => t.id === logTab);
          // Every reset carries the roots, as logView's startSession puts them in.
          const reset = () =>
            post({ v: 1, id: 'evtreset', kind: 'evt', method: 'log/reset', params: { repoRoot: rootOf(logTab), repoLabel: rootLabel(logTab), roots: ROOTS, filter: (tab && tab.filter) || { sort: 'topo', refs: 'HEAD' }, laneWidth: 12, logTab, preserve: true } });
          if (window.__mockHoldRefresh === true) window.__releaseRefresh = reset;
          else reset();
          res({ ok: true });
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
          const logTab = tabOf(msg.params);
          const tab = tabsState().tabs.find((t) => t.id === logTab);
          if (tab) tab.filter = msg.params.filter;
          res({ ok: true });
          // With the roots, as logView's startSession sends every reset.
          post({ v: 1, id: 'evtreset', kind: 'evt', method: 'log/reset', params: { repoRoot: rootOf(logTab), repoLabel: rootLabel(logTab), roots: ROOTS, filter: msg.params.filter, laneWidth: 12, logTab } });
          // The strip retitles from the host's echo, as logView sends it.
          postTabs();
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
