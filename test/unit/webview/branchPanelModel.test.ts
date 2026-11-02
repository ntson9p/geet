import { describe, expect, it } from 'vitest';
import type {
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
  cardHeight,
  cardLineCount,
  compareTags,
  entryKey,
  isPlausibleBranchName,
  longAge,
  matchRanges,
  queryTokens,
  quickActions,
  recentEntries,
  relationShort,
  relationText,
  remoteTwin,
  ROW,
  scopeReposOf,
  shortAge,
  targetOf,
  trackingShort,
  trackingText,
  upstreamElsewhere,
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

  it('starts with the current branch, then Recent, Local, Remote and Tags', () => {
    expect(model.multi).toBe(false);
    expect(model.markers).toBe(false);
    const first = model.rows[0]!;
    expect(first.kind).toBe('head');
    if (first.kind === 'head') expect(first.entry?.name).toBe('feature/login');
    const sections = model.rows.filter((r) => r.kind === 'section').map((r) => r.id);
    expect(sections).toEqual(['sec:recent', 'sec:local', 'sec:remote', 'sec:tags']);
  });

  it('opens Recent and Local, and keeps Remote and Tags shut', () => {
    const open = Object.fromEntries(
      model.rows.flatMap((r) => (r.kind === 'section' ? [[r.section, r.open]] : [])),
    );
    expect(open).toEqual({ recent: true, local: true, remote: false, tags: false });
    expect(model.rows.some((r) => r.kind === 'remote')).toBe(false);
  });

  it('folds names into folders, and opens the folder holding the current branch', () => {
    const feature = model.rows.find((r) => r.kind === 'folder' && r.label === 'feature');
    const bugfix = model.rows.find((r) => r.kind === 'folder' && r.label === 'bugfix');
    expect(feature?.kind === 'folder' && feature.open).toBe(true);
    expect(bugfix?.kind === 'folder' && bugfix.open).toBe(false);
    const login = model.rows.find((r) => r.kind === 'branch' && r.section === 'local' && r.entry.name === 'feature/login');
    expect(login?.kind === 'branch' && login.label).toBe('login');
    expect(login?.kind === 'branch' && login.depth).toBe(1);
  });

  it('shows whole names, prefix dimmed, in Recent', () => {
    const recent = model.rows.filter((r) => r.kind === 'branch' && r.section === 'recent');
    expect(recent.map((r) => (r.kind === 'branch' ? r.entry.name : ''))).toEqual(['develop', 'main']);
  });

  it('lists every name flat when folders are off', () => {
    const flat = buildPanel(state([web], { groupByFolder: false }), ui());
    expect(flat.rows.some((r) => r.kind === 'folder')).toBe(false);
    const bugfix = flat.rows.find((r) => r.kind === 'branch' && r.section === 'local' && r.entry.name === 'bugfix/header');
    expect(bugfix?.kind === 'branch' && [bugfix.prefix, bugfix.label]).toEqual(['bugfix/', 'header']);
  });

  it('a toggle flips what a node does by default', () => {
    const toggled = buildPanel(state([web]), ui({ toggled: new Set(['sec:remote', 'dir:local:feature/']) }));
    const remote = toggled.rows.find((r) => r.id === 'sec:remote');
    expect(remote?.kind === 'section' && remote.open).toBe(true);
    expect(toggled.rows.find((r) => r.id === 'dir:local:feature/')?.kind === 'folder').toBe(true);
    const feature = toggled.rows.find((r) => r.id === 'dir:local:feature/');
    expect(feature?.kind === 'folder' && feature.open).toBe(false);
    // Remote, open: a group per remote.
    expect(toggled.rows.filter((r) => r.kind === 'remote').map((r) => (r.kind === 'remote' ? r.remote : ''))).toEqual([
      'origin',
      'upstream',
    ]);
  });

  it('opens a card under the row it belongs to, and sizes it', () => {
    const id = 'br:local:local:main';
    const withCard = buildPanel(state([web]), ui({ openCard: id }));
    const row = withCard.rows.find((r) => r.id === id);
    expect(row?.kind === 'branch' && row.card).toBe(true);
    expect(row?.height).toBe(ROW + CARD_PAD + 3 * CARD_LINE + CARD_BUTTONS);
  });
});

describe('buildPanel: several repositories', () => {
  const model = buildPanel(state([api, web]), ui());

  it('lists the repositories first, with a banner under one in the middle of something', () => {
    const busy = repo('/busy', { operation: { kind: 'rebase', conflicts: 1 } });
    const withOp = buildPanel(state([api, busy, web]), ui());
    expect(kinds(withOp.rows).slice(0, 5)).toEqual(['section', 'repo', 'repo', 'operation', 'repo']);
    expect(model.multi).toBe(true);
    expect(model.markers).toBe(true);
  });

  it('draws a name once, however many repositories have it', () => {
    const mains = model.rows.filter((r) => r.kind === 'branch' && r.section === 'local' && r.entry.name === 'main');
    expect(mains).toHaveLength(1);
  });

  it('narrows to the scope, and drops the markers when one repository is left', () => {
    const narrowed = buildPanel(state([api, web]), ui({ scope: ['/api'] }));
    expect(narrowed.scopeRepos.map((r) => r.root)).toEqual(['/api']);
    expect(narrowed.markers).toBe(false);
    const repos = narrowed.rows.filter((r) => r.kind === 'repo');
    expect(repos.map((r) => (r.kind === 'repo' ? [r.repo.root, r.inScope, r.narrowed] : []))).toEqual([
      ['/api', true, true],
      ['/web', false, true],
    ]);
    expect(narrowed.rows.some((r) => r.kind === 'branch' && r.entry.name === 'bugfix/header')).toBe(false);
  });

  it('a scope naming no open repository means every repository', () => {
    expect(scopeReposOf([api, web], ['/gone']).map((r) => r.root)).toEqual(['/api', '/web']);
  });

  it('sizes a card by the repositories that have the branch', () => {
    const main = buildEntries([api, web], 'local').find((e) => e.name === 'main')!;
    expect(cardLineCount(main, true)).toBe(3);
    expect(cardHeight(main, true)).toBe(CARD_PAD + 3 * CARD_LINE + CARD_BUTTONS);
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
