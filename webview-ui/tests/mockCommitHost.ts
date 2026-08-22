/**
 * Mock host for the commit tool window (P11-T2). Serves `commit/init`, applies
 * `commit/setChecked` / `commit/setMessage` / `commit/toggleAmend` and pushes
 * `commit/state` back, so the Playwright suite exercises the real host round
 * trip rather than component-local state.
 *
 * Kept dependency-free — it runs in the page before any module loads.
 */
export const mockCommitHostScript = `
(() => {
  let state;
  const REPO = 'D:/repos/demo-git';
  const changes = [
    { path: 'src/main/java/api/ArticleDataController.java', code: '.M', kind: 'modified', checked: true },
    { path: 'src/main/java/api/CommentController.java', code: 'A.', kind: 'added', checked: true },
    { path: 'src/main/java/util/Strings.java', code: '.M', kind: 'modified', checked: true },
    { path: 'docs/guide.md', code: '.M', kind: 'modified', checked: false },
  ];
  const unversioned = [{ path: '2.txt', code: '??', kind: 'untracked', checked: false }];
  let message = '';
  let amend = false;

  function build() {
    return {
      repos: [
        {
          root: REPO,
          label: 'demo-git',
          groups: [
            {
              id: 'default',
              name: 'Changes',
              isActive: true,
              isDefault: true,
              checkable: true,
              changes: changes.map((c) => Object.assign({}, c)),
            },
            {
              id: '__unversioned__',
              name: 'Unversioned Files',
              isActive: false,
              isDefault: false,
              checkable: false,
              changes: unversioned.map((c) => Object.assign({}, c)),
            },
          ],
        },
      ],
      activeRepo: REPO,
      message: message,
      amend: amend,
      signing: false,
      busy: false,
      modifiedCount: changes.length + unversioned.length,
      checkedCount: changes.filter((c) => c.checked).length,
      paradigm: 'changelists',
    };
  }

  function push() {
    window.postMessage({ v: 1, id: 'h' + Math.random(), kind: 'evt', method: 'commit/state', params: build() }, '*');
  }

  const api = {
    postMessage(msg) {
      if (!msg || msg.v !== 1) return;
      (window.__postedMessages = window.__postedMessages || []).push(msg);
      if (msg.kind === 'req') {
        let response;
        if (msg.method === 'commit/init') {
          response = { v: 1, id: msg.id, kind: 'res', result: build() };
        } else {
          response = { v: 1, id: msg.id, kind: 'res', result: undefined };
        }
        setTimeout(() => window.postMessage(response, '*'), 5);
        return;
      }
      if (msg.kind !== 'evt') return;
      if (msg.method === 'commit/setChecked') {
        const wanted = new Set(msg.params.paths);
        for (const c of changes) {
          if (wanted.has(c.path)) c.checked = msg.params.checked;
        }
        setTimeout(push, 5);
      } else if (msg.method === 'commit/setMessage') {
        message = msg.params.message;
      } else if (msg.method === 'commit/toggleAmend') {
        amend = !amend;
        if (amend && message.trim().length === 0) message = 'previous subject';
        setTimeout(push, 5);
      }
    },
    getState() { return state; },
    setState(s) { state = s; },
  };
  window.acquireVsCodeApi = () => api;
})();
`;
