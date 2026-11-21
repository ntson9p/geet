/**
 * Mock host for the P13-T3 dialogs (Merge, Rebase, Reset, Rollback). One
 * factory serves all four: the spec picks which dialog the initial state names,
 * and the handlers cover the only lazy request in the group (the rollback
 * preview's per-file diff).
 */
export function mockOpDialogHostScript(dialog: 'merge' | 'rebase' | 'reset' | 'rollback'): string {
  return `
(() => {
  window.__geetInitialState = { dialog: '${dialog}' };

  const REFS = [
    { name: 'feature/x', kind: 'local' },
    { name: 'main', kind: 'local' },
    { name: 'origin/main', kind: 'remote' },
    { name: 'v1.0', kind: 'tag' },
  ];
  const BASE = {
    repoRoot: 'D:/repos/demo-git',
    repoLabel: 'demo-git',
    currentBranch: 'feature/y',
    showCommandLine: true,
  };

  const PARAMS = {
    merge: Object.assign({}, BASE, { refs: REFS, defaultRef: 'main' }),
    rebase: Object.assign({}, BASE, { refs: REFS, defaultOnto: 'main' }),
    reset: Object.assign({}, BASE, {
      refs: REFS, defaultRef: 'HEAD~1', dirtyCount: 3, stagedCount: 2,
    }),
    rollback: Object.assign({}, BASE, {
      files: [
        { path: 'src/app.ts', code: '.M', kind: 'restore' },
        { path: 'src/new.ts', code: 'A.', kind: 'added' },
        { path: 'scratch.txt', code: '??', kind: 'untracked' },
        { path: 'docs/renamed.md', code: 'R.', kind: 'restore', origPath: 'docs/old.md' },
      ],
      checked: ['src/app.ts', 'src/new.ts', 'scratch.txt', 'docs/renamed.md'],
      deleteAddedLocalCopies: true,
      colors: {},
    }),
  }['${dialog}'];

  const ORIGINAL = 'one\\ntwo\\nthree\\n';
  const MODIFIED = 'one\\nTWO!\\nthree\\n';

  const handlers = {
    'dialog/init': () => ({ dialog: '${dialog}', params: JSON.parse(JSON.stringify(PARAMS)) }),
    'rollbackDialog/fileDiff': (p) => {
      if (p.relPath !== 'src/app.ts') {
        return {
          path: p.relPath, originalText: '', modifiedText: '',
          changes: [], wholeFileOnly: true,
        };
      }
      return {
        path: p.relPath, originalText: ORIGINAL, modifiedText: MODIFIED,
        changes: [{
          originalStartLineNumber: 2, originalEndLineNumber: 2,
          modifiedStartLineNumber: 2, modifiedEndLineNumber: 2,
        }],
        wholeFileOnly: false,
      };
    },
  };

  let state;
  const api = {
    postMessage(msg) {
      if (!msg || msg.v !== 1) return;
      (window.__postedMessages = window.__postedMessages || []).push(msg);
      if (msg.kind !== 'req') return;
      const handler = handlers[msg.method];
      let response;
      if (!handler) {
        response = {
          v: 1, id: msg.id, kind: 'res',
          error: { code: 'unknown-method', message: 'No handler for ' + msg.method },
        };
      } else {
        response = { v: 1, id: msg.id, kind: 'res', result: handler(msg.params) };
      }
      setTimeout(() => window.postMessage(response, '*'), 5);
    },
    getState() { return state; },
    setState(s) { state = s; },
  };
  window.acquireVsCodeApi = () => api;
})();
`;
}
