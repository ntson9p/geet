import { describe, expect, it } from 'vitest';
import { classifyGitError, makeGitError } from '../../../../src/core/git/errors';

describe('classifyGitError', () => {
  const table: Array<[string, string]> = [
    // index-lock
    [
      "fatal: Unable to create 'D:/repo/.git/index.lock': File exists.\n\nAnother git process seems to be running in this repository",
      'index-lock',
    ],
    ["fatal: Unable to create '/w/repo/.git/index.lock': File exists.", 'index-lock'],
    ['fatal: could not lock the index', 'index-lock'],
    // would-overwrite-checkout
    [
      'error: Your local changes to the following files would be overwritten by checkout:\n\tsrc/a.ts\nPlease commit your changes or stash them before you switch branches.\nAborting',
      'would-overwrite-checkout',
    ],
    [
      'error: Your local changes to the following files would be overwritten by merge:\n\ta.txt',
      'would-overwrite-checkout',
    ],
    // merge-conflict
    ['CONFLICT (content): Merge conflict in src/a.ts\nAutomatic merge failed; fix conflicts and then commit the result.', 'merge-conflict'],
    ['error: could not apply fa39187... fix the thing\nhint: after resolving the conflicts, mark the corrected paths', 'merge-conflict'],
    ['error: Committing is not possible because you have unmerged files.', 'merge-conflict'],
    ['error: you need to resolve your current index first\na.txt: needs merge', 'merge-conflict'],
    // auth
    ['fatal: could not read Username for \'https://github.com\': terminal prompts disabled', 'auth'],
    ["remote: Invalid username or password.\nfatal: Authentication failed for 'https://github.com/x/y.git/'", 'auth'],
    ['git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.', 'auth'],
    ['remote: HTTP Basic: Access denied\nfatal: Authentication failed', 'auth'],
    // not-fast-forward
    [
      "To github.com:x/y.git\n ! [rejected]        main -> main (non-fast-forward)\nerror: failed to push some refs to 'github.com:x/y.git'\nhint: Updates were rejected because the tip of your current branch is behind",
      'not-fast-forward',
    ],
    ['! [rejected]  main -> main (stale info)', 'not-fast-forward'],
    // no-upstream
    [
      'fatal: The current branch feature/x has no upstream branch.\nTo push the current branch and set the remote as upstream, use…',
      'no-upstream',
    ],
    ['There is no tracking information for the current branch.', 'no-upstream'],
    // unknown
    ["fatal: not a git repository (or any of the parent directories): .git", 'unknown'],
    ['', 'unknown'],
  ];

  it.each(table)('classifies %j as %s', (stderr, kind) => {
    expect(classifyGitError(stderr)).toBe(kind);
  });

  it('classifies from stdout as fallback (merge prints CONFLICT on stdout)', () => {
    expect(classifyGitError('', 'CONFLICT (content): Merge conflict in a.txt')).toBe('merge-conflict');
  });

  it('prefers index-lock when multiple patterns co-occur', () => {
    const stderr =
      "fatal: Unable to create '.git/index.lock': File exists.\nerror: Your local changes would be overwritten by checkout";
    expect(classifyGitError(stderr)).toBe('index-lock');
  });
});

describe('makeGitError', () => {
  it('carries details and uses first non-empty stderr line as message', () => {
    const err = makeGitError({
      args: ['checkout', 'main'],
      exitCode: 1,
      stderr: '\nerror: Your local changes to the following files would be overwritten by checkout:\n\ta.ts',
      stdout: '',
    });
    expect(err.kind).toBe('would-overwrite-checkout');
    expect(err.message).toContain('would be overwritten by checkout');
    expect(err.exitCode).toBe(1);
    expect(err.stderr).toContain('a.ts');
  });

  it('falls back to exit code message when stderr is empty', () => {
    const err = makeGitError({ args: ['fetch'], exitCode: 128, stderr: '', stdout: '' });
    expect(err.kind).toBe('unknown');
    expect(err.message).toBe('git exited with code 128');
  });
});
