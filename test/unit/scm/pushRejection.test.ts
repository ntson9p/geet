import { describe, expect, it } from 'vitest';
import {
  canUpdateAndRetry,
  isForcePush,
  MAX_PUSH_ATTEMPTS,
  pushFailureLine,
  pushRejectedChoices,
  pushRejectionOf,
  rejectedRefs,
  type RetryContext,
} from '../../../src/scm/dialogs/pushRejection';

/**
 * POST-P14af. The samples are git's own output — the first captured from git
 * 2.28 on Windows against a local bare remote, with the 8.3 temp path left in.
 */

const FETCH_FIRST = [
  'To C:\\Users\\ADA~1.LOV\\AppData\\Local\\Temp\\sbx\\remote1.git',
  ' ! [rejected]        master -> master (fetch first)',
  "error: failed to push some refs to 'C:\\Users\\ADA~1.LOV\\AppData\\Local\\Temp\\sbx\\remote1.git'",
  'hint: Updates were rejected because the remote contains work that you do',
  'hint: not have locally. This is usually caused by another repository pushing',
  'hint: to the same ref. You may want to first integrate the remote changes',
  "hint: (e.g., 'git pull ...') before pushing again.",
  "hint: See the 'Note about fast-forwards' in 'git push --help' for details.",
].join('\n');

const NON_FAST_FORWARD = [
  'To github.com:team/app.git',
  ' ! [rejected]        feature/x -> feature/x (non-fast-forward)',
  "error: failed to push some refs to 'github.com:team/app.git'",
  'hint: Updates were rejected because the tip of your current branch is behind',
].join('\r\n');

const STALE_LEASE = [
  'To ../remote.git',
  ' ! [rejected]        main -> main (stale info)',
  "error: failed to push some refs to '../remote.git'",
].join('\n');

const HOOK_DECLINED = [
  'remote: error: GH006: Protected branch update failed for refs/heads/main.',
  'To github.com:team/app.git',
  ' ! [remote rejected] main -> main (protected branch hook declined)',
  "error: failed to push some refs to 'github.com:team/app.git'",
].join('\n');

describe('rejectedRefs / pushRejectionOf', () => {
  it('reads "fetch first" — the remote has commits you do not — as behind', () => {
    expect(pushRejectionOf(FETCH_FIRST)).toEqual({ rejection: 'behind', reason: 'fetch first' });
  });

  it('reads "non-fast-forward" as behind too, CRLF and all', () => {
    expect(pushRejectionOf(NON_FAST_FORWARD)).toEqual({
      rejection: 'behind',
      reason: 'non-fast-forward',
    });
  });

  it('reads the porcelain form the same way', () => {
    const porcelain = [
      'To C:/tmp/remote.git',
      '!\trefs/heads/master:refs/heads/master\t[rejected] (fetch first)',
      'Done',
    ].join('\n');
    expect(pushRejectionOf(porcelain)?.rejection).toBe('behind');
  });

  it('keeps a stale lease apart: no update makes a force push go through', () => {
    expect(pushRejectionOf(STALE_LEASE)).toEqual({ rejection: 'stale', reason: 'stale info' });
  });

  it('reports what the remote itself refused, with its reason', () => {
    expect(pushRejectionOf(HOOK_DECLINED)).toEqual({
      rejection: 'other',
      reason: 'protected branch hook declined',
    });
  });

  it('prefers behind when several refs were refused for different reasons', () => {
    const mixed = [
      ' ! [rejected]        v1.0 -> v1.0 (already exists)',
      ' ! [rejected]        main -> main (fetch first)',
    ].join('\n');
    expect(rejectedRefs(mixed).map((r) => r.rejection)).toEqual(['other', 'behind']);
    expect(pushRejectionOf(mixed)?.rejection).toBe('behind');
  });

  it('ignores a remote: line that merely quotes a status', () => {
    expect(pushRejectionOf('remote: ! [rejected] main -> main (fetch first)')).toBeUndefined();
  });

  it('is undefined when nothing was refused — the push failed some other way', () => {
    expect(pushRejectionOf("fatal: Authentication failed for 'https://example.com/r.git/'")).toBeUndefined();
    expect(pushRejectionOf("error: failed to push some refs to 'C:/r.git'")).toBeUndefined();
    expect(pushRejectionOf('')).toBeUndefined();
  });
});

