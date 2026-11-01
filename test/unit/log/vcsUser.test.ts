import { describe, expect, it } from 'vitest';
import {
  committedByOther,
  isSamePerson,
  nameInStandardForm,
  userName,
} from '../../../src/log/vcsUser';

describe("userName (IntelliJ's VcsUserUtil.getUserName)", () => {
  it('is the name when there is one', () => {
    expect(userName('Ben Okafor', 'ben@sandbox.invalid')).toBe('Ben Okafor');
  });

  it("falls back to the email's local part, then to the email", () => {
    expect(userName('', 'ben@sandbox.invalid')).toBe('ben');
    expect(userName('', 'no-at-sign')).toBe('no-at-sign');
    expect(userName('', '@odd')).toBe('@odd');
  });
});

describe('nameInStandardForm', () => {
  it('reads two words with one separator as "first last", lower-cased', () => {
    expect(nameInStandardForm('Ben Okafor')).toBe('ben okafor');
    expect(nameInStandardForm('ben.okafor')).toBe('ben okafor');
    expect(nameInStandardForm('BEN_OKAFOR')).toBe('ben okafor');
    expect(nameInStandardForm('ben-okafor')).toBe('ben okafor');
  });

  it('lower-cases any other plain-ASCII name whole', () => {
    expect(nameInStandardForm('Ava')).toBe('ava');
    expect(nameInStandardForm('Mary Jane Watson')).toBe('mary jane watson');
  });

  it('leaves names outside plain ASCII as they are', () => {
    expect(nameInStandardForm('Đặng Văn')).toBe('Đặng Văn');
  });
});

describe('isSamePerson / committedByOther (the Author column\'s *)', () => {
  it('treats spellings of one person as the same', () => {
    expect(isSamePerson('Ben Okafor', 'ben.okafor')).toBe(true);
    expect(isSamePerson('Ava Tran', 'Ben Okafor')).toBe(false);
  });

  it('marks a commit someone else committed, as after a rebase by them', () => {
    expect(committedByOther('Ava Tran', 'ava@x', 'Ben Okafor')).toBe(true);
    expect(committedByOther('Ava Tran', 'ava@x', 'Ava Tran')).toBe(false);
    expect(committedByOther('Ava Tran', 'ava@x', 'ava.tran')).toBe(false);
  });

  it('compares the committer with the name the author is shown by', () => {
    expect(committedByOther('', 'ava@x', 'ava')).toBe(false);
    expect(committedByOther('', 'ava@x', 'Ben')).toBe(true);
  });

  it('leaves a commit with no committer name unmarked', () => {
    expect(committedByOther('Ava Tran', 'ava@x', '')).toBe(false);
  });
});
