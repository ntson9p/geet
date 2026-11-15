import { describe, expect, it } from 'vitest';
import {
  addRecentPushTarget,
  branchSource,
  defaultPushTarget,
  defaultRemote,
  forcePushConfirmation,
  initiallyChecked,
  isBranchProtected,
  outgoingRange,
  pushDialogTitle,
  pushRefspec,
  pushWithoutDialog,
  remembersTarget,
  revisionSource,
  RECENT_PUSH_TARGETS_LIMIT,
  setsUpstream,
  shortHash,
  showsUpstreamCheckbox,
  targetBadge,
  targetVariants,
  typedTarget,
  uniqueDetachedName,
  upstreamCheckboxBase,
  type PushRowFacts,
  type PushTargetSpec,
  type RecentPushTarget,
  type TargetContext,
} from '../../../src/scm/dialogs/pushModel';

/**
 * The Push dialog's rules, as IntelliJ's `GitPushSupport`, `GitPushTarget`,
 * `GitPushOperation`, `GitPushTargetPanel` and `ForcePushAction` have them.
 */

const SHA = '1393301c5d7e9f0a1b2c3d4e5f60718293a4b5c6';

function ctx(over: Partial<TargetContext> = {}): TargetContext {
  return {
    remotes: ['origin', 'upstream'],
    remoteBranches: new Map([
      ['origin', new Set(['main', 'feature'])],
      ['upstream', new Set(['main'])],
    ]),
    ...over,
  };
}

describe('sources', () => {
  it('a branch pushes its full ref and shows its name', () => {
    expect(branchSource('feature/x')).toEqual({
      kind: 'branch',
      presentation: 'feature/x',
      revision: 'refs/heads/feature/x',
      branch: 'feature/x',
    });
  });

  it('a commit shows IntelliJ’s eight-character hash, keeping the branch it is on', () => {
    expect(shortHash(SHA)).toBe('1393301c');
    expect(revisionSource(SHA, 'main')).toEqual({
      kind: 'revision',
      presentation: '1393301c',
      revision: SHA,
      branch: 'main',
    });
    expect(revisionSource(SHA)).toEqual({ kind: 'detached', presentation: '1393301c', revision: SHA });
  });
});

describe('defaultPushTarget', () => {
  it('prefers origin, else the first remote', () => {
    expect(defaultRemote(['upstream', 'origin'])).toBe('origin');
    expect(defaultRemote(['fork', 'upstream'])).toBe('fork');
    expect(defaultRemote([])).toBeUndefined();
  });

  it('goes to the branch the source tracks', () => {
    const t = defaultPushTarget(branchSource('feature'), ctx({ tracking: { remote: 'upstream', branch: 'main' } }));
    expect(t).toEqual({ remote: 'upstream', branch: 'main', isNew: false, type: 'tracking' });
  });

  it('pushes to a tracked branch the remote deleted as a new branch', () => {
    const t = defaultPushTarget(branchSource('gone'), ctx({ tracking: { remote: 'origin', branch: 'gone' } }));
    expect(t).toMatchObject({ remote: 'origin', branch: 'gone', isNew: true });
  });

  it('without an upstream, offers the same name on origin — New when it is not there', () => {
    expect(defaultPushTarget(branchSource('feature'), ctx())).toEqual({
      remote: 'origin',
      branch: 'feature',
      isNew: false,
      type: 'tracking',
    });
    expect(defaultPushTarget(branchSource('topic'), ctx())).toEqual({
      remote: 'origin',
      branch: 'topic',
      isNew: true,
      type: 'tracking',
    });
  });

  it('honours the remote’s push spec first, a Gerrit ref included', () => {
    const gerrit = ctx({ pushSpecs: new Map([['origin', ['HEAD:refs/for/main']]]) });
    expect(defaultPushTarget(branchSource('feature'), gerrit)).toEqual({
      remote: 'origin',
      branch: 'refs/for/main',
      isNew: true,
      special: true,
      type: 'pushSpec',
    });
    const mapped = ctx({ pushSpecs: new Map([['origin', ['refs/heads/*:refs/heads/team/*']]]) });
    expect(defaultPushTarget(branchSource('feature'), mapped)).toEqual({
      remote: 'origin',
      branch: 'team/feature',
      isNew: true,
      type: 'pushSpec',
    });
  });

  it('a commit of Push All up to Here goes where its branch goes', () => {
    const t = defaultPushTarget(revisionSource(SHA, 'main'), ctx({ tracking: { remote: 'origin', branch: 'main' } }));
    expect(t).toMatchObject({ remote: 'origin', branch: 'main', isNew: false });
  });

  it('a detached commit goes to the current branch’s name, or to a fresh `detached`', () => {
    expect(defaultPushTarget(revisionSource(SHA), ctx({ currentBranch: 'main' }))).toMatchObject({
      branch: 'main',
      isNew: false,
    });
    expect(defaultPushTarget(revisionSource(SHA), ctx())).toMatchObject({ branch: 'detached', isNew: true });
  });

  it('is undefined with no remote: the row offers Define remote', () => {
    expect(defaultPushTarget(branchSource('main'), ctx({ remotes: [], remoteBranches: new Map() }))).toBeUndefined();
  });

  it('names a detached branch the remote does not have yet', () => {
    expect(uniqueDetachedName(new Set())).toBe('detached');
    expect(uniqueDetachedName(new Set(['detached']))).toBe('detached2');
    expect(uniqueDetachedName(new Set(['detached', 'detached2']))).toBe('detached3');
  });

  it('a typed target is New exactly when the remote has no such branch', () => {
    expect(typedTarget(ctx(), 'origin', 'main')).toEqual({ remote: 'origin', branch: 'main', isNew: false, type: 'custom' });
    expect(typedTarget(ctx(), 'upstream', 'feature')).toMatchObject({ isNew: true });
  });
});

