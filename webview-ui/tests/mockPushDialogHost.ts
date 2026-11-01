/**
 * Mock host for the Push dialog (P13-T1; IntelliJ's layout since POST-P14ao).
 * Same routing contract as `mockShelveDialogHost`: requests reach `handlers`,
 * `dialog/accept` and `dialog/cancel` are events recorded in
 * `__postedMessages` so the specs assert the exact payload `dialogHost` would
 * resolve with.
 *
 * `window.__gtPushScenario`, set by an init script registered before this
 * one, picks the dialog: `single` (default), `multi` (two repositories),
 * `noRemote`, `protected` (the target is `main`), `hooks` (a pre-push hook
 * exists), `many` (45 commits).
 *
 * `pushDialog/retarget` recomputes host-side in the real thing; here it
 * returns a commit list that visibly differs for a new branch, which proves
 * the webview adopts the response rather than patching its own copy.
 */
export const mockPushDialogHostScript = `
(() => {
  window.__gittreeInitialState = { dialog: 'push' };
  const scenario = window.__gtPushScenario || 'single';

  const commit = (sha, subject, at) => ({
    sha, subject, body: subject + '\\n\\nWhy it was done.', authorName: 'Ada', authorEmail: 'ada@example.com', authorTime: at,
  });
  const A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
  const C = 'cccccccccccccccccccccccccccccccccccccccc';
  const COMMITS = [commit(B, 'fix the lexer', 1700000100), commit(A, 'add the parser', 1700000000)];
  const FILES = {
    [A]: [{ status: 'M', path: 'src/main/java/util/Strings.java', before: A + '^', after: A }],
    [B]: [
      { status: 'A', path: 'src/main/java/api/Controller.java', after: B },
      { status: 'R', path: 'docs/notes.md', origPath: 'docs/old-notes.md', before: B + '^', after: B },
    ],
    [C]: [{ status: 'A', path: 'README.md', after: C }],
  };
  const REMOTE_BRANCHES = [
    { remote: 'origin', branch: 'main' },
    { remote: 'origin', branch: 'feature/x' },
    { remote: 'origin', branch: 'release/1.2' },
    { remote: 'upstream', branch: 'main' },
  ];
  const known = new Set(REMOTE_BRANCHES.map((r) => r.remote + '/' + r.branch));

  const branchSource = (b) => ({ kind: 'branch', presentation: b, revision: 'refs/heads/' + b, branch: b });
  const tracking = (remote, branch) => ({ remote, branch, isNew: false, type: 'tracking' });

  const demo = {
    root: 'D:/repos/demo-git',
    label: 'demo-git',
    source: branchSource('feature/x'),
    remotes: ['origin', 'upstream'],
    target: tracking('origin', 'feature/x'),
    defaultTarget: tracking('origin', 'feature/x'),
    sourceTracks: true,
    commits: COMMITS,
    remoteBranches: REMOTE_BRANCHES,
    recentTargets: [{ sourceBranch: 'feature/x', remote: 'origin', branch: 'review/x' }],
    checked: true,
  };

  let repos = [demo];
  if (scenario === 'multi') {
    repos = [
      demo,
      {
        root: 'D:/repos/lib-utils',
        label: 'lib-utils',
        source: branchSource('main'),
        remotes: ['origin'],
        target: tracking('origin', 'main'),
        defaultTarget: tracking('origin', 'main'),
        sourceTracks: true,
        commits: [commit(C, 'initial commit', 1699000000)],
        remoteBranches: [{ remote: 'origin', branch: 'main' }],
        recentTargets: [],
        checked: false,
      },
    ];
  } else if (scenario === 'noRemote') {
    repos = [{ ...demo, remotes: [], target: undefined, defaultTarget: undefined, sourceTracks: false, commits: [], remoteBranches: [], recentTargets: [] }];
    delete repos[0].target;
    delete repos[0].defaultTarget;
  } else if (scenario === 'protected') {
    repos = [{ ...demo, source: branchSource('main'), target: tracking('origin', 'main'), defaultTarget: tracking('origin', 'main') }];
  } else if (scenario === 'many') {
    const many = [];
    for (let i = 45; i >= 1; i--) many.push(commit(String(i).padStart(2, '0').repeat(20), 'commit ' + i, 1700000000 + i));
    repos = [{ ...demo, commits: many }];
  }

  const PARAMS = {
    title: repos.length === 1 ? 'Push Commits to ' + repos[0].label : 'Push Commits',
    repos,
    single: repos.length === 1,
    ...(repos.length === 1 ? { highlight: repos[0].root } : {}),
    tags: 'none',
    showRunHooks: scenario === 'hooks',
    showCommandLine: true,
    forceIfIncludes: true,
    protectedBranches: ['master', 'main'],
    silentForceTargets: [],
    ui: { showDetails: true, groupByDirectory: true, treeRatio: 0.5, detailsRatio: 0.67 },
    colors: {},
  };

  const clone = (v) => JSON.parse(JSON.stringify(v));
  const allCommits = [...COMMITS, commit(C, 'initial commit', 1699000000)];

  const handlers = {
    'dialog/init': () => ({ dialog: 'push', params: clone(PARAMS) }),
    'pushDialog/retarget': (p) => {
      const isNew = !known.has(p.remote + '/' + p.branch);
      // A brand-new target: everything the remote has nowhere, one commit more.
      return {
        target: { remote: p.remote, branch: p.branch, isNew, type: 'custom' },
        commits: clone(isNew ? allCommits : COMMITS),
      };
    },
    'pushDialog/changes': (p) => ({ files: clone(p.shas.flatMap((sha) => FILES[sha] || [])) }),
    'pushDialog/details': (p) => {
      const c = allCommits.find((x) => x.sha === p.sha);
      if (!c) return undefined;
      return {
        sha: c.sha, parents: [], authorName: c.authorName, authorEmail: c.authorEmail, authorTime: c.authorTime,
        committerName: c.authorName, committerEmail: c.authorEmail, committerTime: c.authorTime,
        signature: 'N', refs: [], body: c.body, files: [],
      };
    },
    'pushDialog/openDiff': () => ({ ok: true }),
    'pushDialog/openFile': () => ({ ok: true }),
    'pushDialog/saveUi': () => undefined,
    'pushDialog/defineRemote': (p) => {
      if (p.url === 'bad') return { ok: false, field: 'url', message: 'repository not found' };
      return {
        ok: true,
        repo: {
          ...clone(demo),
          remotes: [p.name],
          target: { remote: p.name, branch: 'feature/x', isNew: true, type: 'tracking' },
          defaultTarget: { remote: p.name, branch: 'feature/x', isNew: true, type: 'tracking' },
          sourceTracks: false,
          remoteBranches: [],
        },
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
      return state;
    },
    setState(s) {
      state = s;
    },
  };
  window.acquireVsCodeApi = () => api;
})();
`;
