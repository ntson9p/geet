/**
 * Mock host for the Push dialog (P13-T1). Same routing contract as
 * `mockShelveDialogHost`: requests reach `handlers`, `dialog/accept` and
 * `dialog/cancel` are events recorded in `__postedMessages` so the specs assert
 * the exact payload `dialogHost` would resolve with.
 *
 * `pushDialog/retarget` recomputes host-side in the real thing; here it returns
 * a section whose commit/file set visibly differs, which is what proves the
 * webview adopts the response rather than patching its own copy.
 */
export const mockPushDialogHostScript = `
(() => {
  window.__gittreeInitialState = { dialog: 'push' };

  const COMMITS = [
    { sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', subject: 'add the parser', authorName: 'Ada', authorTime: 1700000000 },
    { sha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', subject: 'fix the lexer', authorName: 'Ada', authorTime: 1700000100 },
  ];
  const FILES = [
    { status: 'M', path: 'src/main/java/util/Strings.java' },
    { status: 'A', path: 'src/main/java/api/Controller.java' },
    { status: 'R100', path: 'docs/notes.md', origPath: 'docs/old-notes.md' },
  ];

  const SECTION = {
    root: 'D:/repos/demo-git',
    label: 'demo-git',
    branch: 'feature/x',
    remotes: ['origin', 'upstream'],
    remote: 'origin',
    remoteBranch: 'feature/x',
    hasUpstream: true,
    targetExists: true,
    remoteBranchOptions: ['main', 'feature/x', 'release/1.2'],
    base: 'refs/remotes/origin/feature/x',
    commits: COMMITS,
    totalCommits: 2,
    files: FILES,
    checked: true,
  };

  const PARAMS = {
    repos: [SECTION],
    tags: 'none',
    runHooks: true,
    showCommandLine: true,
    forceIfIncludes: true,
    colors: {},
  };

  const clone = (v) => JSON.parse(JSON.stringify(v));

  const handlers = {
    'dialog/init': () => ({ dialog: 'push', params: clone(PARAMS) }),
    'pushDialog/retarget': (p) => {
      const next = clone(SECTION);
      next.remote = p.remote;
      next.remoteBranch = p.remoteBranch;
      // A brand-new target: nothing tracked yet, so the whole branch is outgoing.
      next.targetExists = false;
      next.hasUpstream = false;
      next.base = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
      next.commits = COMMITS.concat([
        { sha: 'cccccccccccccccccccccccccccccccccccccccc', subject: 'initial commit', authorName: 'Ada', authorTime: 1699000000 },
      ]);
      next.totalCommits = 3;
      next.files = FILES.concat([{ status: 'A', path: 'README.md' }]);
      return next;
    },
    'pushDialog/openDiff': () => ({ ok: true }),
    'pushDialog/openFile': () => ({ ok: true }),
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
        const raw = sessionStorage.getItem('gt-mock-push-state');
        state = raw ? JSON.parse(raw) : undefined;
      }
      return state;
    },
    setState(s) {
      state = s;
      sessionStorage.setItem('gt-mock-push-state', JSON.stringify(s));
    },
  };
  window.acquireVsCodeApi = () => api;
})();
`;
