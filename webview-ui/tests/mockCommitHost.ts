/**
 * Mock host for the commit tool window (P11-T2, extended in P11-T3).
 *
 * It routes **exactly** the way `src/ui/webviewHost.ts` does: a `handlers` map
 * reached only by `kind: 'req'`, and `kind: 'evt'` reaching nothing, because the
 * commit window registers no host-side event listeners. That fidelity is the
 * point. P11-T2's webview posted its intents with `sendEvent` while the host
 * registered them with `on()`, so every intent but `init` was answered by
 * nobody — and the old mock, which happily handled `evt`, made the suite pass
 * anyway. A mock that accepts messages the product drops is worse than none.
 *
 * Unknown methods answer with the same `unknown-method` error the real router
 * returns, so a regression surfaces as a visible failure instead of silence.
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

  // One file with three separate changes, so per-change inclusion has
  // something real to select from.
  const DIFF_PATH = 'src/main/java/util/Strings.java';
  const ORIGINAL = 'line1\\nline2\\nline3\\nline4\\nline5\\nline6\\nline7\\n';
  const MODIFIED = 'line1\\nCHANGED2\\nline3\\nCHANGED4\\nline5\\nCHANGED6\\nline7\\n';
  const DIFF_CHANGES = [
    { originalStartLineNumber: 2, originalEndLineNumber: 2, modifiedStartLineNumber: 2, modifiedEndLineNumber: 2 },
    { originalStartLineNumber: 4, originalEndLineNumber: 4, modifiedStartLineNumber: 4, modifiedEndLineNumber: 4 },
    { originalStartLineNumber: 6, originalEndLineNumber: 6, modifiedStartLineNumber: 6, modifiedEndLineNumber: 6 },
  ];
  const SIGNATURE = DIFF_CHANGES.map((c) =>
    c.originalStartLineNumber + ',' + c.originalEndLineNumber + ',' +
    c.modifiedStartLineNumber + ',' + c.modifiedEndLineNumber
  ).join(';');
  /** relPath -> included indices. Absent means the whole file. */
  const included = new Map();

  function decorate(c) {
    const copy = Object.assign({}, c);
    const sel = included.get(c.path);
    if (sel) copy.partial = { total: DIFF_CHANGES.length, included: sel.length };
    return copy;
  }

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
              changes: changes.map(decorate),
            },
            {
              id: '__unversioned__',
              name: 'Unversioned Files',
              isActive: false,
              isDefault: false,
              // P11-T3: untracked files are tickable now.
              checkable: true,
              changes: unversioned.map(decorate),
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
      checkedCount:
        changes.filter((c) => c.checked).length + unversioned.filter((c) => c.checked).length,
      paradigm: 'changelists',
    };
  }

  function push() {
    window.postMessage(
      { v: 1, id: 'h' + Math.random(), kind: 'evt', method: 'commit/state', params: build() },
      '*'
    );
  }

  function fileOf(path) {
    return changes.concat(unversioned).find((c) => c.path === path);
  }

  const handlers = {
    'commit/init': () => build(),
    'commit/refresh': () => { setTimeout(push, 5); },
    'commit/setChecked': (p) => {
      const wanted = new Set(p.paths);
      for (const c of changes.concat(unversioned)) {
        if (wanted.has(c.path)) c.checked = p.checked;
      }
      if (!p.checked) for (const path of p.paths) included.delete(path);
      setTimeout(push, 5);
    },
    'commit/setMessage': (p) => { message = p.message; },
    'commit/toggleAmend': () => {
      amend = !amend;
      if (amend && message.trim().length === 0) message = 'previous subject';
      setTimeout(push, 5);
    },
    'commit/fileDiff': (p) => {
      const target = fileOf(p.path);
      const checked = target ? target.checked : false;
      if (p.path !== DIFF_PATH) {
        return {
          repoRoot: REPO, path: p.path, originalText: '', modifiedText: '',
          changes: [], included: null, checked: checked, wholeFileOnly: true, signature: '',
        };
      }
      const sel = included.get(p.path);
      return {
        repoRoot: REPO,
        path: p.path,
        originalText: ORIGINAL,
        modifiedText: MODIFIED,
        changes: DIFF_CHANGES,
        included: sel ? sel.slice() : null,
        checked: checked,
        wholeFileOnly: false,
        signature: SIGNATURE,
      };
    },
    'commit/setIncluded': (p) => {
      if (p.signature !== SIGNATURE) { setTimeout(push, 5); return; }
      const file = fileOf(p.path);
      if (p.included.length === 0) {
        included.delete(p.path);
        if (file) file.checked = false;
      } else if (p.included.length === DIFF_CHANGES.length) {
        included.delete(p.path);
        if (file) file.checked = true;
      } else {
        included.set(p.path, p.included.slice());
        if (file) file.checked = true;
      }
      setTimeout(push, 5);
    },
    'commit/commit': () => undefined,
    'commit/openDiff': () => undefined,
    'commit/rollback': () => undefined,
    'commit/shelve': () => undefined,
    'commit/showHistory': () => undefined,
    'commit/showOptions': () => undefined,
  };

  const api = {
    postMessage(msg) {
      if (!msg || msg.v !== 1) return;
      (window.__postedMessages = window.__postedMessages || []).push(msg);
      // Mirrors WebviewRpcHost.dispatch: requests reach handlers, events reach
      // the (empty) event-listener map. Nothing else is routed.
      if (msg.kind !== 'req') return;
      const handler = handlers[msg.method];
      let response;
      if (!handler) {
        response = {
          v: 1, id: msg.id, kind: 'res',
          error: { code: 'unknown-method', message: 'No handler for ' + msg.method },
        };
      } else {
        try {
          response = { v: 1, id: msg.id, kind: 'res', result: handler(msg.params) };
        } catch (err) {
          response = {
            v: 1, id: msg.id, kind: 'res',
            error: { code: 'handler-failed', message: String(err) },
          };
        }
      }
      setTimeout(() => window.postMessage(response, '*'), 5);
    },
    // VS Code's webview state survives a reload, so the mock stores it where a
    // reload can find it — otherwise a persistence test would only ever prove
    // that a closure variable was reinitialised.
    getState() {
      if (state === undefined) {
        const raw = sessionStorage.getItem('gt-mock-state');
        state = raw ? JSON.parse(raw) : undefined;
      }
      return state;
    },
    setState(s) {
      state = s;
      sessionStorage.setItem('gt-mock-state', JSON.stringify(s));
    },
  };
  window.acquireVsCodeApi = () => api;
})();
`;
