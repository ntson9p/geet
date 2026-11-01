import { describe, expect, it } from 'vitest';
import {
  committedMessage,
  joinMessages,
  plural,
  pullResultMessage,
} from '../../../src/scm/resultMessages';

/**
 * POST-P14ap — the completion notifications whose words depend on counts:
 * IntelliJ's `{0,choice,1#commit|2#commits}` and its commit result.
 */
describe('plural', () => {
  it('uses the singular for exactly one', () => {
    expect(plural(1, 'commit', 'commits')).toBe('1 commit');
    expect(plural(0, 'commit', 'commits')).toBe('0 commits');
    expect(plural(12, 'file', 'files')).toBe('12 files');
  });
});

describe('pullResultMessage', () => {
  it('says Already up to date when nothing came in', () => {
    expect(pullResultMessage(0, 0, 'origin/main')).toBe('Already up to date');
  });

  it('says what came in, and from where', () => {
    expect(pullResultMessage(1, 1, 'origin/main')).toBe('Pulled 1 commit from origin/main: 1 file changed');
    expect(pullResultMessage(3, 7, 'origin/main')).toBe('Pulled 3 commits from origin/main: 7 files changed');
  });

  it('leaves the source out when it is not known', () => {
    expect(pullResultMessage(2, 2)).toBe('Pulled 2 commits: 2 files changed');
    expect(pullResultMessage(2, 2, '')).toBe('Pulled 2 commits: 2 files changed');
  });
});

describe('committedMessage', () => {
  it('counts the files and quotes the subject, as IntelliJ does', () => {
    expect(committedMessage(1, 'Fix the parser')).toBe('1 file committed: Fix the parser');
    expect(committedMessage(3, 'Fix the parser')).toBe('3 files committed: Fix the parser');
  });

  it('quotes only the first line of a longer message', () => {
    expect(committedMessage(2, 'Fix the parser\n\nIt dropped the last token.')).toBe(
      '2 files committed: Fix the parser',
    );
  });

  it('says No files for an empty commit, and leaves a blank subject out', () => {
    expect(committedMessage(0, 'Empty')).toBe('No files committed: Empty');
    expect(committedMessage(4, '')).toBe('4 files committed');
  });
});

describe('joinMessages', () => {
  it('says the same message once', () => {
    expect(joinMessages(['Checked out develop', 'Checked out develop'])).toBe('Checked out develop');
  });

  it('joins different ones, in order', () => {
    expect(joinMessages(['Already up to date', 'Pulled 1 commit: 1 file changed'])).toBe(
      'Already up to date · Pulled 1 commit: 1 file changed',
    );
  });

  it('shows three and counts the rest', () => {
    expect(joinMessages(['a', 'b', 'c', 'd', 'e'])).toBe('a · b · c · +2 more');
  });
});
