import { describe, expect, it } from 'vitest';
import type {
  BranchPanelDetailsDto,
  BranchPanelRefDto,
  BranchPanelRepoDto,
  BranchPanelStateDto,
} from '../../../src/shared/protocol';
import {
  buildEntries,
  buildPanel,
  CARD_BUTTONS,
  CARD_LINE,
  CARD_PAD,
  cardGroups,
  cardHeight,
  cardLines,
  collapsedAll,
  compareTags,
  entryKey,
  groupLabel,
  HINT,
  isPlausibleBranchName,
  longAge,
  matchRanges,
  queryTokens,
  quickActions,
  recentEntries,
  relationShort,
  relationText,
  remoteTwin,
  repoHint,
  repositoryActionsPanel,
  ROW,
  scopeReposOf,
  SHORT_WHERE,
  shortAge,
  shownTab,
  TABS,
  TABS_ID,
  tabsLabel,
  tabTitle,
  targetOf,
  trackingShort,
  trackingText,
  upstreamElsewhere,
  viewActions,
  whereOf,
  type BranchEntry,
  type BranchTab,
  type CardLine,
  type PanelRow,
  type PanelUiState,
} from '../../../webview-ui/src/branches/model';
import {
  eligibleRepos,
  formProblem,
  fromText,
  startPointNote,
  startPoints,
  trackingNote,
} from '../../../webview-ui/src/branches/newBranch';

const NOW = 1_800_000_000;

function ref(name: string, extra: Partial<BranchPanelRefDto> = {}): BranchPanelRefDto {
  return { name, sha: `${name}-sha`, date: NOW - 3600, subject: `on ${name}`, ...extra };
}

function repo(root: string, extra: Partial<BranchPanelRepoDto> = {}): BranchPanelRepoDto {
  return {
    root,
    label: root.slice(1),
    colorIdx: 0,
    detached: false,
    unborn: false,
    changes: 0,
    fetching: false,
    locals: [],
    remotes: [],
    tags: [],
    recent: [],
    favorites: [],
    merged: [],
    ...extra,
  };
}

function state(repos: BranchPanelRepoDto[], extra: Partial<BranchPanelStateDto> = {}): BranchPanelStateDto {
  return {
    repos,
    showTags: true,
    showInOut: true,
    groupByFolder: true,
    showRepositoryDots: false,
    fetchingAll: false,
    now: NOW,
    palette: 'default',
    ...extra,
  };
}

function ui(extra: Partial<PanelUiState> = {}): PanelUiState {
  return { query: '', scope: [], toggled: new Set(), ...extra };
}

const kinds = (rows: readonly PanelRow[]) => rows.map((r) => r.kind);
const ids = (rows: readonly PanelRow[]) => rows.map((r) => r.id);

const web = repo('/web', {
  head: 'feature/login',
  colorIdx: 0,
  locals: [
    ref('feature/login', { current: true, upstream: 'origin/feature/login', ahead: 2 }),
    ref('main', { upstream: 'origin/main', behind: 4 }),
    ref('develop', { upstream: 'origin/develop' }),
    ref('bugfix/header'),
  ],
  remotes: [
    ref('origin/main', { remote: 'origin' }),
    ref('origin/feature/login', { remote: 'origin' }),
    ref('upstream/main', { remote: 'upstream' }),
  ],
  tags: [ref('v1.0', { date: NOW - 90 * 86400 }), ref('v1.1', { date: NOW - 30 * 86400 })],
  recent: ['develop', 'main'],
  favorites: ['develop'],
  merged: ['bugfix/header'],
  mainBranch: 'origin/main',
});
const api = repo('/api', {
  head: 'main',
  colorIdx: 1,
  locals: [ref('main', { current: true, upstream: 'origin/main', ahead: 1 }), ref('develop')],
  remotes: [ref('origin/main', { remote: 'origin' })],
  recent: ['develop'],
});

describe('buildEntries: one entry per name, across repositories', () => {
  it('merges a name into one entry with a presence per repository', () => {
    const entries = buildEntries([api, web], 'local');
    const main = entries.find((e) => e.name === 'main')!;
    expect(main.presence.map((p) => p.repo.root)).toEqual(['/api', '/web']);
    expect(main.currentIn).toEqual(['/api']);
    expect(main.ahead).toBe(1);
    expect(main.behind).toBe(4);
    expect(main.key).toBe(entryKey('local', 'main'));
  });

  it('is starred if starred anywhere, merged only if merged everywhere', () => {
    const entries = buildEntries([api, web], 'local');
    expect(entries.find((e) => e.name === 'develop')!.favorite).toBe(true);
    expect(entries.find((e) => e.name === 'bugfix/header')!.merged).toBe(true);
    const both = buildEntries(
      [repo('/a', { locals: [ref('x')], merged: ['x'] }), repo('/b', { locals: [ref('x')] })],
      'local',
    );
    expect(both[0]!.merged).toBe(false);
  });

  it('is unpublished only when no repository tracks it; gone when any lost its upstream', () => {
    const entries = buildEntries(
      [
        repo('/a', { locals: [ref('x', { upstream: 'origin/x', gone: true })] }),
        repo('/b', { locals: [ref('x')] }),
      ],
      'local',
    );
    expect(entries[0]!.gone).toBe(true);
    expect(entries[0]!.unpublished).toBe(false);
  });

  it('takes the newest tip for its date and subject', () => {
    const entries = buildEntries(
      [
        repo('/a', { locals: [ref('x', { date: 100, subject: 'old' })] }),
        repo('/b', { locals: [ref('x', { date: 200, subject: 'new' })] }),
      ],
      'local',
    );
    expect(entries[0]!.date).toBe(200);
    expect(entries[0]!.subject).toBe('new');
  });

  it('targets every repository it is in', () => {
    const main = buildEntries([api, web], 'local').find((e) => e.name === 'main')!;
    expect(targetOf(main)).toEqual({ kind: 'local', name: 'main', roots: ['/api', '/web'] });
  });
});

describe('a branch tracking a remote branch of another name', () => {
  const remotes = [
    ref('origin/develop', { remote: 'origin' }),
    ref('origin/feature/x', { remote: 'origin' }),
    ref('team/eu/feature/x', { remote: 'team/eu' }),
  ];

  it('is named on its entry: its pushes go there', () => {
    const [mine] = buildEntries(
      [repo('/a', { remotes, locals: [ref('mine', { upstream: 'origin/develop', ahead: 1 })] })],
      'local',
    );
    expect(mine!.tracksElsewhere).toBe('origin/develop');
  });

  it('is not one that tracks its own name, nothing, or something deleted', () => {
    const entries = buildEntries(
      [
        repo('/a', {
          remotes,
          locals: [
            ref('develop', { upstream: 'origin/develop' }),
            ref('feature/x', { upstream: 'team/eu/feature/x' }),
            ref('untracked'),
            ref('old', { upstream: 'origin/develop', gone: true }),
          ],
        }),
      ],
      'local',
    );
    for (const entry of entries) expect(entry.tracksElsewhere, entry.name).toBeUndefined();
  });

  it('is said of the entry if any repository has it so', () => {
    const [x] = buildEntries(
      [
        repo('/a', { remotes, locals: [ref('x', { upstream: 'origin/x' })] }),
        repo('/b', { remotes, locals: [ref('x', { upstream: 'origin/develop' })] }),
      ],
      'local',
    );
    expect(x!.tracksElsewhere).toBe('origin/develop');
  });

  it('reads a remote the refs do not list by its first segment', () => {
    // A remote branch not fetched here, or a branch tracking a local one.
    const r = repo('/a');
    expect(upstreamElsewhere(r, 'x', 'origin/x', false)).toBeUndefined();
    expect(upstreamElsewhere(r, 'x', 'origin/y', false)).toBe('origin/y');
    expect(upstreamElsewhere(r, 'x', 'main', undefined)).toBe('main');
    expect(upstreamElsewhere(r, 'x', undefined, undefined)).toBeUndefined();
  });

  it('is never said of a remote branch or a tag', () => {
    const [remote] = buildEntries([repo('/a', { remotes: [ref('origin/x', { remote: 'origin' })] })], 'remote');
    expect(remote!.tracksElsewhere).toBeUndefined();
  });
});

