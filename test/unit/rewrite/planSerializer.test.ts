import { describe, expect, it } from 'vitest';
import {
  interactiveRebaseArgs,
  serializePlan,
  validatePlan,
  type RebasePlan,
  type RebasePlanEntry,
} from '../../../src/rewrite/rebase/planSerializer';

const sha = (c: string): string => c.repeat(40);
const entry = (c: string, action: RebasePlanEntry['action'], message?: string): RebasePlanEntry =>
  message === undefined ? { sha: sha(c), action } : { sha: sha(c), action, message };
const plan = (...entries: RebasePlanEntry[]): RebasePlan => ({ baseSha: sha('0'), entries });

const MSG_DIR = 'C:/tmp/geet-rebase-x';

describe('serializePlan', () => {
  it('emits plain picks in order', () => {
    const out = serializePlan(plan(entry('a', 'pick'), entry('b', 'pick')), MSG_DIR);
    expect(out.todo).toBe(`pick ${sha('a')}\npick ${sha('b')}\n`);
    expect(out.messageFiles).toEqual([]);
  });

  it('encodes reword as pick + exec-amend with a message file', () => {
    const out = serializePlan(
      plan(entry('a', 'reword', 'new subject\n\nbody'), entry('b', 'pick')),
      MSG_DIR,
    );
    expect(out.todo).toBe(
      [
        `pick ${sha('a')}`,
        `exec git commit --amend --no-verify -F "${MSG_DIR}/msg-1.txt"`,
        `pick ${sha('b')}`,
        '',
      ].join('\n'),
    );
    expect(out.messageFiles).toEqual([{ name: 'msg-1.txt', content: 'new subject\n\nbody\n' }]);
  });

  it('converts squash groups to fixups + one trailing exec-amend with the combined message', () => {
    const out = serializePlan(
      plan(entry('a', 'pick'), entry('b', 'squash', 'combined message'), entry('c', 'pick')),
      MSG_DIR,
    );
    expect(out.todo).toBe(
      [
        `pick ${sha('a')}`,
        `fixup ${sha('b')}`,
        `exec git commit --amend --no-verify -F "${MSG_DIR}/msg-1.txt"`,
        `pick ${sha('c')}`,
        '',
      ].join('\n'),
    );
  });

  it('fixup-only groups keep the target message (no exec line)', () => {
    const out = serializePlan(plan(entry('a', 'pick'), entry('b', 'fixup')), MSG_DIR);
    expect(out.todo).toBe(`pick ${sha('a')}\nfixup ${sha('b')}\n`);
    expect(out.messageFiles).toEqual([]);
  });

  it('squash without message degrades to fixup (message discarded)', () => {
    const out = serializePlan(plan(entry('a', 'pick'), entry('b', 'squash')), MSG_DIR);
    expect(out.todo).toBe(`pick ${sha('a')}\nfixup ${sha('b')}\n`);
    expect(out.messageFiles).toEqual([]);
  });

  it('last provided squash message wins within a group', () => {
    const out = serializePlan(
      plan(entry('a', 'reword', 'head msg'), entry('b', 'squash', 'first'), entry('c', 'squash', 'final')),
      MSG_DIR,
    );
    expect(out.todo).toContain(`exec git commit --amend --no-verify -F "${MSG_DIR}/msg-1.txt"`);
    expect(out.messageFiles).toEqual([{ name: 'msg-1.txt', content: 'final\n' }]);
    // Exactly one exec for the whole group.
    expect(out.todo.match(/exec /g)).toHaveLength(1);
  });

  it('emits drop lines and lets them interleave without breaking a squash group', () => {
    const out = serializePlan(
      plan(entry('a', 'pick'), entry('b', 'drop'), entry('c', 'squash', 'a+c')),
      MSG_DIR,
    );
    expect(out.todo).toBe(
      [
        `pick ${sha('a')}`,
        `drop ${sha('b')}`,
        `fixup ${sha('c')}`,
        `exec git commit --amend --no-verify -F "${MSG_DIR}/msg-1.txt"`,
        '',
      ].join('\n'),
    );
  });

  it('numbers multiple message files sequentially', () => {
    const out = serializePlan(
      plan(entry('a', 'reword', 'one'), entry('b', 'reword', 'two')),
      MSG_DIR,
    );
    expect(out.messageFiles.map((f) => f.name)).toEqual(['msg-1.txt', 'msg-2.txt']);
    expect(out.todo).toContain('msg-1.txt');
    expect(out.todo).toContain('msg-2.txt');
  });

  it('throws on invalid plans', () => {
    expect(() => serializePlan(plan(entry('a', 'squash', 'x')), MSG_DIR)).toThrow(/first commit/i);
    expect(() => serializePlan({ baseSha: sha('0'), entries: [] }, MSG_DIR)).toThrow(/empty/i);
  });
});

describe('validatePlan', () => {
  it('accepts a well-formed plan', () => {
    expect(validatePlan(plan(entry('a', 'pick'), entry('b', 'squash', 'm')))).toEqual([]);
  });

  it('flags empty and all-dropped plans', () => {
    expect(validatePlan({ baseSha: sha('0'), entries: [] })).toHaveLength(1);
    expect(validatePlan(plan(entry('a', 'drop'), entry('b', 'drop')))).toEqual([
      'All commits are dropped — nothing would remain to rebase.',
    ]);
  });

  it('flags squash/fixup as the first kept row, even behind drops', () => {
    expect(validatePlan(plan(entry('a', 'drop'), entry('b', 'fixup')))).toContainEqual(
      expect.stringMatching(/first commit/i),
    );
  });

  it('flags rewords without a message and abbreviated shas', () => {
    expect(validatePlan(plan(entry('a', 'reword')))).toContainEqual(
      expect.stringMatching(/no message/),
    );
    expect(validatePlan({ baseSha: sha('0'), entries: [{ sha: 'abc123', action: 'pick' }] })).toContainEqual(
      expect.stringMatching(/full commit sha/),
    );
  });

  it('flags an abbreviated upstream (POST-P14cw)', () => {
    expect(validatePlan({ ...plan(entry('a', 'pick')), upstreamSha: 'abc123' })).toContainEqual(
      expect.stringMatching(/"abc123" is not a full commit sha/),
    );
    expect(validatePlan({ ...plan(entry('a', 'pick')), upstreamSha: sha('9') })).toEqual([]);
  });
});

// POST-P14cw: the Rebase dialog's From replays `from..HEAD` onto a base of its own.
describe('interactiveRebaseArgs', () => {
  it('rebases onto the base when the replayed commits start there', () => {
    expect(interactiveRebaseArgs(plan(entry('a', 'pick')))).toEqual(['rebase', '-i', '--autostash', sha('0')]);
  });

  it('gives an upstream of its own to --onto', () => {
    expect(interactiveRebaseArgs({ ...plan(entry('a', 'pick')), upstreamSha: sha('9') })).toEqual([
      'rebase',
      '-i',
      '--autostash',
      '--onto',
      sha('0'),
      sha('9'),
    ]);
  });

  it('needs no --onto when the upstream is the base itself', () => {
    expect(interactiveRebaseArgs({ ...plan(entry('a', 'pick')), upstreamSha: sha('0') })).toEqual([
      'rebase',
      '-i',
      '--autostash',
      sha('0'),
    ]);
  });
});
