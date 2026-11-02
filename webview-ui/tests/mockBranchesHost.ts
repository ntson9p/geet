/**
 * In-page mock host for the Branches panel (new-way-4): answers `branches/*`
 * as `branchPanel.ts` would, over a workspace of three repositories — `web`
 * and `api` sharing most branches, `shared` on its own — one of them in the
 * middle of a rebase.
 *
 * Opt-ins, set before the page loads:
 * - `window.__mockSingleRepo` — just `web`;
 * - `window.__mockHoldFetch` — Fetch All answers only on `window.__releaseFetch()`;
 * - `window.__mockNoOperation` — no rebase in progress;
 * - `window.__mockHoldRun` — `branches/run` answers only on `window.__releaseRun()`.
 * Every message the page posts is in `window.__postedMessages`.
 */
export const mockBranchesHostScript = `
(() => {
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
  };
  if (window.__mockNoOperation === true) delete shared.operation;
  window.__mockState = state;

  const post = (msg) => setTimeout(() => window.postMessage(msg, '*'), 3);
  const pushState = () => post({ v: 1, id: 'evtstate', kind: 'evt', method: 'branches/state', params: JSON.parse(JSON.stringify(state)) });
  window.__pushState = pushState;
  const repoOf = (root) => state.repos.find((r) => r.root === root);

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
  const repoMenu = (root) => [
    { kind: 'item', label: 'Update Project…', run: { type: 'command', command: 'gittree.update.dialog', root } },
    { kind: 'item', label: 'Fetch', run: { type: 'command', command: 'gittree.fetch', root } },
  ];

  const api2 = {
    postMessage(msg) {
      if (!msg || msg.v !== 1) return;
      (window.__postedMessages = window.__postedMessages || []).push(msg);
      if (msg.kind !== 'req') return;
      const res = (result) => post({ v: 1, id: msg.id, kind: 'res', result });
      const p = msg.params || {};
      switch (msg.method) {
        case 'branches/init':
          res(JSON.parse(JSON.stringify(state)));
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