describe('a branch tracking nothing', () => {
  const remotes = [ref('origin/develop', { remote: 'origin' })];

  it('is unpublished only when the remote has no branch of its name', () => {
    const r = repo('/a', { remotes });
    expect(remoteTwin(r, 'develop')).toBe('origin/develop');
    expect(remoteTwin(r, 'mine')).toBeUndefined();
    expect(trackingText(ref('develop'), 'local', undefined, 'origin/develop')).toBe('Not tracking origin/develop');
    expect(trackingText(ref('mine'), 'local')).toBe('Not published');
    expect(trackingShort(ref('develop'), 'local', undefined, 'origin/develop')).toBe('not tracking');
    expect(trackingShort(ref('mine'), 'local')).toBe('not published');
  });
});

describe('recentEntries', () => {
  it('lists the starred, then each repository’s recent ones a rank at a time', () => {
    const locals = new Map(buildEntries([api, web], 'local').map((e) => [e.key, e]));
    expect(recentEntries([api, web], locals).map((e) => e.name)).toEqual(['develop', 'main']);
  });

  it('leaves out a branch checked out everywhere it exists', () => {
    const only = repo('/x', {
      locals: [ref('a', { current: true }), ref('b')],
      recent: ['a', 'b'],
    });
    const locals = new Map(buildEntries([only], 'local').map((e) => [e.key, e]));
    expect(recentEntries([only], locals).map((e) => e.name)).toEqual(['b']);
  });

  it('keeps every starred branch but at most eight recent ones', () => {
    const names = Array.from({ length: 12 }, (_, i) => `r${i}`);
    const big = repo('/x', {
      locals: [...names.map((n) => ref(n)), ref('s1'), ref('s2')],
      recent: names,
      favorites: ['s1', 's2'],
    });
    const locals = new Map(buildEntries([big], 'local').map((e) => [e.key, e]));
    const out = recentEntries([big], locals).map((e) => e.name);
    expect(out.slice(0, 2)).toEqual(['s1', 's2']);
    expect(out.length).toBe(10);
  });
});

describe('buildPanel: one repository', () => {
  const model = buildPanel(state([web]), ui());
  const onTab = (tab: BranchTab, extra: Partial<PanelUiState> = {}) =>
    buildPanel(state([web]), ui({ tab, ...extra }));
  const names = (rows: readonly PanelRow[]) => rows.flatMap((r) => (r.kind === 'branch' ? [r.entry.name] : []));

  it('starts with the current branch, then the tabs over its branches', () => {
    expect(model.multi).toBe(false);
    expect(model.markers).toBe(false);
    const first = model.rows[0]!;
    expect(first.kind).toBe('head');
    if (first.kind === 'head') expect(first.entry?.name).toBe('feature/login');
    expect(model.rows[1]).toMatchObject({ kind: 'tabs', id: TABS_ID, height: TABS });
    // Recent, Local, Remote and Tags are tabs now, never headings stacked one under another.
    expect(model.rows.some((r) => r.kind === 'section')).toBe(false);
  });

  it('is one list, the current branch at its head: there is nothing to split with one repository', () => {
    expect(kinds(model.repoRows)).toEqual(['head']);
    expect(model.branchRows[0]).toMatchObject({ kind: 'tabs', id: TABS_ID });
    expect(model.rows).toEqual([...model.repoRows, ...model.branchRows]);
  });

  it('counts each kind on its tab', () => {
    const tabs = model.rows[1]!;
    expect(tabs.kind === 'tabs' && tabs.tabs.map((t) => [t.id, t.label, t.count])).toEqual([
      ['recent', 'Recent', 2],
      ['local', 'Local', 4],
      ['remote', 'Remote', 3],
      ['tags', 'Tags', 2],
    ]);
  });

  it('opens on Recent, and lists only what that tab holds', () => {
    expect(model.tab).toBe('recent');
    expect(model.rows[1]?.kind === 'tabs' && model.rows[1].active).toBe('recent');
    const recent = model.rows.filter((r) => r.kind === 'branch');
    expect(recent.map((r) => (r.kind === 'branch' ? [r.section, r.entry.name] : []))).toEqual([
      ['recent', 'develop'],
      ['recent', 'main'],
    ]);
    expect(model.rows.some((r) => r.kind === 'folder' || r.kind === 'remote')).toBe(false);
  });

  it('opens on Local when nothing is recent; Recent picked says why it is empty', () => {
    const quiet = repo('/quiet', { head: 'main', locals: [ref('main', { current: true }), ref('spare')] });
    expect(buildPanel(state([quiet]), ui()).tab).toBe('local');
    const picked = buildPanel(state([quiet]), ui({ tab: 'recent' }));
    expect(picked.tab).toBe('recent');
    expect(picked.rows.at(-1)).toMatchObject({ kind: 'hint', id: 'hint:recent' });
  });

  it('says so when a tab has nothing in it', () => {
    const bare = repo('/bare', { head: 'main', locals: [ref('main', { current: true })] });
    expect(buildPanel(state([bare]), ui({ tab: 'remote' })).rows.at(-1)).toMatchObject({
      kind: 'hint',
      text: 'No remote branches.',
    });
    expect(buildPanel(state([bare]), ui({ tab: 'tags' })).rows.at(-1)).toMatchObject({ kind: 'hint', text: 'No tags.' });
    const unborn = repo('/new', { unborn: true });
    expect(buildPanel(state([unborn]), ui({ tab: 'local' })).rows.at(-1)).toMatchObject({
      kind: 'hint',
      text: 'No branches yet: the first commit creates one.',
    });
  });

  it('folds Local into folders, and opens the folder holding the current branch', () => {
    const local = onTab('local');
    const feature = local.rows.find((r) => r.kind === 'folder' && r.label === 'feature');
    const bugfix = local.rows.find((r) => r.kind === 'folder' && r.label === 'bugfix');
    expect(feature?.kind === 'folder' && feature.open).toBe(true);
    expect(bugfix?.kind === 'folder' && bugfix.open).toBe(false);
    const login = local.rows.find((r) => r.kind === 'branch' && r.section === 'local' && r.entry.name === 'feature/login');
    expect(login?.kind === 'branch' && login.label).toBe('login');
    expect(login?.kind === 'branch' && login.depth).toBe(1);
    // Starred first, then by name.
    expect(names(local.rows)).toEqual(['feature/login', 'develop', 'main']);
  });

  it('shows whole names, prefix dimmed, in Recent', () => {
    const withPrefix = buildPanel(state([{ ...web, favorites: ['bugfix/header'] }]), ui());
    const header = withPrefix.rows.find((r) => r.kind === 'branch' && r.entry.name === 'bugfix/header');
    expect(header?.kind === 'branch' && [header.prefix, header.label, header.depth]).toEqual(['bugfix/', 'header', 0]);
  });

  it('lists every name flat when folders are off', () => {
    const flat = buildPanel(state([web], { groupByFolder: false }), ui({ tab: 'local' }));
    expect(flat.rows.some((r) => r.kind === 'folder')).toBe(false);
    const bugfix = flat.rows.find((r) => r.kind === 'branch' && r.section === 'local' && r.entry.name === 'bugfix/header');
    expect(bugfix?.kind === 'branch' && [bugfix.prefix, bugfix.label]).toEqual(['bugfix/', 'header']);
  });

  it('groups Remote by remote, each open until shut', () => {
    const remote = onTab('remote');
    expect(remote.rows.filter((r) => r.kind === 'remote').map((r) => (r.kind === 'remote' ? r.remote : ''))).toEqual([
      'origin',
      'upstream',
    ]);
    // feature/ under origin holds no checked-out branch, so it starts shut.
    expect(remote.rows.find((r) => r.id === 'dir:remote:origin:feature/')).toMatchObject({ kind: 'folder', open: false });
    expect(names(remote.rows)).toEqual(['origin/main', 'upstream/main']);
    const shut = onTab('remote', { toggled: new Set(['rem:origin']) });
    expect(names(shut.rows)).toEqual(['upstream/main']);
  });

  it('lists Tags newest first', () => {
    expect(names(onTab('tags').rows)).toEqual(['v1.1', 'v1.0']);
  });

  it('a toggle flips what a node does by default', () => {
    const toggled = onTab('local', { toggled: new Set(['dir:local:feature/', 'dir:local:bugfix/']) });
    const feature = toggled.rows.find((r) => r.id === 'dir:local:feature/');
    const bugfix = toggled.rows.find((r) => r.id === 'dir:local:bugfix/');
    expect(feature?.kind === 'folder' && feature.open).toBe(false);
    expect(bugfix?.kind === 'folder' && bugfix.open).toBe(true);
  });

  it('opens a card under the row it belongs to, and sizes it', () => {
    const id = 'br:local:local:main';
    const withCard = onTab('local', { openCard: id });
    const row = withCard.rows.find((r) => r.id === id);
    expect(row?.kind === 'branch' && row.card).toBe(true);
    expect(row?.height).toBe(ROW + CARD_PAD + 3 * CARD_LINE + CARD_BUTTONS);
  });
});

