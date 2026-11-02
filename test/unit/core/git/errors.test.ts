import { describe, expect, it } from 'vitest';
import { classifyGitError, describeGitFailure, makeGitError } from '../../../../src/core/git/errors';

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

/**
 * POST-P14aw — what Update Project says went wrong: the line that names the
 * problem, not `git exited with code 1` or the first line git happened to print.
 */
describe('describeGitFailure', () => {
  const failed = (stderr: string, stdout = '', exitCode = 1): string =>
    describeGitFailure({ stderr, stdout, exitCode });

  it('finds a conflicted merge on stdout, where git says it', () => {
    expect(
      failed(
        '',
        'Auto-merging a.txt\nCONFLICT (content): Merge conflict in a.txt\nAutomatic merge failed; fix conflicts and then commit the result.\n',
      ),
    ).toBe('CONFLICT (content): Merge conflict in a.txt');
  });

  it('keeps what failed and drops the remote it failed at', () => {
    expect(
      failed("fatal: unable to access 'https://github.com/acme/api.git/': Could not resolve host: github.com\n", '', 128),
    ).toBe('Could not resolve host: github.com');
    expect(
      failed(
        "fatal: 'C:/very/long/path/to/remote.git' does not appear to be a git repository\nfatal: Could not read from remote repository.\n\nPlease make sure you have the correct access rights\nand the repository exists.\n",
        '',
        128,
      ),
    ).toBe('the remote does not appear to be a git repository');
  });

  it('prefers a specific line to the generic one git ends with', () => {
    expect(
      failed('ssh: Could not resolve hostname github.com: No such host is known.\r\nfatal: Could not read from remote repository.\r\n', '', 128),
    ).toBe('ssh: Could not resolve hostname github.com: No such host is known.');
    expect(
      failed("remote: Repository not found.\nfatal: repository 'https://github.com/acme/gone.git/' not found\n", '', 128),
    ).toBe("repository 'https://github.com/acme/gone.git/' not found");
  });

  it('appends the files a refusal lists after its colon', () => {
    expect(
      failed(
        'error: Your local changes to the following files would be overwritten by merge:\n\tnotes.txt\nPlease commit your changes or stash them before you merge.\nAborting\n',
      ),
    ).toBe('Your local changes to the following files would be overwritten by merge: notes.txt');
    expect(
      failed(
        'error: The following untracked working tree files would be overwritten by merge:\n\ta\n\tb\n\tc\n\td\n\te\nPlease move or remove them before you merge.\n',
      ),
    ).toBe('The following untracked working tree files would be overwritten by merge: a, b, c and 2 more');
  });

  it("drops git's hints and its prefixes", () => {
    expect(
      failed('hint: Waiting for your editor to close the file...\nerror: cannot rebase: You have unstaged changes.\nerror: Please commit or stash them.\n'),
    ).toBe('cannot rebase: You have unstaged changes.');
  });

  it('falls back to the exit code when git said nothing at all', () => {
    expect(failed('', '', 128)).toBe('git exited with code 128');
    expect(failed('warning: redirecting to https://example.com/x.git/\n', 'Already up to date.\n', 1)).toBe(
      'git exited with code 1',
    );
  });
});
