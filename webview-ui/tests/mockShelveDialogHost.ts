/**
 * Mock host for the Shelve Changes dialog (P11-T7). Routes exactly like the
 * production router (`WebviewRpcHost.dispatch` + `dialogHost`): requests reach
 * the `handlers` map; `dialog/accept`/`dialog/cancel` are EVENTS the host
 * subscribes to with `onEvent` — the mock records them in __postedMessages
 * like everything else, which is what the specs assert on.
 */
export const mockShelveDialogHostScript = `
(() => {
  window.__geetInitialState = { dialog: 'shelve' };

  const PARAMS = {
    repoRoot: 'D:/repos/demo-git',
    repoLabel: 'demo-git',
    listId: 'default',
    message: 'draft message from the commit window',
    lists: [
      {
        id: 'default', name: 'Changes', isActive: true,
        files: [
          { path: 'src/main/java/util/Strings.java', code: '.M', kind: 'modified', checked: true },
          { path: 'src/main/java/api/Controller.java', code: '.M', kind: 'modified', checked: true },
          { path: 'docs/notes.md', code: '.M', kind: 'modified', checked: true },
        ],
      },
      {
        id: 'feature', name: 'Feature work', isActive: false,
        files: [ { path: 'src/feature.ts', code: '.M', kind: 'modified', checked: true } ],
      },
      {
        id: '__unversioned__', name: 'Unversioned Files', isActive: false,
        files: [ { path: 'new-file.txt', code: '??', kind: 'untracked', checked: true } ],
      },
    ],
  };

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

  const handlers = {
    'dialog/init': () => ({ dialog: 'shelve', params: JSON.parse(JSON.stringify(PARAMS)) }),
    'shelveDialog/refresh': () => JSON.parse(JSON.stringify(PARAMS)),
    'shelveDialog/fileDiff': (p) => {
      if (p.relPath !== DIFF_PATH) {
        return {
          path: p.relPath, originalText: '', modifiedText: '',
          changes: [], wholeFileOnly: true, signature: '',
        };
      }
      return {
        path: p.relPath, originalText: ORIGINAL, modifiedText: MODIFIED,
        changes: DIFF_CHANGES, wholeFileOnly: false, signature: SIGNATURE,
      };
    },
  };

  let state;
  const api = {
    postMessage(msg) {
      if (!msg || msg.v !== 1) return;
      (window.__postedMessages = window.__postedMessages || []).push(msg);
      if (msg.kind !== 'req') return; // events reach onEvent subscribers only
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
    getState() {
      if (state === undefined) {
        const raw = sessionStorage.getItem('gt-mock-dialog-state');
        state = raw ? JSON.parse(raw) : undefined;
      }
      return state;
    },
    setState(s) {
      state = s;
      sessionStorage.setItem('gt-mock-dialog-state', JSON.stringify(s));
    },
  };
  window.acquireVsCodeApi = () => api;
})();
`;