describe('the tabs over the branch list', () => {
  it('show the tab picked; with none, Recent while anything is recent, else Local', () => {
    expect(shownTab('remote', 3, true)).toBe('remote');
    expect(shownTab(undefined, 3, true)).toBe('recent');
    expect(shownTab(undefined, 0, true)).toBe('local');
    expect(shownTab('recent', 0, true)).toBe('recent');
  });

  it('leave Tags out while tags are hidden, and show Local in its place', () => {
    expect(shownTab('tags', 3, false)).toBe('local');
    const hidden = buildPanel(state([web], { showTags: false }), ui({ tab: 'tags' }));
    const tabs = hidden.rows.find((r) => r.kind === 'tabs');
    expect(tabs?.kind === 'tabs' && tabs.tabs.map((t) => t.id)).toEqual(['recent', 'local', 'remote']);
    expect(hidden.tab).toBe('local');
    expect(hidden.rows.some((r) => r.kind === 'branch' && r.entry.kind === 'tag')).toBe(false);
  });

  it('count what each holds in their hover, one or many', () => {
    expect(tabTitle({ id: 'local', label: 'Local', count: 18 })).toBe('18 local branches');
    expect(tabTitle({ id: 'remote', label: 'Remote', count: 1 })).toBe('1 remote branch');
    expect(tabTitle({ id: 'recent', label: 'Recent', count: 5 })).toBe('5 recent branches');
    expect(tabTitle({ id: 'tags', label: 'Tags', count: 1 })).toBe('1 tag');
    expect(tabTitle({ id: 'tags', label: 'Tags', count: 6 })).toBe('6 tags');
  });

  it('tell a screen reader which tab is shown, where it sits, and how to move', () => {
    const local = buildPanel(state([web]), ui({ tab: 'local' }));
    const tabs = local.rows.find((r) => r.kind === 'tabs');
    expect(tabs?.kind === 'tabs' && tabsLabel(tabs)).toBe('Local tab, 2 of 4. Left and Right switch.');
  });

  it('head the branches’ own list when there are several repositories, under theirs', () => {
    const multi = buildPanel(state([api, web]), ui());
    expect(kinds(multi.repoRows)).toEqual(['repo', 'repo']);
    expect(multi.branchRows[0]).toMatchObject({ kind: 'tabs', id: TABS_ID });
    expect(multi.rows).toEqual([...multi.repoRows, ...multi.branchRows]);
  });

  it('step aside while the filter searches every kind, whatever tab is picked', () => {
    const searching = buildPanel(state([web]), ui({ query: 'log', tab: 'tags' }));
    expect(searching.rows.some((r) => r.kind === 'tabs')).toBe(false);
    expect(searching.tab).toBe('tags');
    const hits = searching.rows.flatMap((r) => (r.kind === 'branch' ? [r.entry.name] : []));
    expect(hits).toEqual(['feature/login', 'origin/feature/login']);
  });
});

describe('Collapse All', () => {
  it('shuts every folder and remote in view, opened by hand or by default', () => {
    // bugfix/ opened by hand; feature/ open by default, holding the current branch.
    const toggled = new Set(['dir:local:bugfix/']);
    const local = buildPanel(state([web]), ui({ tab: 'local', toggled }));
    const after = buildPanel(state([web]), ui({ tab: 'local', toggled: collapsedAll(local.rows, toggled) }));
    const folders = after.rows.flatMap((r) => (r.kind === 'folder' ? [[r.label, r.open]] : []));
    expect(folders).toEqual([
      ['bugfix', false],
      ['feature', false],
    ]);
  });

  it('leaves alone what is out of view, in another tab', () => {
    const remote = buildPanel(state([web]), ui({ tab: 'remote' }));
    const toggled = collapsedAll(remote.rows, new Set(['dir:local:bugfix/']));
    expect([...toggled].sort()).toEqual(['dir:local:bugfix/', 'rem:origin', 'rem:upstream']);
  });
});