describe('what is pushed', () => {
  const existing: PushTargetSpec = { remote: 'origin', branch: 'main', isNew: false, type: 'tracking' };
  const fresh: PushTargetSpec = { remote: 'origin', branch: 'topic', isNew: true, type: 'custom' };

  it('lists the outgoing commits as IntelliJ’s GitOutgoingCommitsProvider does', () => {
    expect(outgoingRange(branchSource('main'), existing)).toEqual(['refs/remotes/origin/main..refs/heads/main']);
    expect(outgoingRange(branchSource('topic'), fresh)).toEqual([
      'refs/heads/topic',
      '--not',
      '--remotes=origin',
    ]);
    expect(outgoingRange(revisionSource(SHA, 'main'), existing)).toEqual([`refs/remotes/origin/main..${SHA}`]);
  });

  it('builds an explicit refspec, a whole ref kept as it is', () => {
    expect(pushRefspec(branchSource('main'), existing)).toBe('refs/heads/main:refs/heads/main');
    expect(pushRefspec(revisionSource(SHA, 'main'), existing)).toBe(`${SHA}:refs/heads/main`);
    expect(
      pushRefspec(branchSource('main'), { remote: 'origin', branch: 'refs/for/main', isNew: true, special: true, type: 'pushSpec' }),
    ).toBe('refs/heads/main:refs/for/main');
  });

  it('sets the upstream of a branch pushed to a new branch, unless it tracks one', () => {
    expect(setsUpstream(branchSource('topic'), fresh, false, false)).toBe(true);
    expect(setsUpstream(branchSource('topic'), fresh, true, false)).toBe(false);
    expect(setsUpstream(branchSource('main'), existing, true, false)).toBe(false);
  });

  it('sets it whenever Set upstream is ticked', () => {
    expect(setsUpstream(branchSource('main'), existing, true, true)).toBe(true);
  });

  it('never for a commit pushed on its own, nor for a special ref', () => {
    expect(setsUpstream(revisionSource(SHA, 'main'), fresh, false, true)).toBe(false);
    expect(setsUpstream(revisionSource(SHA), fresh, false, false)).toBe(false);
    const special: PushTargetSpec = { remote: 'origin', branch: 'refs/for/main', isNew: true, special: true, type: 'pushSpec' };
    expect(setsUpstream(branchSource('main'), special, false, false)).toBe(false);
  });
});

