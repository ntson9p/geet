import { describe, expect, it } from 'vitest';
import type { StatusEntry } from '../../../src/core/git/parsers/statusV2';
import type { RefInfo } from '../../../src/core/model/refs';
import type { RepoSnapshot } from '../../../src/core/model/repositoryModel';
import {
  buildRepoDto,
  changeCount,
  cleanupCandidates,
  mainBranchOf,
  mergedArgs,
  mergedBranches,
  operationOf,
  preTicked,
  shownMerged,
  toRefDto,
} from '../../../src/branches/panelState';

function ref(name: string, type: RefInfo['type'], extra: Partial<RefInfo> = {}): RefInfo {
  const fullName =
    type === 'tag' ? `refs/tags/${name}` : type === 'remote' ? `refs/remotes/${name}` : `refs/heads/${name}`;
  return {
    name,
    fullName,
    type,
    sha: 'a'.repeat(40),
    objectType: 'commit',
    isHead: false,
    ...(type === 'remote' ? { remote: name.split('/')[0] ?? '' } : {}),
    ...extra,
  };
}

function entry(kind: StatusEntry['kind'], path: string): StatusEntry {
  return { kind, path, x: '.', y: 'M', submodule: 'N...' };
}

function snapshot(extra: Partial<RepoSnapshot> = {}): RepoSnapshot {
  return {
    detached: false,
    initial: false,
    upstreamGone: false,
    refs: [],
    statusEntries: [],
    stashes: [],
    ...extra,
  };
}

describe('toRefDto', () => {
  it('carries what a row reads, and leaves out what says nothing', () => {
    const dto = toRefDto(
      ref('feature/x', 'head', {
        isHead: true,
        upstream: 'origin/feature/x',
        ahead: 2,
        behind: 0,
        creatorDate: 1_700_000_000,
        subject: 'Fix it',
      }),
    );
    expect(dto).toEqual({
      name: 'feature/x',
      sha: 'a'.repeat(40),
      date: 1_700_000_000,
      subject: 'Fix it',
      upstream: 'origin/feature/x',
      ahead: 2,
      current: true,
    });
  });

  it('marks a gone upstream, and a remote branch with its remote', () => {
    expect(toRefDto(ref('old', 'head', { upstream: 'origin/old', upstreamGone: true })).gone).toBe(true);
    const remote = toRefDto(ref('origin/main', 'remote'));
    expect(remote.remote).toBe('origin');
    expect(remote.current).toBeUndefined();
  });
});

describe('mainBranchOf', () => {
  it("is origin/HEAD's target when the remote says", () => {
    const refs = [
      ref('origin/HEAD', 'remote', { symrefTarget: 'refs/remotes/origin/develop' }),
      ref('origin/develop', 'remote'),
      ref('origin/main', 'remote'),
      ref('main', 'head'),
    ];
    expect(mainBranchOf(refs)).toBe('origin/develop');
  });

  it("prefers origin's HEAD over another remote's", () => {
    const refs = [
      ref('upstream/HEAD', 'remote', { symrefTarget: 'refs/remotes/upstream/trunk' }),
      ref('upstream/trunk', 'remote'),
      ref('origin/HEAD', 'remote', { symrefTarget: 'refs/remotes/origin/main' }),
      ref('origin/main', 'remote'),
    ];
    expect(mainBranchOf(refs)).toBe('origin/main');
  });

  it('falls back to the conventional names, remote before local', () => {
    expect(mainBranchOf([ref('origin/master', 'remote'), ref('main', 'head')])).toBe('origin/master');
    expect(mainBranchOf([ref('master', 'head'), ref('dev', 'head')])).toBe('master');
  });

  it('has no answer rather than a guess', () => {
    expect(mainBranchOf([ref('trunk', 'head'), ref('origin/trunk', 'remote')])).toBeUndefined();
  });

  it('ignores a HEAD whose target is not there', () => {
    const refs = [ref('origin/HEAD', 'remote', { symrefTarget: 'refs/remotes/origin/gone' }), ref('main', 'head')];
    expect(mainBranchOf(refs)).toBe('main');
  });
});