describe('buildPanel: several repositories', () => {
  const model = buildPanel(state([api, web]), ui());

  it('lists the repositories in a list of their own, with a banner under one in the middle of something', () => {
    const busy = repo('/busy', { operation: { kind: 'rebase', conflicts: 1 } });
    const withOp = buildPanel(state([api, busy, web]), ui());
    expect(kinds(withOp.repoRows)).toEqual(['repo', 'repo', 'operation', 'repo']);
    expect(model.multi).toBe(true);
    expect(model.markers).toBe(true);
  });

  it('heads them with the REPOSITORIES pane, not a row: no heading in either list', () => {
    expect(model.rows.some((r) => r.kind === 'section')).toBe(false);
  });

  it('keeps every repository’s row while the pane is folded: the pane hides them, the model does not', () => {
    const folded = buildPanel(state([api, web]), ui({ toggled: new Set(['sec:repos', 'sec:branches']) }));
    expect(kinds(folded.repoRows)).toEqual(['repo', 'repo']);
    expect(folded.branchRows[0]).toMatchObject({ kind: 'tabs' });
  });

  it('searches the branches alone: the repositories stay as they are', () => {
    const searching = buildPanel(state([api, web]), ui({ query: 'main' }));
    expect(ids(searching.repoRows)).toEqual(ids(model.repoRows));
    expect(searching.branchRows[0]).toMatchObject({ kind: 'section', section: 'local' });
  });

  it('draws a name once, however many repositories have it', () => {
    const local = buildPanel(state([api, web]), ui({ tab: 'local' }));
    const mains = local.rows.filter((r) => r.kind === 'branch' && r.section === 'local' && r.entry.name === 'main');
    expect(mains).toHaveLength(1);
    // Recent too: the branch one repository used last beside the one another did.
    expect(model.rows.flatMap((r) => (r.kind === 'branch' ? [r.entry.name] : []))).toEqual(['develop', 'main']);
  });

  it('narrows to the scope, and drops the markers when one repository is left', () => {
    const narrowed = buildPanel(state([api, web]), ui({ scope: ['/api'], tab: 'local' }));
    expect(narrowed.scopeRepos.map((r) => r.root)).toEqual(['/api']);
    expect(narrowed.markers).toBe(false);
    const repos = narrowed.rows.filter((r) => r.kind === 'repo');
    expect(repos.map((r) => (r.kind === 'repo' ? [r.repo.root, r.inScope, r.narrowed, r.only] : []))).toEqual([
      ['/api', true, true, true],
      ['/web', false, true, false],
    ]);
    expect(narrowed.rows.some((r) => r.kind === 'branch' && r.entry.name === 'bugfix/header')).toBe(false);
  });

  it('says which repository the panel shows alone, and what a click on each row does (POST-P14bw)', () => {
    const shared = repo('/shared', { head: 'main', locals: [ref('main', { current: true })] });
    const three = [api, shared, web];
    const repoRowsOf = (scope: readonly string[]) =>
      buildPanel(state(three), ui({ scope })).repoRows.flatMap((r) => (r.kind === 'repo' ? [r] : []));
    const facts = (scope: readonly string[]) =>
      repoRowsOf(scope).map((r) => [r.repo.root, r.inScope, r.narrowed, r.only, repoHint(r)]);

    // Every repository shown: none alone, and a click (or Ctrl+click) shows only that one.
    expect(facts([])).toEqual([
      ['/api', true, false, false, 'Click to show only its branches'],
      ['/shared', true, false, false, 'Click to show only its branches'],
      ['/web', true, false, false, 'Click to show only its branches'],
    ]);
    // Shown alone: a second click shows every repository again.
    expect(facts(['/web'])).toEqual([
      ['/api', false, true, false, 'Click to show only its branches · Ctrl+click to add it'],
      ['/shared', false, true, false, 'Click to show only its branches · Ctrl+click to add it'],
      ['/web', true, true, true, 'Click to show every repository again'],
    ]);
    // Two picked: neither alone, so a click on one shows it alone; Ctrl+click leaves it out.
    expect(facts(['/web', '/api'])).toEqual([
      ['/api', true, true, false, 'Click to show only its branches · Ctrl+click to leave it out'],
      ['/shared', false, true, false, 'Click to show only its branches · Ctrl+click to add it'],
      ['/web', true, true, false, 'Click to show only its branches · Ctrl+click to leave it out'],
    ]);
  });

  it("the ⋯ menu's Update, Commit and Push follow what is in view (POST-P14bx, POST-P14by)", () => {
    const shared = repo('/shared', { head: 'main', locals: [ref('main', { current: true })] });
    const three = [api, shared, web];
    const scoped = (scope: readonly string[]) => buildPanel(state(three), ui({ scope })).scopeRepos;

    // Every repository in view: the project's, as Ctrl+T, Ctrl+K and Ctrl+Shift+K are.
    expect(viewActions(three, scoped([]))).toEqual({
      roots: [],
      project: true,
      update: 'Update Project…',
      updateWithoutFetch: 'Update Project Without Fetching…',
      commit: 'Commit…',
      push: 'Push…',
    });
    // One picked: that one, and the words say so (it was the project's words).
    expect(viewActions(three, scoped(['/web']))).toEqual({
      roots: ['/web'],
      project: false,
      update: 'Update Repository…',
      updateWithoutFetch: 'Update Repository Without Fetching…',
      commit: 'Commit Repository…',
      push: 'Push Repository…',
    });
    // Two of three: those two, in the panel's order (they were every repository).
    expect(viewActions(three, scoped(['/web', '/api']))).toEqual({
      roots: ['/api', '/web'],
      project: false,
      update: 'Update 2 Repositories…',
      updateWithoutFetch: 'Update 2 Repositories Without Fetching…',
      commit: 'Commit 2 Repositories…',
      push: 'Push 2 Repositories…',
    });
    // The workspace's only repository is the project.
    expect(viewActions([web], [web])).toMatchObject({ roots: [], project: true, commit: 'Commit…', push: 'Push…' });
  });

  it('the actions on every repository in view are the Repositories panel’s whenever it is there (POST-P14cq)', () => {
    // Fetch, and the ⋯'s Update, Commit and Push: with several repositories, the
    // Repositories panel's, where the pick they act on is made…
    expect(repositoryActionsPanel(2)).toBe('repositories');
    expect(repositoryActionsPanel(20)).toBe('repositories');
    // …and with one, which has no Repositories panel (`gittree.multiRepo`), or none
    // yet, the Branches panel's: exactly one panel has them, never both or neither.
    expect(repositoryActionsPanel(1)).toBe('branches');
    expect(repositoryActionsPanel(0)).toBe('branches');
    // The same line the model draws between one repository and several.
    expect(repositoryActionsPanel(state([api, web]).repos.length)).toBe('repositories');
    expect(buildPanel(state([api, web]), ui()).multi).toBe(true);
    expect(repositoryActionsPanel(state([web]).repos.length)).toBe('branches');
    expect(buildPanel(state([web]), ui()).multi).toBe(false);
  });

  it('a scope naming no open repository means every repository', () => {
    expect(scopeReposOf([api, web], ['/gone']).map((r) => r.root)).toEqual(['/api', '/web']);
  });

  it('sizes a card by what its repositories say', () => {
    const main = buildEntries([api, web], 'local').find((e) => e.name === 'main')!;
    // api has main checked out and one to push; web is four behind: two lines.
    const lines = cardLines(main, { markers: true, scopeRepos: [api, web] });
    expect(lines.map((l) => l.kind)).toEqual(['commit', 'group', 'group']);
    expect(cardHeight(lines)).toBe(CARD_PAD + 3 * CARD_LINE + CARD_BUTTONS);
  });
});

