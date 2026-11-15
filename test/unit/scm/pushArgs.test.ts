import { describe, expect, it } from 'vitest';
import { formatGitCommand } from '../../../src/scm/dialogs/commandLine';
import {
  buildPushArgs,
  splitUpstream,
  type PushArgsOptions,
} from '../../../src/scm/dialogs/pushArgs';

/**
 * P13-T1 accept: "argv assembly for every flag combination, including
 * tags-with-force and publish-branch". The dialog's "will run" line and the
 * host's execution both call `buildPushArgs`, so these tests pin what the user
 * is shown as much as what runs.
 */

const BASE: PushArgsOptions = {
  remote: 'origin',
  refspec: 'refs/heads/feature/x:refs/heads/feature/x',
  setUpstream: false,
  tags: 'none',
  runHooks: true,
  force: false,
  forceIfIncludes: false,
};

const args = (over: Partial<PushArgsOptions> = {}): string[] =>
  buildPushArgs({ ...BASE, ...over });

describe('buildPushArgs', () => {
  it('always ends with an explicit remote + refspec', () => {
    expect(args()).toEqual(['push', 'origin', 'refs/heads/feature/x:refs/heads/feature/x']);
  });

  it('retargets through the refspec, not through the remote name', () => {
    expect(args({ refspec: 'refs/heads/feature/x:refs/heads/release/1.2' })).toEqual([
      'push',
      'origin',
      'refs/heads/feature/x:refs/heads/release/1.2',
    ]);
  });

  it('adds --no-verify when Run Git hooks is off', () => {
    expect(args({ runHooks: false })).toContain('--no-verify');
    expect(args({ runHooks: true })).not.toContain('--no-verify');
  });

  it('maps the tag modes onto --tags / --follow-tags / nothing', () => {
    expect(args({ tags: 'all' })).toContain('--tags');
    expect(args({ tags: 'all' })).not.toContain('--follow-tags');
    expect(args({ tags: 'follow' })).toContain('--follow-tags');
    expect(args({ tags: 'follow' })).not.toContain('--tags');
    const none = args({ tags: 'none' });
    expect(none).not.toContain('--tags');
    expect(none).not.toContain('--follow-tags');
  });

  it('forces with a lease, never bare --force (the P5 safety rule)', () => {
    const forced = args({ force: true });
    expect(forced).toContain('--force-with-lease');
    expect(forced).not.toContain('--force');
    expect(forced).not.toContain('--force-if-includes');
  });

  it('adds --force-if-includes only when the git build supports it', () => {
    expect(args({ force: true, forceIfIncludes: true })).toContain('--force-if-includes');
    // The cap is meaningless without the lease, and must not leak into a normal push.
    expect(args({ force: false, forceIfIncludes: true })).not.toContain('--force-if-includes');
  });

  it('combines tags with force (both flags, lease intact)', () => {
    const both = args({ tags: 'all', force: true, forceIfIncludes: true });
    expect(both).toEqual([
      'push',
      '--tags',
      '--force-with-lease',
      '--force-if-includes',
      'origin',
      'refs/heads/feature/x:refs/heads/feature/x',
    ]);
  });

  it('publishes a branch with --set-upstream before the refspec', () => {
    expect(args({ setUpstream: true })).toEqual([
      'push',
      '--set-upstream',
      'origin',
      'refs/heads/feature/x:refs/heads/feature/x',
    ]);
  });

  it('assembles the full matrix in a stable order', () => {
    expect(
      args({
        runHooks: false,
        tags: 'follow',
        force: true,
        forceIfIncludes: true,
        setUpstream: true,
        remote: 'upstream',
        refspec: 'refs/heads/main:refs/heads/main',
      }),
    ).toEqual([
      'push',
      '--no-verify',
      '--follow-tags',
      '--force-with-lease',
      '--force-if-includes',
      '--set-upstream',
      'upstream',
      'refs/heads/main:refs/heads/main',
    ]);
  });
});

describe('splitUpstream', () => {
  it('splits on the configured remote name', () => {
    expect(splitUpstream('origin/main', ['origin'])).toEqual({ remote: 'origin', branch: 'main' });
  });

  it('keeps slashes inside the branch name', () => {
    expect(splitUpstream('origin/feature/x', ['origin'])).toEqual({
      remote: 'origin',
      branch: 'feature/x',
    });
  });

  it('prefers the longest matching remote when names overlap', () => {
    expect(splitUpstream('team/fork/main', ['team', 'team/fork'])).toEqual({
      remote: 'team/fork',
      branch: 'main',
    });
  });

  it('falls back to the first slash when no remote matches', () => {
    expect(splitUpstream('gone/main', ['origin'])).toEqual({ remote: 'gone', branch: 'main' });
  });

  it('is undefined for a value with no slash at all', () => {
    expect(splitUpstream('main', ['origin'])).toBeUndefined();
  });
});

describe('formatGitCommand', () => {
  it('renders the plain case verbatim', () => {
    expect(formatGitCommand(['push', 'origin', 'main:refs/heads/main'])).toBe(
      'git push origin main:refs/heads/main',
    );
  });

  it('quotes arguments that would not survive a copy-paste', () => {
    expect(formatGitCommand(['push', 'origin', 'my branch:refs/heads/my branch'])).toBe(
      'git push origin "my branch:refs/heads/my branch"',
    );
  });

  it('POST-P14ck: quotes what a shell would glob or group with', () => {
    // Bare, a shell turned `[id].tsx` into `i.tsx d.tsx`; `(` does not parse.
    expect(formatGitCommand(['add', '--', '[id].tsx', ':(literal)[id].tsx', 'a*b', 'what?'])).toBe(
      'git add -- "[id].tsx" ":(literal)[id].tsx" "a*b" "what?"',
    );
    expect(formatGitCommand(['push', 'origin', 'refs/heads/*:refs/heads/*'])).toBe(
      'git push origin "refs/heads/*:refs/heads/*"',
    );
    // Everything else stays bare.
    expect(formatGitCommand(['stash', 'apply', 'stash@{0}', '--', 'src/a.ts'])).toBe(
      'git stash apply stash@{0} -- src/a.ts',
    );
  });
});