describe('mergedBranches', () => {
  const main = ref('origin/main', 'remote', { sha: 'm'.repeat(40) });
  const refs = [
    main,
    ref('main', 'head', { sha: 'm'.repeat(40) }),
    ref('done', 'head', { sha: 'd'.repeat(40) }),
    ref('fresh', 'head', { sha: 'm'.repeat(40) }),
    ref('also-done', 'head', { sha: 'e'.repeat(40) }),
  ];

  it('asks git for the local branches main contains', () => {
    expect(mergedArgs('origin/main')).toEqual([
      'for-each-ref',
      '--merged=origin/main',
      '--format=%(refname)',
      'refs/heads/',
    ]);
  });

  it("keeps every branch main contains, sorted, but not main's own local branch", () => {
    const out = 'refs/heads/main\nrefs/heads/done\nrefs/heads/fresh\nrefs/heads/also-done\n';
    expect(mergedBranches(out, refs, 'origin/main')).toEqual(['also-done', 'done', 'fresh']);
  });

  it("counts a branch on main's very tip: a fast-forward merge looks exactly like that", () => {
    expect(mergedBranches('refs/heads/main\nrefs/heads/fresh\n', refs, 'origin/main')).toEqual(['fresh']);
  });

  it('ignores lines that are not local branches, and names it does not know', () => {
    expect(mergedBranches('refs/tags/v1\nrefs/heads/ghost\n\n', refs, 'origin/main')).toEqual([]);
  });

  it('works against a local main too', () => {
    const local = [ref('main', 'head', { sha: 'm'.repeat(40) }), ref('done', 'head', { sha: 'd'.repeat(40) })];
    expect(mergedBranches('refs/heads/main\nrefs/heads/done\n', local, 'main')).toEqual(['done']);
  });
});

describe('operationOf and changeCount', () => {
  it('names what git is in the middle of, with its conflicts and progress', () => {
    const snap = snapshot({
      inProgressOp: { kind: 'rebase-interactive', step: 2, total: 5 },
      statusEntries: [entry('unmerged', 'a'), entry('unmerged', 'b'), entry('ordinary', 'c')],
    });
    expect(operationOf(snap)).toEqual({ kind: 'rebase', conflicts: 2, step: 2, total: 5 });
  });

  it('maps every kind', () => {
    expect(operationOf(snapshot({ inProgressOp: { kind: 'rebase-apply' } }))?.kind).toBe('rebase');
    expect(operationOf(snapshot({ inProgressOp: { kind: 'cherry-pick' } }))?.kind).toBe('cherry-pick');
    expect(operationOf(snapshot({ inProgressOp: { kind: 'revert' } }))?.kind).toBe('revert');
    expect(operationOf(snapshot({ inProgressOp: { kind: 'merge' } }))?.kind).toBe('merge');
    expect(operationOf(snapshot())).toBeUndefined();
  });

  it('counts changed files but not ignored ones', () => {
    const snap = snapshot({
      statusEntries: [entry('ordinary', 'a'), entry('untracked', 'b'), entry('ignored', 'c')],
    });
    expect(changeCount(snap)).toBe(2);
  });
});