describe('Set upstream and the labels', () => {
  const tracked: PushTargetSpec = { remote: 'origin', branch: 'main', isNew: false, type: 'tracking' };

  it('exists only for a branch whose default target is a branch the remote has', () => {
    expect(upstreamCheckboxBase(branchSource('main'), tracked)).toEqual({ remote: 'origin', branch: 'main' });
    expect(upstreamCheckboxBase(branchSource('main'), { ...tracked, isNew: true })).toBeUndefined();
    expect(upstreamCheckboxBase(branchSource('main'), { ...tracked, type: 'pushSpec' })).toBeUndefined();
    expect(upstreamCheckboxBase(revisionSource(SHA, 'main'), tracked)).toBeUndefined();
    expect(upstreamCheckboxBase(branchSource('main'), undefined)).toBeUndefined();
  });

  it('shows while the typed target is valid and not the upstream already', () => {
    const base = { remote: 'origin', branch: 'main' };
    expect(showsUpstreamCheckbox(base, 'origin', 'main')).toBe(false);
    expect(showsUpstreamCheckbox(base, 'origin', 'release')).toBe(true);
    expect(showsUpstreamCheckbox(base, 'upstream', 'main')).toBe(true);
    expect(showsUpstreamCheckbox(base, 'origin', 'bad name')).toBe(false);
    expect(showsUpstreamCheckbox(undefined, 'origin', 'release')).toBe(false);
  });

  it('labels New, Upstream, or both', () => {
    const base = { remote: 'origin', branch: 'main' };
    const fresh: PushTargetSpec = { remote: 'origin', branch: 'topic', isNew: true, type: 'custom' };
    const other: PushTargetSpec = { remote: 'origin', branch: 'release', isNew: false, type: 'custom' };
    expect(targetBadge(fresh, base, false)).toBe('New');
    expect(targetBadge(fresh, base, true)).toBe('New & Upstream');
    expect(targetBadge(other, base, true)).toBe('Upstream');
    expect(targetBadge(other, base, false)).toBeUndefined();
    // Ticking it for the upstream itself changes nothing.
    expect(targetBadge(tracked, base, true)).toBeUndefined();
  });
});

describe('Force Push', () => {
  it('protects master and main by default, matching whole names only', () => {
    expect(isBranchProtected('main', ['master', 'main'])).toBe(true);
    expect(isBranchProtected('main-copy', ['master', 'main'])).toBe(false);
    expect(isBranchProtected('release/1.2', ['release/.*'])).toBe(true);
    // `a|b` is still a whole-name match for each.
    expect(isBranchProtected('xb', ['a|b'])).toBe(false);
    expect(isBranchProtected('b', ['a|b'])).toBe(true);
  });

  it('ignores a pattern that is not a regular expression', () => {
    expect(isBranchProtected('main', ['[unclosed'])).toBe(false);
  });

  it('names the target when there is one to warn about', () => {
    const one = forcePushConfirmation([{ remote: 'origin', branch: 'feature' }], []);
    expect(one?.message).toBe(
      "You're going to force push to 'feature'. It may overwrite commits at the remote. Are you sure you want to proceed?",
    );
    expect(one?.target).toEqual({ remote: 'origin', branch: 'feature' });
  });

  it('warns in general for several, without Don’t warn', () => {
    const two = forcePushConfirmation(
      [
        { remote: 'origin', branch: 'a' },
        { remote: 'origin', branch: 'b' },
      ],
      [],
    );
    expect(two?.message).toBe(
      "You're going to force push. It may overwrite commits at the remote. Are you sure you want to proceed?",
    );
    expect(two?.target).toBeUndefined();
  });

  it('asks nothing once every target was marked Don’t warn, and only about the rest otherwise', () => {
    const silent = [{ remote: 'origin', branch: 'a' }];
    expect(forcePushConfirmation([{ remote: 'origin', branch: 'a' }], silent)).toBeUndefined();
    const rest = forcePushConfirmation(
      [
        { remote: 'origin', branch: 'a' },
        { remote: 'origin', branch: 'b' },
      ],
      silent,
    );
    expect(rest?.target).toEqual({ remote: 'origin', branch: 'b' });
  });
});

