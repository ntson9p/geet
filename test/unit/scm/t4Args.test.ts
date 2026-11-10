import { describe, expect, it } from 'vitest';
import {
  buildCherryPickArgs,
  EMPTY_CHERRY_PICK_OPTIONS,
  validateCherryPickOptions,
  type CherryPickOptions,
} from '../../../src/scm/dialogs/cherryPickArgs';
import {
  buildCloneArgs,
  EMPTY_CLONE_OPTIONS,
  suggestedDirName,
  validateCloneOptions,
  type CloneOptions,
} from '../../../src/scm/dialogs/cloneArgs';
import {
  applicableDialogs,
  DIALOG_REGISTRY,
  EMPTY_DIALOG_CONTEXT,
  findDialog,
} from '../../../src/scm/dialogs/dialogRegistry';
import {
  buildRemoteAddArgs,
  buildRemotePruneArgs,
  buildRemoteRemoveArgs,
  planRemoteEdit,
  validateRemoteEdit,
} from '../../../src/scm/dialogs/remoteArgs';
import {
  buildStashApplyArgs,
  buildStashPushArgs,
  EMPTY_STASH_PUSH_OPTIONS,
  validateStashPushOptions,
  type StashPushArgsOptions,
} from '../../../src/scm/dialogs/stashArgs';

/** P13-T4: one assertion per flag, per the phase plan's accept line. */

// ---- Cherry-pick ------------------------------------------------------------

const pick = (over: Partial<CherryPickOptions> = {}): string[] =>
  buildCherryPickArgs({ ...EMPTY_CHERRY_PICK_OPTIONS, shas: ['abc1234'], ...over });

describe('buildCherryPickArgs', () => {
  it('records the origin by default — IntelliJ ticks -x', () => {
    expect(pick()).toEqual(['cherry-pick', '-x', 'abc1234']);
  });

  it('drops -x when asked to', () => {
    expect(pick({ recordOrigin: false })).toEqual(['cherry-pick', 'abc1234']);
  });

  it('emits --no-commit, and then -x would have nothing to write into', () => {
    expect(pick({ noCommit: true })).toEqual(['cherry-pick', '--no-commit', 'abc1234']);
  });

  it('emits -m <parent> for a merge commit', () => {
    expect(pick({ mainline: 1 })).toEqual(['cherry-pick', '-x', '-m', '1', 'abc1234']);
  });

  it('replays several commits in the given order', () => {
    expect(pick({ shas: ['aaa', 'bbb', 'ccc'] })).toEqual([
      'cherry-pick',
      '-x',
      'aaa',
      'bbb',
      'ccc',
    ]);
  });
});

describe('validateCherryPickOptions', () => {
  const opts = (over: Partial<CherryPickOptions>): CherryPickOptions => ({
    ...EMPTY_CHERRY_PICK_OPTIONS,
    shas: ['abc'],
    ...over,
  });

  it('requires at least one commit', () => {
    expect(validateCherryPickOptions(opts({ shas: [] }))).toHaveLength(1);
  });

  it('rejects a mainline parent across a range', () => {
    expect(validateCherryPickOptions(opts({ shas: ['a', 'b'], mainline: 1 })).join(' ')).toMatch(
      /one merge commit/,
    );
  });

  it('rejects a fractional mainline', () => {
    expect(validateCherryPickOptions(opts({ mainline: 1.5 })).join(' ')).toMatch(/whole number/);
  });
});

// ---- Stash ------------------------------------------------------------------

const stash = (over: Partial<StashPushArgsOptions> = {}): string[] =>
  buildStashPushArgs({ ...EMPTY_STASH_PUSH_OPTIONS, ...over });

describe('buildStashPushArgs', () => {
  it('includes untracked files by default', () => {
    expect(stash()).toEqual(['stash', 'push', '--include-untracked']);
  });

  it('emits --keep-index', () => {
    expect(stash({ keepIndex: true })).toEqual([
      'stash',
      'push',
      '--include-untracked',
      '--keep-index',
    ]);
  });

  it('emits --all instead of --include-untracked, never both', () => {
    const args = stash({ all: true });
    expect(args).toContain('--all');
    expect(args).not.toContain('--include-untracked');
  });

  it('emits --staged alone', () => {
    const args = stash({ staged: true, includeUntracked: true, all: true });
    expect(args).toEqual(['stash', 'push', '--staged']);
  });

  it('passes a trimmed message and a pathspec', () => {
    expect(stash({ message: '  wip  ', paths: ['a.txt', 'b.txt'] })).toEqual([
      'stash',
      'push',
      '--include-untracked',
      '-m',
      'wip',
      '--',
      'a.txt',
      'b.txt',
    ]);
  });

  it('can stash tracked changes only', () => {
    expect(stash({ includeUntracked: false })).toEqual(['stash', 'push']);
  });
});

