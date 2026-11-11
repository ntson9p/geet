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
  // The real message store is workspaceState, which survives a webview reload —
  // so the mock's must too, or reload tests prove nothing.
  let message = sessionStorage.getItem('gt-mock-message') || '';
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

  // P11-T6: shelf fixture — one healthy entry, one damaged, one already
  // unshelved (hidden until the eye toggle).
  const shelfEntries = [
    {
      id: 'shelf-1', name: 'feature work', comment: '', createdAt: Date.now() - 7200e3,
      branch: 'main', baseShort: 'abcd1234',
      files: [
        { relPath: 'src/alpha.ts', status: 'modified', isBinary: false },
        { relPath: 'assets/logo.png', status: 'added', isBinary: true },
      ],
      valid: true, unshelved: false,
    },
    {
      id: 'shelf-2', name: 'tampered entry', comment: '', createdAt: Date.now() - 86400e3,
      branch: 'main', baseShort: 'ffff0000',
      files: [{ relPath: 'src/beta.ts', status: 'modified', isBinary: false }],
      valid: false, unshelved: false,
    },
    {
      id: 'shelf-3', name: 'applied earlier', comment: '', createdAt: Date.now() - 172800e3,
      branch: 'dev', baseShort: '99990000',
      files: [{ relPath: 'src/gamma.ts', status: 'deleted', isBinary: false }],
      valid: true, unshelved: true,
    },
  ];
  let showUnshelved = false;

  function buildShelf() {
    return {
      repos: [{
        root: REPO, label: 'demo-git',
        entries: shelfEntries.filter((e) => showUnshelved || !e.unshelved),
      }],
      showUnshelved: showUnshelved,
    };
  }

  // POST-P14l: stash fixture — two stashes, files served lazily per sha.
  // window.__mockCombineStashes flips IntelliJ's combine setting.
  const stashEntries = [
    {
      sha: 'aaaa1111'.repeat(5), index: 0, selector: 'stash@{0}',
      message: 'WIP on main: 1a2b3c retry backoff', branch: 'main',
      createdAt: Date.now() - 3600e3,
    },
    {
      sha: 'bbbb2222'.repeat(5), index: 1, selector: 'stash@{1}',
      message: 'On dev: exporter spike', branch: 'dev',
      createdAt: Date.now() - 86400e3,
    },
  ];
  const stashFiles = {
    ['aaaa1111'.repeat(5)]: [
      { relPath: 'src/retry.ts', status: 'modified' },
      { relPath: 'src/new-file.ts', status: 'untracked' },
    ],
    ['bbbb2222'.repeat(5)]: [{ relPath: 'src/exporter.ts', status: 'added' }],
  };

  function buildStash() {
    return {
      repos: [{ root: REPO, label: 'demo-git', entries: stashEntries }],
      combined: window.__mockCombineStashes === true,
    };
  }

  function pushStash() {
    window.postMessage(
      { v: 1, id: 'st' + Math.random(), kind: 'evt', method: 'commit/stash', params: buildStash() },
      '*'
    );
  }

  function pushShelf() {
    window.postMessage(
      { v: 1, id: 's' + Math.random(), kind: 'evt', method: 'commit/shelf', params: buildShelf() },
      '*'
    );
  }

  // P11-T5: gear popup state.
  const options = {
    repoRoot: REPO,
    author: '',
    authorSuggestions: ['Ada Lovelace <ada@example.com>', 'Đặng Trần Côn <dtc@example.jp>'],
    signoff: false,
    // Every check starts unticked (D38), as package.json says.
    checks: { reformat: false, optimizeImports: false, cleanup: false, analyze: false, todo: false },
    analyzeSeverity: 'error',
    todoPattern: '\\\\b(TODO|FIXME)\\\\b',
    cleanupKind: 'source.fixAll',
    deferAdvanced: true,
  };

  function decorate(c) {
    const copy = Object.assign({}, c);
    const sel = included.get(c.path);
    if (sel) copy.partial = { total: DIFF_CHANGES.length, included: sel.length };
    return copy;
  }

  // Opt-in (window.__mockSecondRepo): a second repository, so the tree grows
  // its repository rows. Read-only: nothing below acts on it.
  const SECOND = 'D:/repos/demo-lib';
  function secondRepo() {
    return {
      root: SECOND,
      label: 'demo-lib',
      colorIdx: 1,
      // Published nowhere: its label's hover names no upstream.
      head: { branch: 'feature/login', sha: 'b98e7e5a1c' },
      groups: [
        {
          id: 'default', name: 'Changes', isActive: true, isDefault: true, checkable: true,
          changes: [{ path: 'lib/index.ts', code: '.M', kind: 'modified', checked: false }],
        },
        {
          id: '__unversioned__', name: 'Unversioned Files', isActive: false, isDefault: false,
          checkable: true,
          changes: [{ path: 'lib/notes.txt', code: '??', kind: 'untracked', checked: false }],
        },
      ],
    };
  }

  // gittree.commit.groupBy. Opt-in start (window.__mockGroupBy), read when first
  // asked so an init script can set it; View Options writes it as the host does.
  let groupBy;
  function currentGroupBy() {
    if (groupBy === undefined) groupBy = window.__mockGroupBy === 'repository' ? 'repository' : 'changelist';
    return groupBy;
  }

  function build() {
    return {
      repos: [
        {
          root: REPO,
          label: 'demo-git',
          // The host's rootColorIndices slot; the first root in path order.
          colorIdx: 0,
          head: { branch: 'main', sha: 'a1b2c3d4e5', upstream: 'origin/main' },
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
      ].concat(window.__mockSecondRepo === true ? [secondRepo()] : []),
      activeRepo: REPO,
      // The real host lists the repos a commit would touch; with one repo that
      // is either it or nothing, and the button label follows.
      targets:
        changes.some((c) => c.checked) || unversioned.some((c) => c.checked) ? ['demo-git'] : [],
      message: message,
      amend: amend,
      signing: false,
      busy: false,
      modifiedCount: changes.length + unversioned.length,
      checkedCount:
        changes.filter((c) => c.checked).length + unversioned.filter((c) => c.checked).length,
      paradigm: 'changelists',
      // P11-T8: one override so specs can see it win; the rest follow the theme.
      colors: { modified: '#ff8800' },
      // gittree.log.graphPalette, which the repositories' colours follow.
      palette: window.__mockGraphPalette === 'colorBlind' ? 'colorBlind' : 'default',
      groupBy: currentGroupBy(),
    };
  }

  function push() {
    window.postMessage(
      { v: 1, id: 'h' + Math.random(), kind: 'evt', method: 'commit/state', params: build() },
      '*'
    );
  }

  // P11-T4: programmatic message writes travel on their own event; the webview
  // deliberately ignores state.message after init (see COMMIT_METHODS.evtMessage).
  function pushMessage() {
    window.postMessage(
      {
        v: 1, id: 'm' + Math.random(), kind: 'evt', method: 'commit/message',
        params: { repoRoot: REPO, message: message },
      },
      '*'
    );
  }

  function fileOf(path) {
    return changes.concat(unversioned).find((c) => c.path === path);
  }

  const handlers = {
    'commit/init': () => build(),
    'commit/refresh': () => { setTimeout(push, 5); },
    // The host saves it to the workspace setting, whose change pushes the state.
    'commit/setGroupBy': (p) => {
      if (p.groupBy !== 'changelist' && p.groupBy !== 'repository') return;
      groupBy = p.groupBy;
      setTimeout(push, 5);
    },
    'commit/setChecked': (p) => {
      const wanted = new Set(p.paths);
      for (const c of changes.concat(unversioned)) {
        if (wanted.has(c.path)) c.checked = p.checked;
      }
      if (!p.checked) for (const path of p.paths) included.delete(path);
      setTimeout(push, 5);
    },
    'commit/setMessage': (p) => {
      message = p.message;
      sessionStorage.setItem('gt-mock-message', p.message);
    },
    'commit/toggleAmend': () => {
      amend = !amend;
      if (amend && message.trim().length === 0) {
        message = 'previous subject';
        setTimeout(pushMessage, 5);
      }
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
    // POST-P14bq: the host opens the file manager; receiving it is enough.
    'commit/reveal': () => undefined,
    // POST-P14bq: the host sets gittree.commitTreeFocus; receiving it is enough.
    'commit/treeFocus': () => undefined,
    'commit/diffChain': () => undefined,
    'commit/rollback': () => undefined,
    'commit/shelve': () => undefined,
    // P11-T5: gear popup state, routed like the real applyOption — an invalid
    // author is a handler throw, which the router turns into an RPC error.
    'commit/options': () => JSON.parse(JSON.stringify(options)),
    'commit/setOption': (p) => {
      const o = p.option;
      if (o.kind === 'author') {
        if (o.value.length > 0 && !/^[^<>]*[^<>\\s][^<>]*\\s<[^<>\\s@]+@[^<>\\s]+>$/.test(o.value)) {
          throw new Error('Author must look like: Name <email@example.com>');
        }
        options.author = o.value;
      } else if (o.kind === 'signoff') options.signoff = o.value;
      else if (o.kind === 'check') options.checks[o.id] = o.value;
      else if (o.kind === 'analyzeSeverity') options.analyzeSeverity = o.value;
      else if (o.kind === 'todoPattern') options.todoPattern = o.value;
      else if (o.kind === 'cleanupKind') options.cleanupKind = o.value;
      else if (o.kind === 'deferAdvanced') options.deferAdvanced = o.value;
    },
    // POST-P14l: the Stash tab.
    'commit/stashState': () => buildStash(),
    'commit/stashFiles': (p) => ({ files: stashFiles[p.sha] || [] }),
    'commit/stashAction': (p) => {
      window.__stashActions = window.__stashActions || [];
      window.__stashActions.push(p);
      if (p.action === 'drop') {
        const at = stashEntries.findIndex((e) => e.sha === p.sha);
        if (at >= 0) stashEntries.splice(at, 1);
        setTimeout(pushStash, 5);
      }
      // The rest open host-side UI; receiving them is enough.
    },
    // P11-T6: the Shelf tab.
    'commit/shelfState': () => buildShelf(),
    'commit/shelfAction': (p) => {
      if (p.action === 'toggleShowUnshelved') {
        showUnshelved = !showUnshelved;
        setTimeout(pushShelf, 5);
        return;
      }
      if (p.action === 'delete' || p.action === 'unshelveSilently') {
        const at = shelfEntries.findIndex((e) => e.id === p.id);
        const entry = shelfEntries[at];
        if (entry && !entry.valid) throw new Error('changes.patch does not match its recorded sha256');
        if (at >= 0) shelfEntries.splice(at, 1);
        setTimeout(pushShelf, 5);
      }
      // The remaining actions open host-side UI; receiving them is enough.
    },
    // P11-T4: data behind the in-webview history and Amend dropdowns.
    'commit/messageHistory': () => ({
      entries: [
        { message: 'fix: adjust retry backoff\\n\\nDoubles the base delay.', ts: Date.now() - 3600e3 },
        { message: 'feat: add exporters', ts: Date.now() - 86400e3 },
      ],
    }),
    'commit/recentCommits': () => ({
      commits: [
        {
          sha: 'a1b2c3d4'.repeat(5), shortSha: 'a1b2c3d4',
          subject: 'previous subject', message: 'previous subject\\n\\nBody of the last commit.',
        },
        { sha: 'e5f6a7b8'.repeat(5), shortSha: 'e5f6a7b8', subject: 'older subject', message: 'older subject' },
      ],
    }),
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
      const deliver = () => window.postMessage(response, '*');
      // Opt-in (window.__mockHoldRefresh): Refresh is answered only when the
      // test calls window.__releaseRefresh(), as a slow re-read would be.
      if (msg.method === 'commit/refresh' && window.__mockHoldRefresh === true) {
        window.__releaseRefresh = () => setTimeout(deliver, 5);
        return;
      }
      setTimeout(deliver, 5);
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
