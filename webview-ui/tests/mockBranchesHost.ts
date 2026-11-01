/**
 * In-page mock host for the Branches sidebar: answers branches/* RPCs like
 * branchesWebView.ts would, for a two-repository workspace with `alpha` open.
 * The rows are hand-written in the shape `popupTree` builds; the menus are the
 * host's (the repository menu mirrors `repositoryMenu.ts`). Kept
 * dependency-free (runs inside the page before modules load).
 */
export const mockBranchesHostScript = `
(() => {
  const ref = (name, isHead) => ({
    name, fullName: 'refs/heads/' + name, type: 'head', sha: 'a'.repeat(40),
    objectType: 'commit', isHead: isHead === true,
  });
  const verb = (command, label, icon, group, root, depth) => ({
    id: root === undefined ? 'verb:' + command : 'verb:' + command + '|' + root,
    kind: 'verb', depth: depth || 0, icon, label, expandable: false, actions: false,
    searchText: label, verb: { command, label, icon, group },
    ...(root !== undefined ? { repoRoot: root } : {}),
  });
  const repoRow = (root, name, description, separator) => ({
    id: 'repo:' + root, kind: 'repo', depth: 0, icon: 'repo', label: name, description,
    expandable: true, actions: true, searchText: name, repoRoot: root,
    ...(separator ? { separator: 'Repositories' } : {}),
  });
  const refRow = (root, name, isHead) => ({
    id: 'ref:' + root + '|head|' + name, kind: 'ref', depth: 2, icon: isHead ? 'check' : 'git-branch',
    label: name, expandable: false, actions: true, searchText: name, ref: ref(name, isHead),
    favorite: false, repoRoot: root,
  });
  const ALPHA = '/work/alpha';
  const BETA = '/work/beta';
  const busy = new Set();
  const rows = () => [
    verb('gittree.update.dialog', 'Update Project…', 'arrow-down', 'project'),
    verb('gittree.commit', 'Commit…', 'git-commit', 'project'),
    verb('gittree.push.dialog', 'Push…', 'arrow-up', 'project'),
    { ...verb('gittree.branch.new', 'New Branch…', 'add', 'branch'), separator: '' },
    { ...repoRow(ALPHA, 'alpha', 'main ↓1', true), ...(busy.has(ALPHA) ? { busy: true } : {}) },
    { id: 'search:' + ALPHA, kind: 'search', depth: 1, icon: 'search', label: '', expandable: false,
      actions: false, searchText: '', repoRoot: ALPHA },
    verb('gittree.branch.new', 'New Branch…', 'add', 'branch', ALPHA, 1),
    { id: 'repo:' + ALPHA + '|local', kind: 'group', depth: 1, icon: 'folder', label: 'Local Branches in alpha',
      description: '2', expandable: true, actions: false, searchText: '', repoRoot: ALPHA, section: 'local' },
    refRow(ALPHA, 'main', true),
    refRow(ALPHA, 'feature/x', false),
    { ...repoRow(BETA, 'beta', 'develop'), ...(busy.has(BETA) ? { busy: true } : {}) },
    { id: 'common:local', kind: 'group', depth: 0, icon: 'folder', label: 'Common Local Branches',
      description: '1', expandable: true, actions: false, searchText: '', commonKind: 'local', separator: '' },
    { id: 'common:local|main', kind: 'common', depth: 1, icon: 'git-branch', label: 'main',
      expandable: false, actions: true, searchText: 'main', common: { kind: 'local', name: 'main' } },
  ];
  const tree = () => ({
    rows: rows(),
    open: ['repo:' + ALPHA, 'repo:' + ALPHA + '|local', 'common:local'],
    topQuery: '', repoQueries: [], repoCount: 2, showInOut: true,
  });
  const REPOSITORY_MENU = [
    { id: 'gittree.update.dialog', label: 'Update Project…' },
    { id: 'gittree.push.dialog', label: 'Push…' },
    { id: 'gittree.fetch', label: 'Fetch' },
    { id: 'gittree.commit', label: 'Commit', separator: true },
    { id: 'gittree.branch.new', label: 'New Branch…', separator: true },
    { id: 'gittree.branches.checkoutRevision', label: 'Checkout Tag or Revision…' },
    { id: 'gittree.stash.dialog', label: 'Stash Changes…', separator: true },
    { id: 'gittree.unstash.dialog', label: 'Unstash Changes…' },
    { id: 'gittree.remotes.manage', label: 'Manage Remotes…', separator: true },
  ];
  const BRANCH_MENU = [
    { id: 'checkout', label: 'Checkout' },
    { id: 'rename', label: 'Rename…', separator: true },
  ];
  const post = (msg) => setTimeout(() => window.postMessage(msg, '*'), 3);
  const pushTree = () => post({ v: 1, id: 'evttree', kind: 'evt', method: 'branches/tree', params: tree() });
  let state;
  const api = {
    postMessage(msg) {
      if (!msg || msg.v !== 1) return;
      (window.__postedMessages = window.__postedMessages || []).push(msg);
      if (msg.kind !== 'req') return;
      const res = (result) => post({ v: 1, id: msg.id, kind: 'res', result });
      const id = msg.params && msg.params.id;
      switch (msg.method) {
        case 'branches/init':
        case 'branches/toggle':
        case 'branches/setTopQuery':
        case 'branches/setRepoQuery':
        case 'branches/header':
          res(tree());
          break;
        case 'branches/actions':
          res(typeof id === 'string' && id.startsWith('repo:') ? REPOSITORY_MENU
            : typeof id === 'string' && id.startsWith('ref:') ? BRANCH_MENU : []);
          break;
        case 'branches/runAction': {
          res(null);
          // As the host does: the repository's row turns while its Fetch runs.
          if (msg.params.action === 'gittree.fetch' && typeof id === 'string' && id.startsWith('repo:')) {
            const root = id.slice('repo:'.length);
            busy.add(root);
            pushTree();
            setTimeout(() => { busy.delete(root); pushTree(); }, window.__mockFetchMs || 400);
          }
          break;
        }
        default:
          res(null);
      }
    },
    getState() { return state; },
    setState(s) { state = s; },
  };
  window.acquireVsCodeApi = () => api;
})();
`;