describe('validateStashPushOptions', () => {
  it('rejects --staged with untracked or ignored files', () => {
    expect(
      validateStashPushOptions({ ...EMPTY_STASH_PUSH_OPTIONS, staged: true }).join(' '),
    ).toMatch(/cannot be combined/);
  });

  it('rejects --staged with --keep-index', () => {
    expect(
      validateStashPushOptions({
        ...EMPTY_STASH_PUSH_OPTIONS,
        includeUntracked: false,
        staged: true,
        keepIndex: true,
      }).join(' '),
    ).toMatch(/contradict/);
  });

  it('accepts the ordinary combinations', () => {
    expect(
      validateStashPushOptions({ ...EMPTY_STASH_PUSH_OPTIONS, keepIndex: true, all: true }),
    ).toEqual([]);
  });
});

describe('buildStashApplyArgs', () => {
  it('pops or applies the numbered entry', () => {
    expect(buildStashApplyArgs({ index: 0, pop: true, reinstateIndex: false })).toEqual([
      'stash',
      'pop',
      'stash@{0}',
    ]);
    expect(buildStashApplyArgs({ index: 2, pop: false, reinstateIndex: false })).toEqual([
      'stash',
      'apply',
      'stash@{2}',
    ]);
  });

  it('reinstates the index with --index', () => {
    expect(buildStashApplyArgs({ index: 1, pop: true, reinstateIndex: true })).toEqual([
      'stash',
      'pop',
      '--index',
      'stash@{1}',
    ]);
  });
});

// ---- Clone ------------------------------------------------------------------

const clone = (over: Partial<CloneOptions> = {}): string[] =>
  buildCloneArgs({
    ...EMPTY_CLONE_OPTIONS,
    url: 'https://host/team/repo.git',
    directory: 'D:/work/repo',
    ...over,
  });

describe('buildCloneArgs', () => {
  it('separates the URL from options with --', () => {
    expect(clone()).toEqual(['clone', '--', 'https://host/team/repo.git', 'D:/work/repo']);
  });

  it('emits --recurse-submodules', () => {
    expect(clone({ recursiveSubmodules: true })[1]).toBe('--recurse-submodules');
  });

  it('emits --depth only when positive', () => {
    expect(clone({ depth: 1 })).toContain('--depth');
    expect(clone({ depth: 0 })).not.toContain('--depth');
  });

  it('emits --branch when one is named', () => {
    expect(clone({ branch: 'develop' })).toContain('develop');
    expect(clone({ branch: '  ' })).not.toContain('--branch');
  });
});

describe('validateCloneOptions', () => {
  it('requires a URL and a directory', () => {
    expect(validateCloneOptions(EMPTY_CLONE_OPTIONS)).toHaveLength(2);
  });

  it('rejects a negative depth', () => {
    expect(
      validateCloneOptions({ ...EMPTY_CLONE_OPTIONS, url: 'u', directory: 'd', depth: -1 }),
    ).toHaveLength(1);
  });
});

describe('suggestedDirName', () => {
  it('strips .git and the path', () => {
    expect(suggestedDirName('https://host/team/repo.git')).toBe('repo');
    expect(suggestedDirName('https://host/team/repo')).toBe('repo');
    expect(suggestedDirName('https://host/team/repo/')).toBe('repo');
  });

  it('handles scp-style remotes', () => {
    expect(suggestedDirName('git@host:team/repo.git')).toBe('repo');
  });

  it('handles a local path', () => {
    expect(suggestedDirName('D:/mirrors/thing.git')).toBe('thing');
  });

  it('is empty for empty input', () => {
    expect(suggestedDirName('   ')).toBe('');
  });
});

// ---- Remotes ----------------------------------------------------------------

describe('remote argv', () => {
  it('adds, removes and prunes', () => {
    expect(buildRemoteAddArgs({ name: 'origin', fetchUrl: 'https://u', pushUrl: '' })).toEqual([
      'remote',
      'add',
      'origin',
      'https://u',
    ]);
    expect(buildRemoteRemoveArgs('origin')).toEqual(['remote', 'remove', 'origin']);
    expect(buildRemotePruneArgs('origin')).toEqual(['remote', 'prune', 'origin']);
  });
});

describe('validateRemoteEdit', () => {
  it('requires a name and a fetch URL', () => {
    expect(validateRemoteEdit({ name: '', fetchUrl: '', pushUrl: '' }, [])).toHaveLength(2);
  });

  it("rejects git's own illegal names", () => {
    expect(
      validateRemoteEdit({ name: 'has space', fetchUrl: 'u', pushUrl: '' }, []).join(' '),
    ).toMatch(/spaces or slashes/);
    expect(
      validateRemoteEdit({ name: 'a/b', fetchUrl: 'u', pushUrl: '' }, []).join(' '),
    ).toMatch(/spaces or slashes/);
  });

  it('rejects a duplicate, but lets a remote keep its own name', () => {
    expect(
      validateRemoteEdit({ name: 'origin', fetchUrl: 'u', pushUrl: '' }, ['origin']).join(' '),
    ).toMatch(/already exists/);
    expect(
      validateRemoteEdit({ name: 'origin', fetchUrl: 'u', pushUrl: '' }, ['origin'], 'origin'),
    ).toEqual([]);
  });
});