describe("buildPanel: the Repositories panel's filter (POST-P14cp)", () => {
  const busy = repo('/busy', { head: 'main', operation: { kind: 'rebase', conflicts: 1 } });
  const webApp = repo('/web-app', { head: 'main' });
  const four = [api, busy, web, webApp];
  const repoRowsOf = (repoQuery: string, extra: Partial<PanelUiState> = {}) =>
    buildPanel(state(four), ui({ repoQuery, ...extra })).repoRows;
  const marks = (rows: readonly PanelRow[]) => rows.map((r) => (r.kind === 'repo' ? r.highlights : undefined));

  it('lists only the repositories whose names hold every word, the matched letters marked', () => {
    const rows = repoRowsOf('web');
    expect(ids(rows)).toEqual(['repo:/web', 'repo:/web-app']);
    expect(marks(rows)).toEqual([[[0, 3]], [[0, 3]]]);
    // Each word anywhere in the name, in any order and either case.
    const both = repoRowsOf('APP web');
    expect(ids(both)).toEqual(['repo:/web-app']);
    expect(marks(both)).toEqual([[[0, 3], [4, 7]]]);
  });

  it('lists every repository, nothing marked, while the filter is empty or blank', () => {
    expect(kinds(repoRowsOf(''))).toEqual(['repo', 'repo', 'operation', 'repo', 'repo']);
    expect(ids(repoRowsOf('   '))).toEqual(ids(repoRowsOf('')));
    expect(marks(repoRowsOf('')).filter((m) => m !== undefined && m.length > 0)).toEqual([]);
  });

  it('keeps a banner with its repository: shown with it, hidden with it', () => {
    expect(ids(repoRowsOf('bus'))).toEqual(['repo:/busy', 'op:/busy']);
    expect(ids(repoRowsOf('api'))).toEqual(['repo:/api']);
  });

  it('matches the name the panel shows, not the folder the repository is in', () => {
    const lib = repo('/work/lib', { label: 'lib' });
    expect(kinds(buildPanel(state([api, lib]), ui({ repoQuery: 'work' })).repoRows)).toEqual(['hint']);
    expect(ids(buildPanel(state([api, lib]), ui({ repoQuery: 'LI' })).repoRows)).toEqual(['repo:/work/lib']);
  });

  it('says so when no name matches, and offers nothing to create', () => {
    expect(repoRowsOf(' nope ')).toEqual([
      { kind: 'hint', id: 'hint:repos', text: 'No repository matches “nope”.', height: HINT },
    ]);
  });

  it('picks nothing and hides no branch: the pick, and so the branches, stay as they were', () => {
    const picked = { scope: ['/api'], tab: 'local' as const };
    const plain = buildPanel(state(four), ui(picked));
    const filtered = buildPanel(state(four), ui({ ...picked, repoQuery: 'web' }));
    // api, the one picked, is out of the list and still the one in view.
    expect(ids(filtered.repoRows)).toEqual(['repo:/web', 'repo:/web-app']);
    expect(filtered.scopeRepos.map((r) => r.root)).toEqual(['/api']);
    expect(filtered.branchRows).toEqual(plain.branchRows);
    // A row it lists still says whether it is picked.
    expect(filtered.repoRows.map((r) => (r.kind === 'repo' ? [r.inScope, r.narrowed] : []))).toEqual([
      [false, true],
      [false, true],
    ]);
  });

  it("leaves one repository's current branch, which heads the Branches panel, alone", () => {
    expect(kinds(buildPanel(state([web]), ui({ repoQuery: 'zzz' })).repoRows)).toEqual(['head']);
  });
});

describe('buildPanel: searching', () => {
  it('lists the matches flat, by whole name, with Recent out of the way', () => {
    const model = buildPanel(state([web]), ui({ query: 'log' }));
    expect(ids(model.rows)).toEqual([
      'head:/web',
      'sec:local',
      'br:local:local:feature/login',
      'sec:remote',
      'br:remote:remote:origin/feature/login',
    ]);
    const hit = model.rows[2]!;
    expect(hit.kind === 'branch' && [hit.prefix, hit.label, hit.highlights]).toEqual([
      'feature/',
      'login',
      [[8, 11]],
    ]);
    expect(model.matches).toBe(2);
  });

  it('every word has to match', () => {
    const model = buildPanel(state([web]), ui({ query: 'origin main' }));
    const names = model.rows.flatMap((r) => (r.kind === 'branch' ? [r.entry.name] : []));
    expect(names).toEqual(['origin/main']);
  });

  it('offers to create what it cannot find', () => {
    const model = buildPanel(state([web]), ui({ query: 'feature/new' }));
    const hint = model.rows[model.rows.length - 1]!;
    expect(hint.kind === 'hint' && hint.create).toBe('feature/new');
    const bad = buildPanel(state([web]), ui({ query: 'no such thing' }));
    const last = bad.rows[bad.rows.length - 1]!;
    expect(last.kind === 'hint' && last.create).toBeUndefined();
  });
});

