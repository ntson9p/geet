import { describe, expect, it } from 'vitest';
import {
  acrossOffer,
  branchChoices,
  branchOfRemote,
  changes,
  checkoutArgs,
  listNames,
  planCheckout,
  stepFor,
  summarizeCheckout,
  type CheckoutResult,
  type RepoRefState,
} from '../../../src/branches/checkoutAcrossModel';

/**
 * POST-P14ax — one branch checked out in every repository: what each one does,
 * the argv it runs, what the picker and the menus offer, and the one summary.
 */
const repo = (label: string, extra: Partial<RepoRefState> = {}): RepoRefState => ({
  root: `/work/${label}`,
  label,
  head: 'main',
  locals: ['main'],
  remotes: [{ name: 'origin/main', remote: 'origin' }],
  tags: ['v1.0'],
  ...extra,
});
const RELEASE = { name: 'origin/release/2.0', remote: 'origin' };
// api has the branch; web and docs only on origin; infra not at all.
const api = repo('api', { locals: ['main', 'release/2.0'], remotes: [{ name: 'origin/main', remote: 'origin' }, RELEASE] });
const web = repo('web', { remotes: [{ name: 'origin/main', remote: 'origin' }, RELEASE] });
const docs = repo('docs', { remotes: [{ name: 'origin/main', remote: 'origin' }, RELEASE] });
const infra = repo('infra');
const release = { kind: 'branch', name: 'release/2.0' } as const;

describe('branchOfRemote', () => {
  it("is the remote branch's own name", () => {
    expect(branchOfRemote('origin/release/2.0', 'origin')).toBe('release/2.0');
    expect(branchOfRemote('upstream/main', 'upstream')).toBe('main');
    expect(branchOfRemote('main', 'origin')).toBe('main');
  });
});

describe('stepFor', () => {
  it('switches to a local branch of that name', () => {
    expect(stepFor(api, release)).toEqual({ kind: 'switch', root: '/work/api', name: 'release/2.0' });
  });

  it('makes a local branch tracking the remote one where there is no local branch', () => {
    expect(stepFor(web, release)).toEqual({
      kind: 'create',
      root: '/work/web',
      name: 'release/2.0',
      from: 'origin/release/2.0',
    });
  });

  it('leaves a repository with neither, and one already there', () => {
    expect(stepFor(infra, release)).toEqual({ kind: 'missing', root: '/work/infra' });
    expect(stepFor({ ...api, head: 'release/2.0' }, release)).toEqual({ kind: 'already', root: '/work/api' });
  });

  it('skips a repository mid-merge or mid-conflict, whatever it has', () => {
    expect(stepFor({ ...api, busy: 'it has conflicts to resolve' }, release)).toEqual({
      kind: 'busy',
      root: '/work/api',
      reason: 'it has conflicts to resolve',
    });
  });

  it('takes the branch from the remote asked for, else the one tracked, else origin', () => {
    const two = repo('two', {
      remotes: [
        { name: 'fork/release/2.0', remote: 'fork' },
        { name: 'origin/release/2.0', remote: 'origin' },
        { name: 'upstream/release/2.0', remote: 'upstream' },
      ],
    });
    expect(stepFor(two, { ...release, remote: 'upstream' })).toMatchObject({ from: 'upstream/release/2.0' });
    expect(stepFor({ ...two, trackingRemote: 'fork' }, release)).toMatchObject({ from: 'fork/release/2.0' });
    expect(stepFor(two, release)).toMatchObject({ from: 'origin/release/2.0' });
    expect(stepFor({ ...two, remotes: [two.remotes[2]!] }, release)).toMatchObject({ from: 'upstream/release/2.0' });
  });

  it('checks a tag out where the repository has it', () => {
    expect(stepFor(api, { kind: 'tag', name: 'v1.0' })).toEqual({ kind: 'tag', root: '/work/api', name: 'v1.0' });
    expect(stepFor(api, { kind: 'tag', name: 'v9' })).toEqual({ kind: 'missing', root: '/work/api' });
  });
});

describe('checkoutArgs', () => {
  it('switches with no `--`, which would restore files instead', () => {
    expect(checkoutArgs({ kind: 'switch', root: '/r', name: 'release/2.0' })).toEqual(['checkout', 'release/2.0']);
  });

  it('makes the new branch track the remote one, spelled out', () => {
    expect(checkoutArgs({ kind: 'create', root: '/r', name: 'release/2.0', from: 'origin/release/2.0' })).toEqual([
      'checkout',
      '-b',
      'release/2.0',
      '--track',
      'origin/release/2.0',
    ]);
  });

  it('forces when asked to throw local changes away', () => {
    expect(checkoutArgs({ kind: 'switch', root: '/r', name: 'x' }, true)).toEqual(['checkout', '-f', 'x']);
    expect(checkoutArgs({ kind: 'create', root: '/r', name: 'x', from: 'origin/x' }, true)).toEqual([
      'checkout',
      '-f',
      '-b',
      'x',
      '--track',
      'origin/x',
    ]);
  });

  it('runs nothing for a step that changes nothing', () => {
    expect(checkoutArgs({ kind: 'already', root: '/r' })).toEqual([]);
    expect(checkoutArgs({ kind: 'missing', root: '/r' })).toEqual([]);
  });
});