describe('planRemoteEdit', () => {
  it('adds a new remote, with its push URL when one is given', () => {
    expect(planRemoteEdit(undefined, { name: 'up', fetchUrl: 'F', pushUrl: '' })).toEqual([
      ['remote', 'add', 'up', 'F'],
    ]);
    expect(planRemoteEdit(undefined, { name: 'up', fetchUrl: 'F', pushUrl: 'P' })).toEqual([
      ['remote', 'add', 'up', 'F'],
      ['remote', 'set-url', '--push', 'up', 'P'],
    ]);
  });

  it('renames before touching URLs, so the later commands address the new name', () => {
    expect(
      planRemoteEdit(
        { name: 'old', fetchUrl: 'F', pushUrl: '' },
        { name: 'new', fetchUrl: 'F2', pushUrl: '' },
      ),
    ).toEqual([
      ['remote', 'rename', 'old', 'new'],
      ['remote', 'set-url', 'new', 'F2'],
    ]);
  });

  it('clears a push URL with --delete rather than setting it empty', () => {
    expect(
      planRemoteEdit(
        { name: 'up', fetchUrl: 'F', pushUrl: 'P' },
        { name: 'up', fetchUrl: 'F', pushUrl: '' },
      ),
    ).toEqual([['remote', 'set-url', '--push', '--delete', 'up', 'P']]);
  });

  it('plans nothing when nothing changed', () => {
    const same = { name: 'up', fetchUrl: 'F', pushUrl: 'P' };
    expect(planRemoteEdit(same, { ...same })).toEqual([]);
  });
});

// ---- Dialog registry --------------------------------------------------------

describe('DIALOG_REGISTRY', () => {
  it('has unique command ids', () => {
    const ids = DIALOG_REGISTRY.map((d) => d.command);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('offers only Clone with no repository open', () => {
    expect(applicableDialogs(EMPTY_DIALOG_CONTEXT).map((d) => d.command)).toEqual([
      'gittree.clone.dialog',
    ]);
  });

  it('gates the change dialogs on a dirty worktree', () => {
    const clean = applicableDialogs({ ...EMPTY_DIALOG_CONTEXT, hasRepo: true });
    expect(clean.map((d) => d.command)).not.toContain('gittree.stash.dialog');
    expect(clean.map((d) => d.command)).not.toContain('gittree.rollback.dialog');

    const dirty = applicableDialogs({ ...EMPTY_DIALOG_CONTEXT, hasRepo: true, dirty: true });
    expect(dirty.map((d) => d.command)).toContain('gittree.stash.dialog');
    expect(dirty.map((d) => d.command)).toContain('gittree.rollback.dialog');
    expect(dirty.map((d) => d.command)).toContain('gittree.commit');
  });

  it('gates Push on a remote and Update on an upstream', () => {
    const bare = applicableDialogs({ ...EMPTY_DIALOG_CONTEXT, hasRepo: true });
    expect(bare.map((d) => d.command)).not.toContain('gittree.push.dialog');
    expect(bare.map((d) => d.command)).not.toContain('gittree.update.dialog');

    const wired = applicableDialogs({
      ...EMPTY_DIALOG_CONTEXT,
      hasRepo: true,
      hasRemote: true,
      hasUpstream: true,
    });
    expect(wired.map((d) => d.command)).toContain('gittree.push.dialog');
    expect(wired.map((d) => d.command)).toContain('gittree.update.dialog');
  });

  it('POST-P14bm: offers Update Project Without Fetching where Update Project is, right after it', () => {
    const bare = applicableDialogs({ ...EMPTY_DIALOG_CONTEXT, hasRepo: true, hasRemote: true });
    expect(bare.map((d) => d.command)).not.toContain('gittree.update.withoutFetch');
    const wired = applicableDialogs({
      ...EMPTY_DIALOG_CONTEXT,
      hasRepo: true,
      hasRemote: true,
      hasUpstream: true,
    }).map((d) => d.command);
    expect(wired.indexOf('gittree.update.withoutFetch')).toBe(wired.indexOf('gittree.update.dialog') + 1);
    // The project, as Update Project is: never scoped down to the popup's repository.
    expect(DIALOG_REGISTRY.find((d) => d.command === 'gittree.update.withoutFetch')?.args).toEqual([]);
  });

  it('offers Unstash only when a stash exists', () => {
    expect(
      applicableDialogs({ ...EMPTY_DIALOG_CONTEXT, hasRepo: true }).map((d) => d.command),
    ).not.toContain('gittree.unstash.dialog');
    expect(
      applicableDialogs({ ...EMPTY_DIALOG_CONTEXT, hasRepo: true, hasStash: true }).map(
        (d) => d.command,
      ),
    ).toContain('gittree.unstash.dialog');
  });

  it('finds an entry by command id', () => {
    expect(findDialog('gittree.push.dialog')?.label).toBe('Push…');
    expect(findDialog('gittree.nope')).toBeUndefined();
  });
});