describe('where a branch is, on its row (POST-P14bt)', () => {
  const shared = repo('/shared', {
    head: 'main',
    locals: [ref('main', { current: true }), ref('refactor/types')],
  });
  /** The three as the panel orders them: by label. */
  const three = [api, shared, web];
  const entryIn = (repos: readonly BranchPanelRepoDto[], name: string, kind: 'local' | 'remote' = 'local'): BranchEntry =>
    buildEntries(repos, kind).find((e) => e.name === name)!;
  /** Twenty repositories, `/r1` to `/r20`, each with main; `develop` in the first `n`. */
  const twenty = (n: number): BranchPanelRepoDto[] =>
    Array.from({ length: 20 }, (_, i) =>
      repo(`/r${i + 1}`, {
        locals: [ref('main', { current: i === 0 }), ...(i < n ? [ref('develop')] : [])],
      }),
    );
  const whereRows = (rows: readonly PanelRow[]) =>
    rows.flatMap((r) => (r.kind === 'branch' ? [[r.entry.name, r.where?.text]] : []));

  it('says nothing while one repository is in view: the scope or the workspace names it', () => {
    expect(whereOf(entryIn([web], 'develop'), [web])).toBeUndefined();
  });

  it('names up to three repositories, in the panel’s order, and says which lack it when few', () => {
    const develop = whereOf(entryIn(three, 'develop'), three)!;
    expect(develop).toEqual({
      text: 'in api, web',
      short: 'in 2',
      title: 'In api and web\nNot in shared',
      spoken: 'in api and web',
    });
    const types = whereOf(entryIn(three, 'refactor/types'), three)!;
    expect([types.text, types.short, types.title, types.spoken]).toEqual([
      'in shared',
      'in shared',
      'In shared\nNot in api and web',
      'in shared',
    ]);
  });

  it('says every one in view rather than leave the row blank: both of two, all of more', () => {
    const both = whereOf(entryIn([api, web], 'main'), [api, web])!;
    expect([both.text, both.short, both.title, both.spoken]).toEqual([
      'in both',
      'in both',
      'In both repositories: api and web\nChecked out in api',
      'in both repositories',
    ]);
    const all = whereOf(entryIn(three, 'main'), three)!;
    expect([all.text, all.title, all.spoken]).toEqual([
      'in all 3',
      'In all 3 repositories: api, shared and web\nChecked out in api and shared',
      'in all 3 repositories',
    ]);
  });

  it('counts past three, naming them all in the hover, and the few without it', () => {
    const many = twenty(13);
    const thirteen = whereOf(entryIn(many, 'develop'), many)!;
    expect([thirteen.text, thirteen.short, thirteen.spoken]).toEqual([
      'in 13 of 20',
      'in 13',
      'in 13 of 20 repositories',
    ]);
    expect(thirteen.title).toBe(
      `In 13 of 20 repositories: ${Array.from({ length: 13 }, (_, i) => `r${i + 1}`).join(', ')}`,
    );
    // Seven without it are too many to list; three are the news.
    const nearly = twenty(17);
    expect(whereOf(entryIn(nearly, 'develop'), nearly)!.title.split('\n')).toEqual([
      `In 17 of 20 repositories: ${Array.from({ length: 17 }, (_, i) => `r${i + 1}`).join(', ')}`,
      'Not in r18, r19 and r20',
    ]);
  });

  it('every one of twenty is "in all 20", and its hover does not list twenty names', () => {
    const many = twenty(20);
    const all = whereOf(entryIn(many, 'develop'), many)!;
    expect([all.text, all.short, all.title, all.spoken]).toEqual([
      'in all 20',
      'in all 20',
      'In all 20 repositories',
      'in all 20 repositories',
    ]);
  });

  it('says where it is checked out only where the row’s check cannot: some of them, not all', () => {
    const many = twenty(20);
    // main is checked out in r1 alone.
    expect(whereOf(entryIn(many, 'main'), many)!.title).toBe('In all 20 repositories\nChecked out in r1');
    // feature/login is checked out in web, the one repository that has it.
    expect(whereOf(entryIn(three, 'feature/login'), three)!.title).toBe('In web\nNot in api and shared');
  });

  it('a narrow sidebar keeps the words while they are short, and counts past that', () => {
    const many = twenty(13);
    const short = (repos: readonly BranchPanelRepoDto[], name: string) => whereOf(entryIn(repos, name), repos)!.short;
    expect(short(three, 'refactor/types')).toBe('in shared');
    expect(short([api, web], 'main')).toBe('in both');
    expect(short(three, 'develop')).toBe('in 2');
    expect(short(many, 'develop')).toBe('in 13');
    expect(short(twenty(20), 'develop')).toBe('in all 20');
    expect('in shared'.length).toBeLessThanOrEqual(SHORT_WHERE);
  });

  it('is on every branch row while several repositories are in view: the tabs and a search alike', () => {
    // Every folder open: bugfix/ and refactor/ by hand, feature/ for the current branch in it.
    const local = buildPanel(
      state(three),
      ui({ tab: 'local', toggled: new Set(['dir:local:bugfix/', 'dir:local:refactor/']) }),
    );
    expect(whereRows(local.branchRows)).toEqual([
      ['bugfix/header', 'in web'],
      ['feature/login', 'in web'],
      ['refactor/types', 'in shared'],
      ['develop', 'in api, web'],
      ['main', 'in all 3'],
    ]);
    const found = buildPanel(state(three), ui({ query: 'main' }));
    expect(whereRows(found.branchRows)).toEqual([
      ['main', 'in all 3'],
      ['origin/main', 'in api, web'],
      ['upstream/main', 'in web'],
    ]);
    // Recent too, whose rows are the same rows.
    expect(whereRows(buildPanel(state(three), ui()).branchRows)).toEqual([
      ['develop', 'in api, web'],
      ['main', 'in all 3'],
    ]);
  });

  it('speaks of the repositories in view: none narrowed to one, both narrowed to two', () => {
    const one = buildPanel(state(three), ui({ scope: ['/web'], query: 'e' }));
    expect(one.branchRows.some((r) => r.kind === 'branch' && r.where !== undefined)).toBe(false);
    const two = buildPanel(state(three), ui({ scope: ['/api', '/web'], query: 'main' }));
    expect(whereRows(two.branchRows)).toEqual([
      ['main', 'in both'],
      ['origin/main', 'in both'],
      ['upstream/main', 'in web'],
    ]);
  });
});

describe('ordering, buttons and words', () => {
  it('reads tags newest first', () => {
    const tags = buildEntries([web], 'tag').sort(compareTags);
    expect(tags.map((t) => t.name)).toEqual(['v1.1', 'v1.0']);
  });

  it('offers the obvious buttons for each kind of row', () => {
    const locals = buildEntries([web], 'local');
    const of = (name: string) => quickActions(locals.find((e) => e.name === name)!);
    expect(of('main')).toEqual(['checkout', 'star', 'menu']);
    expect(of('feature/login')).toEqual(['update', 'push', 'star', 'menu']);
    const untracked = buildEntries([repo('/x', { locals: [ref('x', { current: true })] })], 'local')[0]!;
    expect(quickActions(untracked)).toEqual(['push', 'star', 'menu']);
    expect(quickActions(buildEntries([web], 'remote')[0]!)).toEqual(['checkout', 'menu']);
    expect(quickActions(buildEntries([web], 'tag')[0]!)).toEqual(['menu']);
  });

  it('says ages short in a row and long in a card', () => {
    expect(shortAge(NOW, NOW - 30)).toBe('now');
    expect(shortAge(NOW, NOW - 5 * 60)).toBe('5m');
    expect(shortAge(NOW, NOW - 3 * 3600)).toBe('3h');
    expect(shortAge(NOW, NOW - 2 * 86400)).toBe('2d');
    expect(shortAge(NOW, NOW - 15 * 86400)).toBe('2w');
    expect(shortAge(NOW, NOW - 100 * 86400)).toBe('3mo');
    expect(shortAge(NOW, NOW - 800 * 86400)).toBe('2y');
    expect(shortAge(NOW, undefined)).toBe('');
    expect(longAge(NOW, NOW - 86400)).toBe('yesterday');
    expect(longAge(NOW, NOW - 3600)).toBe('1 hour ago');
    expect(longAge(NOW, NOW - 3 * 86400)).toBe('3 days ago');
  });

  it('describes tracking and the relation to what is checked out', () => {
    expect(trackingText(ref('x'), 'local')).toBe('Not published');
    expect(trackingText(ref('x', { upstream: 'origin/x', gone: true }), 'local')).toBe(
      'origin/x was deleted on the remote',
    );
    expect(trackingText(ref('x', { upstream: 'origin/x', ahead: 2, behind: 1 }), 'local')).toBe(
      '2 to push, 1 to pull · origin/x',
    );
    expect(trackingText(ref('x', { upstream: 'origin/x' }), 'local')).toBe('Up to date with origin/x');
    expect(trackingText(ref('origin/x'), 'remote', 'x')).toBe('Checked out locally as x');
    expect(trackingShort(ref('x', { upstream: 'origin/x', ahead: 2, behind: 1 }), 'local')).toBe('↓1 ↑2');
    expect(trackingShort(ref('x'), 'local')).toBe('not published');

    const vs = (ahead: number, behind: number) => ({ root: '/r', vsHead: { head: 'main', ahead, behind } });
    expect(relationText(vs(0, 0))).toBe('Same commit as main');
    expect(relationText(vs(0, 3))).toBe('Already in main');
    expect(relationText(vs(1, 0))).toBe('1 commit ahead of main');
    expect(relationText(vs(3, 2))).toBe('3 commits ahead of main, 2 behind');
    expect(relationText(undefined)).toBeUndefined();
    expect(relationShort(vs(3, 2))).toBe('3 ahead, 2 behind current');
    expect(relationShort(vs(0, 1))).toBe('in current');
  });

  it('matches words anywhere, merging overlaps', () => {
    expect(queryTokens('  Feature  LOG ')).toEqual(['feature', 'log']);
    expect(matchRanges('feature/login', ['log', 'feat'])).toEqual([
      [0, 4],
      [8, 11],
    ]);
    expect(matchRanges('feature', ['eat', 'feat'])).toEqual([[0, 4]]);
    expect(matchRanges('main', ['x'])).toBeUndefined();
  });

  it('offers to create only plausible branch names', () => {
    expect(isPlausibleBranchName('feature/x-1')).toBe(true);
    for (const bad of ['', 'has space', '-x', 'x/', 'x.', 'a..b', 'a~b', 'a:b']) {
      expect(isPlausibleBranchName(bad)).toBe(false);
    }
    // POST-P14co: git refuses `@` alone and `@{`; an `@` elsewhere is a name like any.
    for (const bad of ['@', 'a@{b', '@{u}']) expect(isPlausibleBranchName(bad), bad).toBe(false);
    for (const good of ['user@feature', '@team/x']) expect(isPlausibleBranchName(good), good).toBe(true);
  });
});

