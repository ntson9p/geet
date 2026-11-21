import { describe, expect, it } from 'vitest';
import {
  buildDropPlan,
  buildSquashPlan,
  isContiguous,
  prettySquash,
} from '../../../src/rewrite/multiCommitPlans';
import { serializePlan, validatePlan } from '../../../src/rewrite/rebase/planSerializer';

const sha = (c: string): string => c.repeat(40);
const BASE = sha('0');
// base..HEAD, oldest first: a b c d e.
const RANGE = ['a', 'b', 'c', 'd', 'e'].map(sha);
const pick = (...cs: string[]): Set<string> => new Set(cs.map(sha));
const MSG_DIR = 'C:/tmp/geet-rebase-x';

describe('isContiguous', () => {
  it('is true for one unbroken run, wherever it sits', () => {
    expect(isContiguous(RANGE, pick('b', 'c', 'd'))).toBe(true);
    expect(isContiguous(RANGE, pick('d', 'e'))).toBe(true);
    expect(isContiguous(RANGE, pick('a'))).toBe(true);
  });

  it('is false for a gap, or for a commit outside the range', () => {
    expect(isContiguous(RANGE, pick('a', 'c'))).toBe(false);
    expect(isContiguous(RANGE, pick('d', 'f'))).toBe(false);
  });
});

describe('buildDropPlan (Drop Commits)', () => {
  it('drops the selected commits and keeps the rest in place', () => {
    const plan = buildDropPlan(BASE, RANGE, pick('b', 'd'));
    expect(plan.baseSha).toBe(BASE);
    expect(plan.entries.map((e) => e.action)).toEqual(['pick', 'drop', 'pick', 'drop', 'pick']);
    expect(validatePlan(plan)).toEqual([]);
  });

  it('would be all drops for a run reaching HEAD — which is why that case uses rebase --onto', () => {
    expect(validatePlan(buildDropPlan(BASE, RANGE.slice(3), pick('d', 'e')))).not.toEqual([]);
  });
});

describe("buildSquashPlan (Squash Commits…, IntelliJ's unite)", () => {
  it('folds the other selected commits into the oldest one, right behind it, with the new message', () => {
    const plan = buildSquashPlan(BASE, RANGE, pick('b', 'd', 'e'), 'one commit');
    expect(plan.entries).toEqual([
      { sha: sha('a'), action: 'pick' },
      { sha: sha('b'), action: 'reword', message: 'one commit' },
      { sha: sha('d'), action: 'fixup' },
      { sha: sha('e'), action: 'fixup' },
      { sha: sha('c'), action: 'pick' },
    ]);
    expect(validatePlan(plan)).toEqual([]);
  });

  it('serializes to a todo that picks the root, folds the rest in and rewrites the message once', () => {
    const out = serializePlan(buildSquashPlan(BASE, RANGE, pick('a', 'c'), 'merged'), MSG_DIR);
    expect(out.todo).toBe(
      [
        `pick ${sha('a')}`,
        `fixup ${sha('c')}`,
        `exec git commit --amend --no-verify -F "${MSG_DIR}/msg-1.txt"`,
        `pick ${sha('b')}`,
        `pick ${sha('d')}`,
        `pick ${sha('e')}`,
        '',
      ].join('\n'),
    );
    expect(out.messageFiles).toEqual([{ name: 'msg-1.txt', content: 'merged\n' }]);
  });

  it('keeps adjacent commits where they are', () => {
    const plan = buildSquashPlan(BASE, RANGE, pick('c', 'd'), 'm');
    expect(plan.entries.map((e) => `${e.action} ${e.sha[0]}`)).toEqual([
      'pick a',
      'pick b',
      'reword c',
      'fixup d',
      'pick e',
    ]);
  });
});

describe("prettySquash (Squash Commits…'s starting message)", () => {
  it('joins the messages, three newlines apart, in the order given', () => {
    expect(prettySquash(['feat: b', 'fix: a\n\nbody'])).toBe('feat: b\n\n\nfix: a\n\nbody');
  });

  it('gives each message once', () => {
    expect(prettySquash(['same', 'same', 'other'])).toBe('same\n\n\nother');
  });

  it('keeps only the body of a fixup!/squash!/amend! whose target is selected too', () => {
    expect(prettySquash(['fixup! feat: x', 'feat: x'])).toBe('feat: x');
    expect(prettySquash(['squash! feat: x\n\nmore detail', 'feat: x'])).toBe('more detail\n\n\nfeat: x');
  });

  it('keeps a fixup! whole when its target is not selected', () => {
    expect(prettySquash(['fixup! feat: elsewhere', 'feat: y'])).toBe('fixup! feat: elsewhere\n\n\nfeat: y');
  });
});
