import { describe, expect, it } from 'vitest';
import {
  cleanUpBranchName,
  cleanUpBranchNameOnTyping,
  isValidRefName,
} from '../../../../src/core/git/refName';

/**
 * IntelliJ's `GitRefNameValidator`, which the Push dialog's target field uses
 * to clean what is typed and to refuse a name git would not take.
 */
describe('isValidRefName', () => {
  it('accepts ordinary branch names, slashes and dots inside included', () => {
    for (const name of ['main', 'feature/x', 'release-1.2', 'a.b/c_d', 'refs/for/master']) {
      expect(isValidRefName(name), name).toBe(true);
    }
  });

  it('refuses blank names', () => {
    expect(isValidRefName('')).toBe(false);
    expect(isValidRefName('   ')).toBe(false);
  });

  it("refuses what git-check-ref-format refuses", () => {
    for (const name of [
      '.hidden',
      '-dash',
      '/lead',
      'a..b',
      'a//b',
      'a/.b',
      'a./b',
      'ends.',
      'ends/',
      'ends.lock',
      'has space',
      'tilde~',
      'colon:',
      'caret^',
      'what?',
      'star*',
      'quote"',
      'bracket[',
      'back\\slash',
      'at@{brace',
      'tab\there',
    ]) {
      expect(isValidRefName(name), JSON.stringify(name)).toBe(false);
    }
  });
});

describe('cleanUpBranchNameOnTyping', () => {
  it('turns spaces into the clean-up symbol and drops forbidden characters', () => {
    expect(cleanUpBranchNameOnTyping('my new  branch')).toBe('my_new_branch');
    expect(cleanUpBranchNameOnTyping('fix~1:^?*"[\\')).toBe('fix1');
    expect(cleanUpBranchNameOnTyping('a..b//c')).toBe('a.b/c');
    expect(cleanUpBranchNameOnTyping('-x')).toBe('x');
  });

  it('leaves a trailing dot or slash alone: the name may still be typed', () => {
    expect(cleanUpBranchNameOnTyping('feature/')).toBe('feature/');
    expect(cleanUpBranchNameOnTyping('v1.')).toBe('v1.');
  });

  it('uses the symbol it is given', () => {
    expect(cleanUpBranchNameOnTyping('a b', '-')).toBe('a-b');
  });
});

describe('cleanUpBranchName', () => {
  it('also drops the endings git refuses', () => {
    expect(cleanUpBranchName('feature/')).toBe('feature');
    expect(cleanUpBranchName('topic.lock')).toBe('topic');
  });
});