describe('the New Branch form', () => {
  it('offers a start point only where it exists', () => {
    expect(eligibleRepos([api, web], 'HEAD').map((r) => r.root)).toEqual(['/api', '/web']);
    expect(eligibleRepos([api, web], 'bugfix/header').map((r) => r.root)).toEqual(['/web']);
    expect(eligibleRepos([api, web], 'upstream/main').map((r) => r.root)).toEqual(['/web']);
    expect(eligibleRepos([api, web], 'v1.1').map((r) => r.root)).toEqual(['/web']);
  });

  it('offers one no repository has as a ref everywhere, for the host to resolve: a hash, main~2', () => {
    expect(eligibleRepos([api, web], '1a2b3c4').map((r) => r.root)).toEqual(['/api', '/web']);
    expect(eligibleRepos([api, web], 'main~2').map((r) => r.root)).toEqual(['/api', '/web']);
  });

  it("suggests every start point, the ones most repositories share first (POST-P14ax)", () => {
    const points = startPoints([api, web]);
    expect(points.slice(0, 3)).toEqual([
      { name: 'develop', kind: 'local', count: 2 },
      { name: 'main', kind: 'local', count: 2 },
      { name: 'origin/main', kind: 'remote', count: 2 },
    ]);
    expect(points.map((p) => p.name)).toContain('upstream/main');
    expect(points.map((p) => p.name)).toContain('v1.1');
    expect(points.at(-1)?.kind).toBe('tag');
  });

  it('says beside a suggestion what it is and where', () => {
    expect(startPointNote({ name: 'main', kind: 'local', count: 2 }, 2)).toBe('branch · in all 2');
    expect(startPointNote({ name: 'origin/x', kind: 'remote', count: 1 }, 3)).toBe('remote branch · in 1 of 3');
    expect(startPointNote({ name: 'v1.0', kind: 'tag', count: 1 }, 1)).toBe('tag');
  });

  it('says what would make Create fail, before it does', () => {
    expect(formProblem('', [web], true, 'HEAD')).toBeUndefined();
    expect(formProblem('bad name..', [web], true, 'HEAD')).toBe('Not a valid branch name.');
    expect(formProblem('x', [], true, 'HEAD')).toBe('Choose a repository.');
    expect(formProblem('main', [api, web], true, 'HEAD')).toBe('api, web already have a branch named “main”.');
    expect(formProblem('develop', [web], true, 'HEAD')).toBe('web already has a branch named “develop”.');
    const empty = repo('/new', { unborn: true });
    expect(formProblem('first', [empty], false, 'HEAD')).toMatch(/no commit yet/u);
    expect(formProblem('first', [empty], true, 'HEAD')).toBeUndefined();
    expect(formProblem('feature/fine', [api, web], true, 'HEAD')).toBeUndefined();
  });

  it('says what the branch will track, from a remote branch only', () => {
    expect(trackingNote('mine', 'origin/main', [web])).toBe(
      'It will track nothing: your first push creates a branch of its own on origin.',
    );
    expect(trackingNote('', 'origin/main', [web])).toMatch(/track nothing/u);
    expect(trackingNote('main', 'origin/main', [web])).toBe(
      'It will track origin/main, the remote branch of the same name.',
    );
    expect(trackingNote(' main ', 'origin/main', [web])).toMatch(/It will track origin\/main/u);
    expect(trackingNote('main', 'upstream/main', [web])).toBe(
      'It will track upstream/main, the remote branch of the same name.',
    );
    // A local branch, a tag and HEAD raise no question.
    expect(trackingNote('mine', 'develop', [web])).toBeUndefined();
    expect(trackingNote('mine', 'v1.0', [web])).toBeUndefined();
    expect(trackingNote('mine', 'HEAD', [web])).toBeUndefined();
  });

  it('names the start point', () => {
    expect(fromText('origin/main', [web])).toBe('origin/main');
    expect(fromText('HEAD', [web])).toBe('feature/login');
    expect(fromText('HEAD', [api, web])).toBe('each repository’s current branch');
  });
});