describe('planCheckout and acrossOffer', () => {
  it('plans every repository, in order', () => {
    expect(planCheckout([api, web, docs, infra], release).map((s) => s.kind)).toEqual([
      'switch',
      'create',
      'create',
      'missing',
    ]);
    expect(changes(planCheckout([api, web, docs, infra], release))).toHaveLength(3);
  });

  it('offers Checkout across repositories when it would change at least two', () => {
    expect(acrossOffer([api, web, docs, infra], release)).toEqual({ changes: 3, of: 4 });
  });

  it('leaves one repository to its own Checkout', () => {
    expect(acrossOffer([api], release)).toBeUndefined();
    expect(acrossOffer([api, infra], release)).toBeUndefined();
  });
});

describe('listNames', () => {
  it('joins names as a sentence does, and counts past the limit', () => {
    expect(listNames(['a', 'b', 'c'])).toBe('a, b and c');
    expect(listNames(['a', 'b', 'c', 'd', 'e'])).toBe('a, b, c and 2 more');
  });
});

describe('branchChoices', () => {
  const choices = branchChoices([api, web, docs, infra]);
  const named = (name: string) => choices.find((c) => c.name === name)!;

  it('offers every branch by its own name, local or remote, never origin/HEAD', () => {
    expect(choices.map((c) => c.name).sort()).toEqual(['main', 'release/2.0']);
    expect(branchChoices([repo('x', { remotes: [{ name: 'origin/HEAD', remote: 'origin' }] })]).map((c) => c.name)).toEqual(['main']);
  });

  it('says where it is: local, from which remote, and not', () => {
    expect(named('release/2.0')).toMatchObject({
      description: '3 of 4 repositories',
      detail: 'local in api · from origin in web and docs · not in infra',
      changes: 3,
    });
  });

  it('puts a branch checked out everywhere last', () => {
    expect(named('main')).toMatchObject({ description: 'checked out in all 4', changes: 0 });
    expect(choices.at(-1)?.name).toBe('main');
  });
});

describe('summarizeCheckout', () => {
  const ok = (label: string, extra: Partial<Extract<CheckoutResult, { kind: 'switched' }>> = {}): CheckoutResult => ({
    kind: 'switched',
    label,
    ...extra,
  });

  it('names where it went in, and where the branch is new', () => {
    const summary = summarizeCheckout(release, [
      ok('api'),
      ok('web', { created: 'origin/release/2.0' }),
      ok('docs', { created: 'origin/release/2.0' }),
      { kind: 'missing', label: 'infra', head: 'main' },
    ]);
    expect(summary).toEqual({
      kind: 'info',
      message:
        'Checked out release/2.0 in api, web and docs; in web and docs as a new branch tracking origin/release/2.0. infra has no branch release/2.0 and stays on main.',
      conflicts: false,
    });
  });

  it('says it once when every one of them is new', () => {
    expect(
      summarizeCheckout(release, [ok('web', { created: 'origin/release/2.0' }), ok('docs', { created: 'origin/release/2.0' })])
        .message,
    ).toBe('Checked out release/2.0 in web and docs, as a new branch tracking origin/release/2.0.');
  });

  it('puts what failed and what was left behind first, as a warning', () => {
    const summary = summarizeCheckout(release, [
      ok('api'),
      { kind: 'failed', label: 'web', reason: "'release/2.0' is already checked out at 'C:/w2'" },
      { kind: 'blocked', label: 'tools', head: 'main', files: ['config.txt'] },
    ]);
    expect(summary.kind).toBe('warning');
    expect(summary.message).toBe(
      "Couldn't check out release/2.0 in web: 'release/2.0' is already checked out at 'C:/w2'. tools stays on main: your local changes to config.txt would be overwritten. Checked out release/2.0 in api.",
    );
  });

  it('says what became of local changes that were in the way', () => {
    expect(summarizeCheckout(release, [ok('tools', { setAside: 'restored' })]).message).toBe(
      'Checked out release/2.0 in tools. Your local changes in tools were set aside and put back.',
    );
    expect(summarizeCheckout(release, [ok('tools', { forced: true })]).message).toBe(
      'Checked out release/2.0 in tools. Your local changes in tools were discarded; Local History has them.',
    );
    const kept = summarizeCheckout(release, [ok('tools', { setAside: 'kept' })]);
    expect(kept.kind).toBe('warning');
    expect(kept.conflicts).toBe(true);
    expect(kept.message).toBe(
      'In tools, putting your local changes back conflicted; they are kept in the stash. Checked out release/2.0 in tools.',
    );
  });

  it('says who was already there, was or is as the sentence needs', () => {
    expect(summarizeCheckout(release, [ok('web'), { kind: 'already', label: 'api' }]).message).toBe(
      'Checked out release/2.0 in web. api was already on release/2.0.',
    );
    expect(summarizeCheckout(release, [{ kind: 'already', label: 'api' }, { kind: 'already', label: 'web' }]).message).toBe(
      'api and web are already on release/2.0.',
    );
  });

  it('names what was skipped and what Cancel left out', () => {
    const summary = summarizeCheckout(release, [
      ok('api'),
      { kind: 'notAttempted', label: 'web' },
      { kind: 'busy', label: 'tools', reason: 'it has conflicts to resolve' },
    ]);
    expect(summary.kind).toBe('warning');
    expect(summary.message).toBe(
      'Checked out release/2.0 in api. Cancelled before web. Skipped tools (it has conflicts to resolve).',
    );
  });

  it('calls a tag a tag', () => {
    expect(summarizeCheckout({ kind: 'tag', name: 'v1.0' }, [ok('api'), { kind: 'missing', label: 'web' }]).message).toBe(
      'Checked out tag v1.0 in api. web has no tag v1.0.',
    );
  });
});