describe('isForcePush', () => {
  it('knows every spelling of force', () => {
    expect(isForcePush(['push', '--force-with-lease', 'origin', 'main'])).toBe(true);
    expect(isForcePush(['push', '--force-with-lease=main:abc', 'origin', 'main'])).toBe(true);
    expect(isForcePush(['push', '--force', 'origin', 'main'])).toBe(true);
    expect(isForcePush(['push', '-f'])).toBe(true);
  });

  it('is false for an ordinary push, --force-if-includes on its own included', () => {
    expect(isForcePush(['push', 'origin', 'main:refs/heads/main'])).toBe(false);
    expect(isForcePush(['push', '--follow-tags', '--no-verify', 'origin', 'main'])).toBe(false);
  });
});

describe('canUpdateAndRetry', () => {
  const offered: RetryContext = {
    rejection: 'behind',
    force: false,
    current: true,
    toUpstream: true,
    busy: false,
  };

  it("offers Merge / Rebase for IntelliJ's case: current branch, own upstream, remote moved on", () => {
    expect(canUpdateAndRetry(offered)).toBe(true);
  });

  it.each([
    ['a stale lease', { rejection: 'stale' as const }],
    ['a refusal by the remote', { rejection: 'other' as const }],
    ['no rejection at all', { rejection: undefined }],
    ['a force push', { force: true }],
    ['a branch that is not checked out', { current: false }],
    ['a push to somewhere other than the upstream', { toUpstream: false }],
    ['a merge or rebase already in progress', { busy: true }],
  ])('does not for %s', (_name, change) => {
    expect(canUpdateAndRetry({ ...offered, ...change })).toBe(false);
  });
});

describe('pushRejectedChoices', () => {
  it('puts the last answer first, as Update Project does', () => {
    expect(pushRejectedChoices('merge', false)).toEqual(['merge', 'rebase']);
    expect(pushRejectedChoices('rebase', false)).toEqual(['rebase', 'merge']);
  });

  it('puts Merge first over unpushed merge commits, whatever was chosen before', () => {
    expect(pushRejectedChoices('rebase', true)).toEqual(['merge', 'rebase']);
    expect(pushRejectedChoices('merge', true)).toEqual(['merge', 'rebase']);
  });

  it('never offers Reset: the question is how to merge, not whether to discard', () => {
    expect(pushRejectedChoices('merge', false)).not.toContain('reset');
  });
});

describe('pushFailureLine', () => {
  it("takes git's fatal/error line, not the 'To <url>' line above it", () => {
    expect(pushFailureLine(FETCH_FIRST)).toBe(
      "failed to push some refs to 'C:\\Users\\ADA~1.LOV\\AppData\\Local\\Temp\\sbx\\remote1.git'",
    );
    expect(pushFailureLine("fatal: Authentication failed for 'https://example.com/r.git/'")).toBe(
      "Authentication failed for 'https://example.com/r.git/'",
    );
  });

  it('falls back to the first line that is neither a destination nor a hint', () => {
    expect(pushFailureLine('To x\nhint: y\nsomething odd happened\n')).toBe('something odd happened');
    expect(pushFailureLine('')).toBe('');
  });
});

describe('MAX_PUSH_ATTEMPTS', () => {
  it('allows a second round for a remote that moved again, and is bounded', () => {
    expect(MAX_PUSH_ATTEMPTS).toBeGreaterThan(1);
    expect(MAX_PUSH_ATTEMPTS).toBeLessThanOrEqual(10);
  });
});
