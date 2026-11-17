/**
 * In-page mock host for the Repositories and Branches panels (new-way-4; one
 * panel until POST-P14co): answers `branches/*` as `branchPanel.ts` would, over
 * a workspace of three repositories — `web` and `api` sharing most branches,
 * `shared` on its own — one of them in the middle of a rebase.
 *
 * POST-P14co: a page is one panel, `window.__mockRole` (`'repositories'`;
 * anything else is the Branches panel). Two pages of one test are the two
 * panels of one host: a pick made in either reaches the other, and so do
 * typing and New Branch… in the Repositories panel (a BroadcastChannel).
 *
 * Opt-ins, set before the page loads:
 * - `window.__mockSingleRepo` — just `web`;
 * - `window.__mockHoldFetch` — Fetch All answers only on `window.__releaseFetch()`;
 * - `window.__mockNoOperation` — no rebase in progress;
 * - `window.__mockHoldRun` — `branches/run` answers only on `window.__releaseRun()`;
 * - `window.__mockDots` — the Repository Dots start on;
 * - `window.__mockScope` — the repositories picked, as the host kept them
 *   (POST-P14ce); unset, nothing is kept yet and the panel's old copy is adopted.
 * POST-P14ce: `window.__mockPickElsewhere(roots)` is a pick made in the Commit
 * window (Show all, Show Only This Repository); `window.__mockReveal(root)` a
 * name on its filter bar.
 * Every message the page posts is in `window.__postedMessages`.
 */