describe('recent targets', () => {
  const entry = (branch: string, sourceBranch = 'main'): RecentPushTarget => ({ sourceBranch, remote: 'origin', branch });

  it('puts the latest first, once', () => {
    const list = addRecentPushTarget(addRecentPushTarget([], entry('review-a')), entry('review-b'));
    expect(list.map((e) => e.branch)).toEqual(['review-b', 'review-a']);
    expect(addRecentPushTarget(list, entry('review-a')).map((e) => e.branch)).toEqual(['review-a', 'review-b']);
  });

  it('keeps ten per repository', () => {
    let list: RecentPushTarget[] = [];
    for (let i = 1; i <= 11; i++) list = addRecentPushTarget(list, entry(`review-${i}`));
    expect(list).toHaveLength(RECENT_PUSH_TARGETS_LIMIT);
    expect(list[0]?.branch).toBe('review-11');
    expect(list.map((e) => e.branch)).not.toContain('review-1');
  });

  it('remembers only a push somewhere other than the default', () => {
    const def: PushTargetSpec = { remote: 'origin', branch: 'main', isNew: false, type: 'tracking' };
    expect(remembersTarget(branchSource('main'), def, def)).toBe(false);
    expect(remembersTarget(branchSource('main'), { ...def, branch: 'feature', type: 'custom' }, def)).toBe(true);
    expect(remembersTarget(revisionSource(SHA), { ...def, branch: 'x' }, def)).toBe(false);
    const special: PushTargetSpec = { remote: 'origin', branch: 'refs/for/x', isNew: true, special: true, type: 'pushSpec' };
    expect(remembersTarget(branchSource('main'), special, def)).toBe(false);
  });

  it('suggests the current remote’s recent targets, then every remote branch, origin first', () => {
    const recent = [entry('review-b'), { sourceBranch: 'main', remote: 'upstream', branch: 'elsewhere' }, entry('review-a')];
    const variants = targetVariants(recent, 'origin', [
      { remote: 'upstream', branch: 'zeta' },
      { remote: 'origin', branch: 'main' },
      { remote: 'fork', branch: 'alpha' },
      { remote: 'origin', branch: 'review-a' },
    ]);
    expect(variants).toEqual([
      { name: 'review-b', recent: true },
      { name: 'review-a', recent: true },
      { name: 'main', recent: false },
      { name: 'alpha', recent: false },
      { name: 'zeta', recent: false },
    ]);
  });
});

describe('the dialog', () => {
  it('is titled for the one repository, or generically for several', () => {
    expect(pushDialogTitle(['GitDoc'])).toBe('Push Commits to GitDoc');
    expect(pushDialogTitle(['a', 'b'])).toBe('Push Commits');
  });

  it('checks the only repository, the ones asked for, else the one the user is in', () => {
    const asked = new Set(['/a']);
    expect(initiallyChecked('/x', { single: true, preselected: new Set() })).toBe(true);
    expect(initiallyChecked('/a', { single: false, preselected: asked })).toBe(true);
    expect(initiallyChecked('/b', { single: false, preselected: asked, current: '/b' })).toBe(false);
    expect(initiallyChecked('/b', { single: false, preselected: new Set(), current: '/b' })).toBe(true);
    expect(initiallyChecked('/c', { single: false, preselected: new Set(), current: '/b' })).toBe(false);
  });
});

/**
 * POST-P14cn: with `gittree.push.showDialog` off, a Push posts what the dialog
 * would post had Push been pressed the moment it opened, and opens the dialog
 * instead only when that push cannot go ahead (IntelliJ's
 * `GitPushAfterCommitDialog.shouldShow`: `!canPush`).
 */