describe('buildRepoDto', () => {
  const refs = [
    ref('main', 'head', { isHead: true, upstream: 'origin/main', behind: 3 }),
    ref('feature', 'head', { sha: 'f'.repeat(40) }),
    ref('origin/main', 'remote'),
    ref('origin/HEAD', 'remote', { symrefTarget: 'refs/remotes/origin/main' }),
    ref('v1', 'tag'),
  ];

  it('reads the head, the counts and the refs from the snapshot', () => {
    const dto = buildRepoDto({
      root: '/r',
      label: 'r',
      colorIdx: 3,
      snapshot: snapshot({
        headRef: 'main',
        headSha: 'b'.repeat(40),
        upstream: 'origin/main',
        behind: 3,
        ahead: 0,
        refs,
        statusEntries: [entry('ordinary', 'x')],
      }),
      recent: ['feature', 'main', 'deleted-meanwhile'],
      favorites: new Set(['zeta', 'alpha']),
      mainBranch: 'origin/main',
      merged: ['feature'],
      fetching: true,
    });
    expect(dto.head).toBe('main');
    expect(dto.behind).toBe(3);
    expect(dto.ahead).toBeUndefined();
    expect(dto.changes).toBe(1);
    expect(dto.fetching).toBe(true);
    expect(dto.colorIdx).toBe(3);
    expect(dto.locals.map((r) => r.name)).toEqual(['main', 'feature']);
    // origin/HEAD is a pointer, not a branch.
    expect(dto.remotes.map((r) => r.name)).toEqual(['origin/main']);
    expect(dto.tags.map((r) => r.name)).toEqual(['v1']);
    // The current branch is the first row already; a deleted one is not anywhere.
    expect(dto.recent).toEqual(['feature']);
    expect(dto.favorites).toEqual(['alpha', 'zeta']);
    expect(dto.mainBranch).toBe('origin/main');
    expect(dto.merged).toEqual(['feature']);
  });

  it('has no head when detached, and says when there is no commit yet', () => {
    const detached = buildRepoDto({
      root: '/r',
      label: 'r',
      colorIdx: 0,
      snapshot: snapshot({ detached: true, headRef: 'HEAD', headSha: 'c'.repeat(40) }),
      recent: [],
      favorites: [],
      merged: [],
      fetching: false,
    });
    expect(detached.head).toBeUndefined();
    expect(detached.detached).toBe(true);
    const unborn = buildRepoDto({
      root: '/r',
      label: 'r',
      colorIdx: 0,
      snapshot: snapshot({ initial: true, headRef: 'main' }),
      recent: [],
      favorites: [],
      merged: [],
      fetching: false,
    });
    expect(unborn.unborn).toBe(true);
  });
});

describe('shownMerged', () => {
  it("marks merged branches with work of their own, not one sitting on main's tip", () => {
    const MAIN = 'm'.repeat(40);
    const refs = [
      ref('origin/main', 'remote', { sha: MAIN }),
      ref('landed', 'head', { sha: 'b'.repeat(40) }),
      ref('just-made', 'head', { sha: MAIN }),
    ];
    expect(shownMerged(refs, ['landed', 'just-made'], 'origin/main')).toEqual(['landed']);
    expect(shownMerged(refs, ['landed'], undefined)).toEqual([]);
  });
});

describe('cleanupCandidates', () => {
  const MAIN = 'm'.repeat(40);
  const refs = [
    ref('main', 'head', { isHead: true, upstream: 'origin/main', sha: MAIN }),
    ref('merged-one', 'head', { sha: 'b'.repeat(40) }),
    ref('squashed', 'head', { upstream: 'origin/squashed', upstreamGone: true, sha: 'c'.repeat(40) }),
    ref('both', 'head', { upstream: 'origin/both', upstreamGone: true, sha: 'd'.repeat(40) }),
    ref('just-made', 'head', { sha: MAIN }),
    ref('active', 'head', { upstream: 'origin/active', sha: 'e'.repeat(40) }),
    ref('origin/main', 'remote', { sha: MAIN }),
  ];

  it('offers the merged and the orphaned, never the checked-out one', () => {
    const out = cleanupCandidates(refs, ['merged-one', 'both', 'main', 'just-made'], MAIN);
    expect(out.map((c) => [c.name, c.merged, c.gone, c.atMain])).toEqual([
      ['both', true, true, false],
      ['just-made', true, false, true],
      ['merged-one', true, false, false],
      ['squashed', false, true, false],
    ]);
  });

  it('ticks only what is merged with commits of its own', () => {
    const out = cleanupCandidates(refs, ['merged-one', 'both', 'just-made'], MAIN);
    expect(out.filter(preTicked).map((c) => c.name)).toEqual(['both', 'merged-one']);
  });
});
