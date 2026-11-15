import { describe, expect, it } from 'vitest';
import { pushWithoutDialog } from '../../../src/scm/dialogs/pushModel';
import type { PushCommitDto, PushRepoDto } from '../../../src/shared/protocol';
import {
  buildRows,
  canPush,
  chosenRepos,
  commitKey,
  initialSelection,
  INITIAL_SHOWN_COMMITS,
  matchVariants,
  repoKey,
  repoStateOf,
  selectedCommits,
  toggledByKeyboard,
  type RepoState,
} from '../../../webview-ui/src/dialogs/pushTree';

/** The Push dialog's left tree, as IntelliJ's `PushLog` and `PushController` build it. */

const commit = (n: number): PushCommitDto => ({
  sha: `${String(n).padStart(2, '0')}`.repeat(20),
  subject: `commit ${n}`,
  body: `commit ${n}`,
  authorName: 'Ada',
  authorEmail: 'ada@example.com',
  authorTime: 1_700_000_000 + n,
});

function repo(root: string, over: Partial<PushRepoDto> = {}): PushRepoDto {
  return {
    root,
    label: root.slice(1),
    source: { kind: 'branch', presentation: 'main', revision: 'refs/heads/main', branch: 'main' },
    remotes: ['origin'],
    target: { remote: 'origin', branch: 'main', isNew: false, type: 'tracking' },
    defaultTarget: { remote: 'origin', branch: 'main', isNew: false, type: 'tracking' },
    sourceTracks: true,
    commits: [commit(3), commit(2), commit(1)],
    remoteBranches: [{ remote: 'origin', branch: 'main' }],
    recentTargets: [],
    checked: true,
    ...over,
  };
}

const state = (dto: PushRepoDto, over: Partial<RepoState> = {}): RepoState => ({ ...repoStateOf(dto), ...over });

describe('buildRows', () => {
  it('shows one repository open, with its commits under it', () => {
    const rows = buildRows([state(repo('/a'))], new Set(), true);
    expect(rows.map((r) => r.kind)).toEqual(['repo', 'commit', 'commit', 'commit']);
  });

  it('with several, opens only the expanded ones', () => {
    const rows = buildRows([state(repo('/a')), state(repo('/b'))], new Set(['/b']), false);
    expect(rows.map((r) => `${r.kind}:${r.root}`)).toEqual([
      'repo:/a',
      'repo:/b',
      'commit:/b',
      'commit:/b',
      'commit:/b',
    ]);
  });

  it('shows twenty commits, then `...`', () => {
    const many = Array.from({ length: 45 }, (_, i) => commit(i + 1));
    const first = buildRows([state(repo('/a', { commits: many }))], new Set(), true);
    expect(first.filter((r) => r.kind === 'commit')).toHaveLength(INITIAL_SHOWN_COMMITS);
    expect(first.at(-1)?.kind).toBe('more');
    const doubled = buildRows([state(repo('/a', { commits: many }), { shown: 40 })], new Set(), true);
    expect(doubled.filter((r) => r.kind === 'commit')).toHaveLength(40);
    const all = buildRows([state(repo('/a', { commits: many }), { shown: 80 })], new Set(), true);
    expect(all.filter((r) => r.kind === 'commit')).toHaveLength(45);
    expect(all.some((r) => r.kind === 'more')).toBe(false);
  });

  it('puts the reason in place of the commits when they could not be listed', () => {
    const rows = buildRows([state(repo('/a', { commits: [], loadError: 'bad revision' }))], new Set(), true);
    expect(rows.map((r) => r.kind)).toEqual(['repo', 'error']);
  });
});

describe('selectedCommits', () => {
  const repos = [state(repo('/a')), state(repo('/b'))];
  const rows = buildRows(repos, new Set(['/a', '/b']), false);
  const sha = (n: number): string => commit(n).sha;

  it('a repository row means all its commits, oldest first', () => {
    const sel = selectedCommits(rows, new Set([repoKey('/a')]), repos);
    expect([...sel.byRepo]).toEqual([['/a', [sha(1), sha(2), sha(3)]]]);
    expect(sel.repoSelected).toBe(true);
    expect(sel.single).toBeUndefined();
  });

  it('selected commits run bottom row first, each once', () => {
    const sel = selectedCommits(
      rows,
      new Set([commitKey('/a', sha(3)), commitKey('/a', sha(1)), repoKey('/b'), commitKey('/b', sha(2))]),
      repos,
    );
    expect(sel.byRepo.get('/a')).toEqual([sha(1), sha(3)]);
    expect(sel.byRepo.get('/b')).toEqual([sha(1), sha(2), sha(3)]);
    expect(sel.count).toBe(5);
  });

  it('one commit, and no repository row, shows its details', () => {
    const sel = selectedCommits(rows, new Set([commitKey('/b', sha(2))]), repos);
    expect(sel.single).toEqual({ root: '/b', commit: commit(2) });
    const withRepo = selectedCommits(
      buildRows([state(repo('/a', { commits: [commit(1)] }))], new Set(), true),
      new Set([repoKey('/a')]),
      [state(repo('/a', { commits: [commit(1)] }))],
    );
    expect(withRepo.count).toBe(1);
    expect(withRepo.single).toBeUndefined();
  });

  it('nothing selected is nothing to show', () => {
    expect(selectedCommits(rows, new Set(), repos).count).toBe(0);
  });
});