describe('a Push without the dialog', () => {
  const tracking = (remote: string, branch: string): PushTargetSpec => ({
    remote,
    branch,
    isNew: false,
    type: 'tracking',
  });
  const row = (over: Partial<PushRowFacts> = {}): PushRowFacts => ({
    root: '/repos/app',
    label: 'app',
    source: branchSource('main'),
    target: tracking('origin', 'main'),
    checked: true,
    ...over,
  });

  it('pushes each row to the target it opens with, with the footer as it opens', () => {
    expect(pushWithoutDialog([row()], 'none')).toEqual({
      kind: 'push',
      result: {
        repos: [
          {
            root: '/repos/app',
            source: { kind: 'branch', presentation: 'main', revision: 'refs/heads/main', branch: 'main' },
            target: { remote: 'origin', branch: 'main' },
            setUpstream: false,
          },
        ],
        tags: 'none',
        runHooks: true,
        force: false,
      },
    });
  });

  it('keeps the tag mode the last push used', () => {
    for (const tags of ['all', 'follow'] as const) {
      const plan = pushWithoutDialog([row()], tags);
      expect(plan.kind === 'push' ? plan.result.tags : undefined).toBe(tags);
    }
  });

  it('publishes a branch that tracks nothing: a new branch of its name, as the dialog offers', () => {
    const source = branchSource('feature/x');
    const target = defaultPushTarget(source, ctx())!;
    expect(target).toEqual({ remote: 'origin', branch: 'feature/x', isNew: true, type: 'tracking' });
    const plan = pushWithoutDialog([row({ source, target })], 'none');
    expect(plan.kind).toBe('push');
    if (plan.kind !== 'push') return;
    expect(plan.result.repos[0]!.target).toEqual({ remote: 'origin', branch: 'feature/x' });
    // `Set upstream` is the dialog's checkbox, and stays unticked: the new
    // branch becomes the upstream on IntelliJ's own rule.
    expect(plan.result.repos[0]!.setUpstream).toBe(false);
    expect(setsUpstream(source, target, false, false)).toBe(true);
  });

  it('pushes a commit on a branch to that branch’s target: Push All up to Here', () => {
    const source = revisionSource(SHA, 'main');
    const plan = pushWithoutDialog([row({ source })], 'none');
    expect(plan.kind).toBe('push');
    if (plan.kind !== 'push') return;
    expect(plan.result.repos[0]!.source).toEqual(source);
    expect(pushRefspec(source, tracking('origin', 'main'))).toBe(`${SHA}:refs/heads/main`);
  });

  it('pushes several repositories in the order given', () => {
    const plan = pushWithoutDialog(
      [row({ root: '/repos/api', label: 'api' }), row({ root: '/repos/web', label: 'web', target: tracking('upstream', 'dev') })],
      'none',
    );
    expect(plan.kind === 'push' ? plan.result.repos.map((r) => [r.root, r.target]) : []).toEqual([
      ['/repos/api', { remote: 'origin', branch: 'main' }],
      ['/repos/web', { remote: 'upstream', branch: 'dev' }],
    ]);
  });

  it('opens the dialog when nothing says which repository to push', () => {
    expect(pushWithoutDialog([], 'none')).toEqual({ kind: 'dialog', need: { kind: 'nothingChosen' } });
  });

  it('opens the dialog for an empty repository, one with no remote, and a commit on no branch', () => {
    expect(pushWithoutDialog([row({ error: 'Empty repository' })], 'none')).toEqual({
      kind: 'dialog',
      need: { kind: 'emptyRepository', repo: 'app' },
    });
    const { target: _none, ...noTarget } = row();
    expect(pushWithoutDialog([noTarget], 'none')).toEqual({
      kind: 'dialog',
      need: { kind: 'noRemote', repo: 'app' },
    });
    // A detached HEAD's default target is a made-up `detached` branch.
    const detached = revisionSource(SHA);
    expect(detached.kind).toBe('detached');
    expect(
      pushWithoutDialog([row({ source: detached, target: { remote: 'origin', branch: 'detached', isNew: true, type: 'tracking' } })], 'none'),
    ).toEqual({ kind: 'dialog', need: { kind: 'noBranch', repo: 'app', commit: shortHash(SHA) } });
  });

  it('opens the dialog for a repository whose commits could not be listed: the dialog would leave it unticked', () => {
    expect(pushWithoutDialog([row({ checked: false })], 'none')).toEqual({
      kind: 'dialog',
      need: { kind: 'commitsUnlisted', repo: 'app' },
    });
  });

  it('pushes nothing when any repository asked for cannot be pushed, and names the first', () => {
    const { target: _none, ...noTarget } = row({ root: '/repos/web', label: 'web' });
    expect(
      pushWithoutDialog([row({ root: '/repos/api', label: 'api' }), noTarget, row({ label: 'z', error: 'Empty repository' })], 'none'),
    ).toEqual({ kind: 'dialog', need: { kind: 'noRemote', repo: 'web' } });
  });

  it('pushes to a protected branch as the dialog’s Push does: only Force Push is refused there', () => {
    const plan = pushWithoutDialog([row({ target: tracking('origin', 'main') })], 'none');
    expect(isBranchProtected('main', ['master', 'main'])).toBe(true);
    expect(plan.kind === 'push' ? plan.result.force : undefined).toBe(false);
  });
});