export const mockBranchesHostScript = `
(() => {
  // POST-P14co: which panel this page is, as the host's page tells it.
  const role = window.__mockRole === 'repositories' ? 'repositories' : 'branches';
  window.__gittreeInitialState = { role };
  const NOW = 1_800_000_000;
  const H = 3600, D = 86400;
  const sha = (n) => (n.toString(16).padStart(8, '0')).repeat(5);
  const ref = (name, n, age, extra) => Object.assign({ name, sha: sha(n), date: NOW - age, subject: 'Work on ' + name }, extra || {});
  const repo = (root, label, colorIdx, extra) => Object.assign({
    root, label, colorIdx, detached: false, unborn: false, changes: 0, fetching: false,
    locals: [], remotes: [], tags: [], recent: [], favorites: [], merged: [],
  }, extra);

  const web = repo('/work/web', 'web', 0, {
    head: 'feature/login', headSha: sha(1), upstream: 'origin/feature/login', ahead: 2, changes: 3,
    locals: [
      ref('feature/login', 1, 2 * H, { current: true, upstream: 'origin/feature/login', ahead: 2 }),
      ref('main', 2, 3 * D, { upstream: 'origin/main', behind: 4 }),
      ref('develop', 3, 1 * D, { upstream: 'origin/develop' }),
      ref('feature/search', 4, 6 * D, { upstream: 'origin/feature/search', gone: true }),
      ref('bugfix/header', 5, 20 * D),
      ref('hotfix/1.0.2', 6, 40 * D, { upstream: 'origin/hotfix/1.0.2' }),
      ref('feature/mistracked', 12, 4 * H, { upstream: 'origin/develop', ahead: 1 }),
    ],
    remotes: [
      ref('origin/main', 7, 2 * D, { remote: 'origin' }),
      ref('origin/develop', 3, 1 * D, { remote: 'origin' }),
      ref('origin/feature/login', 8, 3 * H, { remote: 'origin' }),
      ref('origin/feature/payments', 9, 5 * H, { remote: 'origin' }),
      ref('origin/hotfix/1.0.2', 6, 40 * D, { remote: 'origin' }),
    ],
    tags: [ref('v1.0', 10, 90 * D), ref('v1.1', 11, 30 * D)],
    recent: ['develop', 'main', 'bugfix/header'],
    favorites: ['develop'],
    mainBranch: 'origin/main',
    merged: ['hotfix/1.0.2'],
  });
  const api = repo('/work/api', 'api', 1, {
    head: 'feature/login', headSha: sha(21), upstream: 'origin/feature/login', behind: 1,
    locals: [
      ref('feature/login', 21, 5 * H, { current: true, upstream: 'origin/feature/login', behind: 1 }),
      ref('main', 22, 4 * D, { upstream: 'origin/main' }),
      ref('develop', 23, 2 * D, { upstream: 'origin/develop' }),
    ],
    remotes: [
      ref('origin/main', 22, 4 * D, { remote: 'origin' }),
      ref('origin/develop', 23, 2 * D, { remote: 'origin' }),
      ref('origin/feature/login', 24, 1 * H, { remote: 'origin' }),
    ],
    tags: [ref('v1.0', 25, 90 * D)],
    recent: ['main'],
    mainBranch: 'origin/main',
  });
  const shared = repo('/work/shared', 'shared', 2, {
    head: 'main', headSha: sha(31), upstream: 'origin/main',
    locals: [
      ref('main', 31, 10 * D, { current: true, upstream: 'origin/main' }),
      ref('refactor/types', 32, 12 * D),
    ],
    remotes: [ref('origin/main', 31, 10 * D, { remote: 'origin' })],
    operation: { kind: 'rebase', conflicts: 2, step: 2, total: 5 },
    mainBranch: 'origin/main',
  });

  const state = {
    repos: window.__mockSingleRepo === true ? [web] : [api, shared, web],
    showTags: true, showInOut: true, groupByFolder: true, fetchingAll: false, now: NOW, palette: 'default',
    // Off, as gittree.branches.showRepositoryDots is by default; opt in with window.__mockDots.
    showRepositoryDots: window.__mockDots === true,
  };
  if (window.__mockNoOperation === true) delete shared.operation;
  window.__mockState = state;

  const post = (msg) => setTimeout(() => window.postMessage(msg, '*'), 3);
  const pushState = () => post({ v: 1, id: 'evtstate', kind: 'evt', method: 'branches/state', params: JSON.parse(JSON.stringify(state)) });
  window.__pushState = pushState;
  const repoOf = (root) => state.repos.find((r) => r.root === root);

  // POST-P14ce: the pick, kept here as the host keeps it (reposInView.ts):
  // every open repository picked is none; until one is kept, the panel's old
  // copy is adopted once.
  let scopeKept = Array.isArray(window.__mockScope);
  state.scope = scopeKept ? window.__mockScope.slice() : [];
  const keepScope = (roots) => {
    const open = state.repos.map((r) => r.root);
    const picked = roots.filter((r, i) => typeof r === 'string' && roots.indexOf(r) === i);
    state.scope = open.length > 0 && open.every((r) => picked.includes(r)) ? [] : picked;
    scopeKept = true;
  };
  window.__mockPickElsewhere = (roots) => {
    keepScope(roots);
    post({ v: 1, id: 'evtscope', kind: 'evt', method: 'branches/scope', params: { roots: state.scope.slice() } });
  };

  // POST-P14co: the other panel's page, as the host joins the two webviews.
  const channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel('gittree-mock-branches') : undefined;
  const tell = (msg) => {
    if (channel) channel.postMessage(msg);
  };
  if (channel) {
    channel.onmessage = (e) => {
      const m = e.data || {};
      if (m.type === 'scope') {
        window.__mockPickElsewhere(m.roots);
      } else if (m.type === 'searchFor' && role === 'branches') {
        post({ v: 1, id: 'evtfocus', kind: 'evt', method: 'branches/focusFilter', params: m.text ? { text: m.text } : {} });
      } else if (m.type === 'newBranch' && role === 'branches') {
        post({ v: 1, id: 'evtnew', kind: 'evt', method: 'branches/newBranch', params: { from: m.from, roots: m.roots } });
      }
    };
  }
  window.__mockReveal = (root) =>
    post({ v: 1, id: 'evtreveal', kind: 'evt', method: 'branches/revealRepo', params: { root } });

  const details = (target) => ({
    repos: target.roots.map((root) => {
      const r = repoOf(root);
      const list = target.kind === 'local' ? r.locals : target.kind === 'remote' ? r.remotes : r.tags;
      const x = list.find((l) => l.name === target.name);
      return {
        root, author: 'Alice', date: x ? x.date : NOW,
        ...(x && x.current ? {} : { vsHead: { head: r.head || 'HEAD', ahead: 3, behind: 1 } }),
      };
    }),
    buttons: target.roots.length > 1
      ? [{ label: 'Checkout in ' + target.roots.length, title: 'Checkout in all ' + target.roots.length + ' repositories', icon: 'arrow-swap', run: { type: 'action', target, action: 'checkout' } }]
      : [
          { label: 'Checkout', title: 'Checkout', icon: 'arrow-swap', run: { type: 'action', target, action: 'checkout' } },
          { label: 'New Branch…', title: "New Branch from '" + target.name + "'…", icon: 'add', run: { type: 'newBranch', from: target.name, roots: target.roots } },
        ],
  });
  const branchMenu = (target) => [
    { kind: 'item', label: 'Checkout', run: { type: 'action', target, action: 'checkout' } },
    { kind: 'item', label: "New Branch from '" + target.name + "'…", run: { type: 'newBranch', from: target.name, roots: target.roots } },
    { kind: 'separator' },
    { kind: 'submenu', label: 'More', items: [{ kind: 'item', label: 'Rename…', run: { type: 'action', target, action: 'rename' } }] },
  ];
  // As the host's: one of several repositories updates under its own name, the
  // only one under the project's (POST-P14bx).
  const repoMenu = (root) => {
    const several = state.repos.length > 1;
    return [
      { kind: 'item', label: 'Show in New Log Tab', run: { type: 'command', command: 'gittree.repositories.showInLog', root } },
      { kind: 'separator' },
      several
        ? { kind: 'item', label: 'Update Repository…', run: { type: 'command', command: 'gittree.update.repository', root } }
        : { kind: 'item', label: 'Update Project…', run: { type: 'command', command: 'gittree.update.dialog', root } },
      several
        ? { kind: 'item', label: 'Update Repository Without Fetching…', run: { type: 'command', command: 'gittree.update.repositoryWithoutFetch', root } }
        : { kind: 'item', label: 'Update Project Without Fetching…', run: { type: 'command', command: 'gittree.update.withoutFetch', root } },
      { kind: 'item', label: 'Fetch', run: { type: 'command', command: 'gittree.fetch', root } },
      { kind: 'separator' },
      { kind: 'item', label: 'New Branch…', run: { type: 'newBranch', from: 'HEAD', roots: [root] } },
    ];
  };

  const api2 = {
    postMessage(msg) {
      if (!msg || msg.v !== 1) return;
      (window.__postedMessages = window.__postedMessages || []).push(msg);
      if (msg.kind !== 'req') return;
      const res = (result) => post({ v: 1, id: msg.id, kind: 'res', result });
      const p = msg.params || {};
      switch (msg.method) {
        case 'branches/init':
          // The pick the panel kept itself before POST-P14ce, adopted once.
          if (!scopeKept && Array.isArray(p.scope) && p.scope.length > 0) keepScope(p.scope);
          res(JSON.parse(JSON.stringify(state)));
          break;
        case 'branches/setScope':
          if (Array.isArray(p.roots)) {
            keepScope(p.roots);
            tell({ type: 'scope', roots: state.scope.slice() });
          }
          res({ roots: state.scope.slice() });
          break;
        case 'branches/searchFor':
          // Typed in the Repositories panel: the Branches panel's filter takes it.
          tell({ type: 'searchFor', text: typeof p.text === 'string' ? p.text : '' });
          res(null);
          break;
        case 'branches/details':
          res(details(p.target));
          break;
        case 'branches/menu':
          res(p.target ? branchMenu(p.target) : repoMenu(p.root));
          break;
        case 'branches/run': {
          if (window.__mockHoldRun === true) window.__releaseRun = () => res(null);
          else res(null);
          const run = p.run || {};
          // POST-P14co: New Branch… asked in the Repositories panel opens the Branches panel's form.
          if (run.type === 'newBranch') tell({ type: 'newBranch', from: run.from, roots: run.roots });
          if (run.type === 'command' && run.command === 'gittree.fetch' && run.root) {
            const r = repoOf(run.root);
            r.fetching = true;
            pushState();
            setTimeout(() => { r.fetching = false; pushState(); }, window.__mockFetchMs || 400);
          }
          break;
        }
        case 'branches/favorite': {
          for (const root of p.target.roots) {
            const r = repoOf(root);
            r.favorites = p.on ? [...new Set([...r.favorites, p.target.name])] : r.favorites.filter((f) => f !== p.target.name);
          }
          res(null);
          pushState();
          break;
        }
        case 'branches/create': {
          if (p.name === 'refused') { res({ ok: false, error: 'web: fatal: something git said' }); break; }
          for (const root of p.roots) {
            const r = repoOf(root);
            if (p.checkout) for (const l of r.locals) delete l.current;
            r.locals.push(ref(p.name, 99, 0, p.checkout ? { current: true } : {}));
            if (p.checkout) r.head = p.name;
          }
          res({ ok: true });
          pushState();
          break;
        }
        case 'branches/setting': {
          const key = p.key === 'showIncomingOutgoing' ? 'showInOut' : p.key;
          state[key] = p.value;
          res(null);
          pushState();
          break;
        }
        case 'branches/fetchAll': {
          state.fetchingAll = true;
          pushState();
          const done = () => { state.fetchingAll = false; pushState(); res(null); };
          if (window.__mockHoldFetch === true) window.__releaseFetch = done;
          else setTimeout(done, 300);
          break;
        }
        default:
          res(null);
      }
    },
    getState() { return window.__mockVsState; },
    setState(s) { window.__mockVsState = s; },
  };
  window.acquireVsCodeApi = () => api2;
})();
`;