describe('pushing', () => {
  it('needs a checked repository with a target, and no edit in progress', () => {
    const ok = state(repo('/a'));
    expect(canPush([ok], false)).toBe(true);
    expect(canPush([ok], true)).toBe(false);
    expect(canPush([state(repo('/a'), { checked: false })], false)).toBe(false);
    const noRemote = repo('/a', { remotes: [] });
    delete (noRemote as { target?: unknown }).target;
    expect(canPush([state(noRemote)], false)).toBe(false);
    expect(canPush([state(repo('/a', { error: 'Empty repository' }))], false)).toBe(false);
  });

  it('pushes the checked repositories that can be pushed', () => {
    const repos = [state(repo('/a')), state(repo('/b'), { checked: false }), state(repo('/c', { error: 'Empty repository' }))];
    expect(chosenRepos(repos).map((r) => r.dto.root)).toEqual(['/a']);
  });

  /**
   * POST-P14cn: with `gittree.push.showDialog` off, the host pushes what this
   * dialog would push had Push been pressed the moment it opened. The two are
   * separate code, so the same rows must give the same repositories and
   * targets: one tracking its upstream, one published to a new branch, one
   * pushing a commit of Push All up to Here.
   */
  it('a Push without the dialog pushes what Push pressed at once would', () => {
    const rows = [
      repo('/a'),
      repo('/b', {
        source: { kind: 'branch', presentation: 'feature', revision: 'refs/heads/feature', branch: 'feature' },
        target: { remote: 'origin', branch: 'feature', isNew: true, type: 'tracking' },
        defaultTarget: { remote: 'origin', branch: 'feature', isNew: true, type: 'tracking' },
        sourceTracks: false,
      }),
      repo('/c', {
        source: { kind: 'revision', presentation: '1393301c', revision: '1393301c'.repeat(5), branch: 'main' },
      }),
    ];
    const dialog = chosenRepos(rows.map((r) => repoStateOf(r)));
    const plan = pushWithoutDialog(rows, 'none');
    expect(plan.kind).toBe('push');
    if (plan.kind !== 'push') return;
    expect(plan.result.repos).toEqual(
      dialog.map((r) => ({
        root: r.dto.root,
        source: r.dto.source,
        target: { remote: r.target!.remote, branch: r.target!.branch },
        setUpstream: false,
      })),
    );
    // Run Git hooks starts ticked, and Force Push is never the default.
    expect([plan.result.runHooks, plan.result.force]).toEqual([true, false]);
  });
});

describe('Space on the tree', () => {
  it('gives every selected row’s repository the opposite of the first one’s state', () => {
    const repos = [state(repo('/a')), state(repo('/b'), { checked: false })];
    const rows = buildRows(repos, new Set(['/a', '/b']), false);
    const toggled = toggledByKeyboard(rows, new Set([commitKey('/a', commit(2).sha), repoKey('/b')]), repos);
    expect([...toggled]).toEqual([
      ['/a', false],
      ['/b', false],
    ]);
  });

  it('leaves a repository with nowhere to push alone', () => {
    const noRemote = repo('/b', { remotes: [] });
    delete (noRemote as { target?: unknown }).target;
    const repos = [state(repo('/a'), { checked: false }), state(noRemote)];
    const rows = buildRows(repos, new Set(), false);
    expect([...toggledByKeyboard(rows, new Set([repoKey('/a'), repoKey('/b')]), repos)]).toEqual([['/a', true]]);
  });
});

describe('initialSelection', () => {
  it('selects the repository asked for, else the first checked one with commits', () => {
    const repos = [state(repo('/a', { commits: [] })), state(repo('/b'))];
    expect(initialSelection(repos, '/a')).toBe(repoKey('/a'));
    expect(initialSelection(repos, undefined)).toBe(repoKey('/b'));
    expect(initialSelection([state(repo('/a', { commits: [] }))], undefined)).toBeUndefined();
  });
});

describe('matchVariants', () => {
  const variants = [
    { name: 'review-b', recent: true },
    { name: 'main', recent: false },
    { name: 'feature/review', recent: false },
  ];

  it('lists everything for an empty field', () => {
    expect(matchVariants(variants, '')).toEqual(variants);
  });

  it('puts names starting with the text before names containing it', () => {
    expect(matchVariants(variants, 'REV').map((v) => v.name)).toEqual(['review-b', 'feature/review']);
    expect(matchVariants(variants, 'ma').map((v) => v.name)).toEqual(['main']);
  });
});
