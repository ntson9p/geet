/**
 * Mock host for the P13-T4 dialogs (Cherry-pick, Stash, Unstash, Apply Patch,
 * Clone, Manage Remotes). One factory; the spec names the dialog.
 *
 * The remotes handlers mutate an in-memory table so add → edit → remove really
 * round-trips in the spec, which is what the dialog's live-apply model needs.
 */
export function mockT4DialogHostScript(
  dialog: 'cherryPick' | 'stash' | 'unstash' | 'applyPatch' | 'clone' | 'remotes',
): string {
  return `
(() => {
  window.__gittreeInitialState = { dialog: '${dialog}' };

  const BASE = {
    repoRoot: 'D:/repos/demo-git',
    repoLabel: 'demo-git',
    currentBranch: 'feature/y',
    showCommandLine: true,
  };

  const PARAMS = {
    cherryPick: Object.assign({}, BASE, {
      recordOrigin: true,
      commits: [
        { sha: 'aaaaaaa1111111111111111111111111111111111', subject: 'newest on side', authorName: 'Ada', authorTime: 1700000200, parentCount: 1 },
        { sha: 'bbbbbbb2222222222222222222222222222222222', subject: 'a merge commit', authorName: 'Ada', authorTime: 1700000100, parentCount: 2 },
        { sha: 'ccccccc3333333333333333333333333333333333', subject: 'oldest on side', authorName: 'Ada', authorTime: 1700000000, parentCount: 1 },
      ],
    }),
    stash: Object.assign({}, BASE, {
      canStashStaged: true, dirtyCount: 5, untrackedCount: 2, stagedCount: 1,
      includeUntrackedDefault: true,
    }),
    unstash: Object.assign({}, BASE, {
      entries: [
        { index: 0, message: 'WIP on feature/y: work in progress', branch: 'feature/y', date: 1700000000 },
        { index: 1, message: 'On main: older stash', branch: 'main', date: 1699000000 },
      ],
      changelists: [ { id: 'default', name: 'Changes' }, { id: 'feature', name: 'Feature work' } ],
      activeChangelistId: 'default',
    }),
    applyPatch: Object.assign({}, BASE, {
      patchPath: '', summary: [], isMailbox: false,
    }),
    clone: { defaultParent: 'D:/work', showCommandLine: true },
    remotes: Object.assign({}, BASE, {
      remotes: [ { name: 'origin', fetchUrl: 'https://host/team/repo.git', pushUrl: '' } ],
    }),
  }['${dialog}'];

  // --- remotes: a live table the handlers really mutate --------------------
  let remoteRows = JSON.parse(JSON.stringify(PARAMS && PARAMS.remotes ? PARAMS.remotes : []));

  const CHOSEN_PATCH = {
    patchPath: 'D:/patches/fix.patch',
    summary: [
      { relPath: 'src/app.ts', hunks: 2, status: 'modified', missing: false },
      { relPath: 'src/gone.ts', hunks: 1, status: 'modified', missing: true },
    ],
    isMailbox: true,
  };

  const handlers = {
    'dialog/init': () => ({ dialog: '${dialog}', params: JSON.parse(JSON.stringify(PARAMS)) }),

    'unstashDialog/files': (p) => (p.index === 0
      ? [ { path: 'src/app.ts', status: 'M' }, { path: 'src/new.ts', status: 'A' } ]
      : [ { path: 'docs/old.md', status: 'M' } ]),
    'unstashDialog/fileDiff': (p) => (p.relPath === 'src/app.ts'
      ? {
          path: p.relPath,
          originalText: 'one\\ntwo\\nthree\\n',
          modifiedText: 'one\\nSTASHED\\nthree\\n',
          changes: [{ originalStartLineNumber: 2, originalEndLineNumber: 2, modifiedStartLineNumber: 2, modifiedEndLineNumber: 2 }],
          wholeFileOnly: false,
        }
      : { path: p.relPath, originalText: '', modifiedText: '', changes: [], wholeFileOnly: true }),

    'patchDialog/choose': () => Object.assign({}, BASE, JSON.parse(JSON.stringify(CHOSEN_PATCH))),
    'patchDialog/inspect': (p) => Object.assign({}, BASE, JSON.parse(JSON.stringify(CHOSEN_PATCH)), { patchPath: p.patchPath }),

    'cloneDialog/browse': () => ({ directory: 'D:/work/picked' }),
    'cloneDialog/checkDirectory': (p) => (String(p.directory).includes('busy')
      ? { ok: false, reason: 'Directory is not empty (3 entries).' }
      : { ok: true }),

    'remotesDialog/save': (p) => {
      const after = p.after;
      if (p.before) {
        remoteRows = remoteRows.map((r) => (r.name === p.before.name ? JSON.parse(JSON.stringify(after)) : r));
      } else {
        if (remoteRows.some((r) => r.name === after.name)) {
          return { ok: false, message: 'A remote named "' + after.name + '" already exists.', remotes: remoteRows };
        }
        remoteRows = remoteRows.concat([JSON.parse(JSON.stringify(after))]);
      }
      return { ok: true, remotes: remoteRows };
    },
    'remotesDialog/remove': (p) => {
      remoteRows = remoteRows.filter((r) => r.name !== p.name);
      return { ok: true, remotes: remoteRows };
    },
    'remotesDialog/prune': () => ({ ok: true, remotes: remoteRows }),
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