describe("a branch's card: repositories that say the same are one line", () => {
  /** Twenty repositories on main, each with `develop` up to date with its own remote branch. */
  const many: BranchPanelRepoDto[] = Array.from({ length: 20 }, (_, i) =>
    repo(`/r${i + 1}`, {
      head: 'main',
      colorIdx: i % 8,
      locals: [
        ref('main', { current: true, upstream: 'origin/main' }),
        ref('develop', { upstream: 'origin/develop' }),
      ],
      remotes: [ref('origin/develop', { remote: 'origin' })],
    }),
  );
  const developIn = (repos: readonly BranchPanelRepoDto[]): BranchEntry =>
    buildEntries(repos, 'local').find((e) => e.name === 'develop')!;
  /** The host's facts: each repository's develop `ahead` and `behind` its checked-out main. */
  const facts = (repos: readonly BranchPanelRepoDto[], ahead: number, behind: number): BranchPanelDetailsDto => ({
    repos: repos.map((r) => ({ root: r.root, vsHead: { head: 'main', ahead, behind } })),
    buttons: [],
  });
  /** `develop` a step behind its upstream in the repositories at `indices`. */
  const behindIn = (indices: readonly number[]): BranchPanelRepoDto[] =>
    many.map((r, i) =>
      indices.includes(i)
        ? { ...r, locals: r.locals.map((l) => (l.name === 'develop' ? { ...l, behind: 2 } : l)) }
        : r,
    );
  const groupsOf = (lines: readonly CardLine[]) =>
    lines.flatMap((l) => (l.kind === 'group' ? [l] : []));

  it('twenty repositories in step are one line, "All 20", which needs no list', () => {
    const lines = cardLines(developIn(many), { markers: true, scopeRepos: many, details: facts(many, 2, 4) });
    expect(lines.map((l) => l.kind)).toEqual(['commit', 'group']);
    const [all] = groupsOf(lines);
    expect(all!.label).toBe('All 20');
    expect(all!.expandable).toBe(false);
    expect(all!.group.tracking).toBe('up to date');
    expect(all!.group.relation).toBe('2 ahead, 4 behind current');
    expect(cardHeight(lines)).toBe(CARD_PAD + 2 * CARD_LINE + CARD_BUTTONS);
  });

  it('the repositories that differ get a line of their own, after the largest group', () => {
    const repos = behindIn([2, 6]);
    const groups = groupsOf(cardLines(developIn(repos), { markers: true, scopeRepos: repos, details: facts(repos, 2, 4) }));
    expect(groups.map((g) => g.label)).toEqual(['18 repositories', 'r3, r7']);
    expect(groups.map((g) => g.group.tracking)).toEqual(['up to date', '↓2']);
  });

  it('names a group of up to three, and counts a larger one, which opens to list them', () => {
    const repos = behindIn([2, 6]);
    const entry = developIn(repos);
    const shut = groupsOf(cardLines(entry, { markers: true, scopeRepos: repos }));
    expect(shut.map((g) => [g.label, g.expandable, g.open])).toEqual([
      ['18 repositories', true, false],
      ['r3, r7', false, false],
    ]);
    const key = shut[0]!.group.key;
    const lines = cardLines(entry, { markers: true, scopeRepos: repos, open: new Set([key]) });
    const members = lines.flatMap((l) => (l.kind === 'member' ? [l.repo.label] : []));
    expect(members).toHaveLength(18);
    expect(members.slice(0, 3)).toEqual(['r1', 'r2', 'r4']);
    // Listed right under their group, before the next group.
    expect(lines.map((l) => l.kind).slice(0, 3)).toEqual(['commit', 'group', 'member']);
    expect(lines[2 + 18]?.kind).toBe('group');
  });

  it('says which repositories in view lack the branch, named or counted', () => {
    const without = (indices: readonly number[]): BranchPanelRepoDto[] =>
      many.map((r, i) => (indices.includes(i) ? { ...r, locals: r.locals.filter((l) => l.name !== 'develop') } : r));
    const four = without([16, 17, 18, 19]);
    const lines = cardLines(developIn(four), { markers: true, scopeRepos: four, details: facts(four, 0, 0) });
    expect(groupsOf(lines).map((g) => [g.label, g.group.missing, g.expandable])).toEqual([
      ['16 repositories', false, true],
      ['not in 4 repositories', true, true],
    ]);
    const two = without([18, 19]);
    expect(groupsOf(cardLines(developIn(two), { markers: true, scopeRepos: two })).at(-1)?.label).toBe(
      'not in r19, r20',
    );
  });

  it('the branch in one repository of several: its full lines, then the ones without it', () => {
    const only = many.map((r, i) => (i === 0 ? r : { ...r, locals: r.locals.filter((l) => l.name !== 'develop') }));
    const lines = cardLines(developIn(only), { markers: true, scopeRepos: only });
    expect(lines.map((l) => l.kind)).toEqual(['commit', 'tracking', 'relation', 'group']);
    expect(groupsOf(lines)[0]!.label).toBe('not in 19 repositories');
  });

  it('one repository in view: the full tracking and relation, and nothing said of others', () => {
    const one = [many[0]!];
    expect(cardLines(developIn(one), { markers: false, scopeRepos: one }).map((l) => l.kind)).toEqual([
      'commit',
      'tracking',
      'relation',
    ]);
    // Checked out where it is: nothing to relate it to.
    const main = buildEntries(one, 'local').find((e) => e.name === 'main')!;
    expect(cardLines(main, { markers: false, scopeRepos: one }).map((l) => l.kind)).toEqual(['commit', 'tracking']);
  });

  it('groups by what is known until the facts come, which can split a group', () => {
    const entry = developIn(many);
    expect(groupsOf(cardLines(entry, { markers: true, scopeRepos: many })).map((g) => g.label)).toEqual(['All 20']);
    const split: BranchPanelDetailsDto = {
      repos: many.map((r, i) => ({ root: r.root, vsHead: { head: 'main', ahead: i === 4 ? 5 : 2, behind: 0 } })),
      buttons: [],
    };
    const groups = groupsOf(cardLines(entry, { markers: true, scopeRepos: many, details: split }));
    expect(groups.map((g) => [g.label, g.group.relation])).toEqual([
      ['19 repositories', '2 ahead of current'],
      ['r5', '5 ahead of current'],
    ]);
  });

  it('keeps the repositories where it is checked out apart, and says so', () => {
    const repos = many.map((r, i) =>
      i === 0 ? { ...r, head: 'develop', locals: r.locals.map((l) => ({ ...l, current: l.name === 'develop' })) } : r,
    );
    const groups = cardGroups(developIn(repos), repos, facts(repos, 0, 3));
    expect(groups.map((g) => [g.repos.length, g.current])).toEqual([
      [19, false],
      [1, true],
    ]);
    // Checked out, it has no relation to what is checked out.
    expect(groups[1]!.relation).toBeUndefined();
  });

  it("a group's label", () => {
    const g = (n: number, missing = false) => ({
      key: 'k',
      missing,
      repos: many.slice(0, n),
      current: false,
      tracking: 'up to date',
    });
    expect(groupLabel(g(1), false)).toBe('r1');
    expect(groupLabel(g(3), true)).toBe('r1, r2, r3');
    expect(groupLabel(g(4), false)).toBe('4 repositories');
    expect(groupLabel(g(20), true)).toBe('All 20');
    expect(groupLabel(g(2, true), false)).toBe('not in r1, r2');
    expect(groupLabel(g(5, true), false)).toBe('not in 5 repositories');
  });

  it('a detached HEAD has no branch to describe: its two lines', () => {
    expect(cardLines(undefined, { markers: false, scopeRepos: [] }).map((l) => l.kind)).toEqual([
      'detached',
      'detachedHint',
    ]);
  });

  it('the panel sizes an open card by its facts and its opened groups, and hands the row its lines', () => {
    const repos = behindIn([2, 6]);
    const id = 'br:local:local:develop';
    const shut = buildPanel(state(repos), ui({ tab: 'local', openCard: id, detailsOf: () => facts(repos, 2, 4) }));
    const row = shut.rows.find((r) => r.id === id);
    expect(row?.kind === 'branch' && row.cardLines?.map((l) => l.kind)).toEqual(['commit', 'group', 'group']);
    expect(row?.height).toBe(ROW + CARD_PAD + 3 * CARD_LINE + CARD_BUTTONS);

    const key = row?.kind === 'branch' ? (row.cardLines?.[1] as Extract<CardLine, { kind: 'group' }>).group.key : '';
    const open = buildPanel(
      state(repos),
      ui({ tab: 'local', openCard: id, detailsOf: () => facts(repos, 2, 4), openGroups: new Set([key]) }),
    );
    expect(open.rows.find((r) => r.id === id)?.height).toBe(ROW + CARD_PAD + (3 + 18) * CARD_LINE + CARD_BUTTONS);
    // A row whose card is shut carries no lines.
    expect(open.rows.find((r) => r.id === 'br:local:local:main')).not.toHaveProperty('cardLines');
  });
});
