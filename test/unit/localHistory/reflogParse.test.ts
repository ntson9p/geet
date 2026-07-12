import { describe, expect, it } from 'vitest';
import { classifyReflogSubject, parseReflogLine } from '../../../src/localHistory/reflogParse';

const OLD = 'a'.repeat(40);
const NEW = 'b'.repeat(40);

describe('parseReflogLine', () => {
  it('parses a standard reflog line', () => {
    const line = `${OLD} ${NEW} Ada L <ada@example.com> 1767225600 +0700\treset: moving to HEAD~1`;
    expect(parseReflogLine(line)).toEqual({
      oldSha: OLD,
      newSha: NEW,
      subject: 'reset: moving to HEAD~1',
    });
  });

  it('keeps tabs inside the subject intact', () => {
    const line = `${OLD} ${NEW} A <a@b> 1 +0000\tcommit: with\ttab`;
    expect(parseReflogLine(line)?.subject).toBe('commit: with\ttab');
  });

  it('accepts sha256-length hashes', () => {
    const o = 'c'.repeat(64);
    const n = 'd'.repeat(64);
    expect(parseReflogLine(`${o} ${n} A <a@b> 1 +0000\treset: moving to X`)?.oldSha).toBe(o);
  });

  it('rejects lines without a tab or with malformed hashes', () => {
    expect(parseReflogLine('')).toBeUndefined();
    expect(parseReflogLine('no tab here')).toBeUndefined();
    expect(parseReflogLine(`${OLD} nothex A <a@b> 1 +0000\tsubject`)).toBeUndefined();
    expect(parseReflogLine(`${OLD.slice(0, 39)} ${NEW} A <a@b> 1 +0000\ts`)).toBeUndefined();
    expect(parseReflogLine(`ONLYONEFIELD\tsubject`)).toBeUndefined();
  });
});

describe('classifyReflogSubject', () => {
  it('classifies reset moves', () => {
    expect(classifyReflogSubject('reset: moving to HEAD~1')).toBe('reset');
    expect(classifyReflogSubject('reset: moving to origin/main')).toBe('reset');
  });

  it('classifies checkout moves', () => {
    expect(classifyReflogSubject('checkout: moving from main to feature')).toBe(
      'checkout-forced',
    );
  });

  it('treats benign subjects as non-destructive', () => {
    expect(classifyReflogSubject('commit: fix bug')).toBeUndefined();
    expect(classifyReflogSubject('commit (amend): fix bug')).toBeUndefined();
    expect(classifyReflogSubject('pull: Fast-forward')).toBeUndefined();
    expect(classifyReflogSubject('rebase (finish): returning to refs/heads/main')).toBeUndefined();
    expect(classifyReflogSubject('')).toBeUndefined();
  });
});
