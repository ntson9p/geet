/**
 * Normalized git failure model (master §8/§10). Every non-zero git exit that
 * the executor surfaces becomes a GitError whose `kind` drives UX mapping in
 * the shared ErrorHandler (e.g. would-overwrite-checkout → Smart Checkout).
 */
export type GitErrorKind =
  | 'index-lock'
  | 'would-overwrite-checkout'
  | 'merge-conflict'
  | 'auth'
  | 'not-fast-forward'
  | 'no-upstream'
  | 'unknown';

export interface GitErrorDetails {
  readonly args: readonly string[];
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
  readonly cwd?: string;
}

export class GitError extends Error {
  override readonly name = 'GitError';

  constructor(
    readonly kind: GitErrorKind,
    message: string,
    readonly details: GitErrorDetails,
  ) {
    super(message);
  }

  get stderr(): string {
    return this.details.stderr;
  }

  get exitCode(): number {
    return this.details.exitCode;
  }
}

interface ClassifierRule {
  kind: GitErrorKind;
  patterns: RegExp[];
}

/**
 * Ordered classification table. First match wins; index-lock leads because its
 * message can co-occur with others and drives the queue's retry policy.
 * Patterns match git's C-locale messages — the executor forces LC_ALL=C for
 * structured calls, and git emits English by default elsewhere.
 */
const RULES: ClassifierRule[] = [
  {
    kind: 'index-lock',
    patterns: [
      /index\.lock': File exists/i,
      /Unable to create '.*index\.lock'/i,
      /Another git process seems to be running/i,
      /could not lock (?:the )?index/i,
    ],
  },
  {
    kind: 'would-overwrite-checkout',
    patterns: [
      /would be overwritten by (checkout|merge|rebase)/i,
      /Please commit your changes or stash them before you (switch branches|merge)/i,
    ],
  },
  {
    kind: 'merge-conflict',
    patterns: [
      /^CONFLICT \(/m,
      /Automatic merge failed/i,
      /error: could not apply/i,
      /Merge conflict in /i,
      /after resolving the conflicts/i,
      /unmerged files/i,
      /needs merge/i,
    ],
  },
  {
    kind: 'auth',
    patterns: [
      /terminal prompts disabled/i,
      /Authentication failed/i,
      /could not read Username/i,
      /could not read Password/i,
      /Permission denied \(publickey/i,
      /Invalid username or (password|token)/i,
      /HTTP Basic: Access denied/i,
    ],
  },
  {
    kind: 'not-fast-forward',
    patterns: [
      /non-fast-forward/i,
      /fetch first/i,
      /\[rejected\].*stale info/i,
      /Updates were rejected because/i,
    ],
  },
  {
    kind: 'no-upstream',
    patterns: [
      /has no upstream branch/i,
      /no tracking information for the current branch/i,
      /no upstream configured for branch/i,
    ],
  },
];

export function classifyGitError(stderr: string, stdout = ''): GitErrorKind {
  const haystack = stderr + '\n' + stdout;
  for (const rule of RULES) {
    if (rule.patterns.some((p) => p.test(haystack))) return rule.kind;
  }
  return 'unknown';
}

/** Lines that say how git got where it was going, not what went wrong. */
const NOISE = /^(hint|warning):|^From |^remote: (Enumerating|Counting|Compressing|Total)|^(Receiving|Resolving|Unpacking) /u;
/** Says only that something before it went wrong, which that line says better. */
const GENERIC = /^fatal: Could not read from remote repository\.?$/iu;
/** Where git says what stopped a merge or rebase: on stdout, often with nothing on stderr. */
const STDOUT_REASON = /^(CONFLICT \(|error:|fatal:|Automatic merge failed)/u;

/**
 * What went wrong, in git's own words without the rest of what it printed
 * (POST-P14aw): the line naming the problem, the files it lists after a colon,
 * and not `git exited with code 1`, which is all the first stderr line gives a
 * merge that stopped on conflicts, since git says that on stdout.
 */
export function describeGitFailure(
  details: Pick<GitErrorDetails, 'stderr' | 'stdout' | 'exitCode'>,
): string {
  const lines = details.stderr.split(/\r?\n/u);
  const candidates = lines
    .map((line, index) => ({ line: line.trim(), index }))
    .filter(({ line }) => line.length > 0 && !NOISE.test(line));
  const chosen =
    candidates.find(({ line }) => /^(fatal|error):/u.test(line) && !GENERIC.test(line)) ??
    candidates.find(({ line }) => !GENERIC.test(line)) ??
    candidates[0];
  if (chosen === undefined) {
    const fromStdout = details.stdout
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .find((line) => STDOUT_REASON.test(line));
    return fromStdout !== undefined ? stripPrefix(fromStdout) : `git exited with code ${details.exitCode}`;
  }
  let reason = stripPrefix(chosen.line);
  // `unable to access 'https://…/': Could not resolve host: x` — the URL is
  // the remote the user already knows; what failed is the part after it.
  const access = /^unable to access '[^']*': (.+)$/u.exec(reason);
  if (access?.[1] !== undefined) reason = access[1];
  // `'C:/very/long/path.git' does not appear to be a git repository`: likewise.
  if (/^'[^']*' does not appear to be a git repository$/u.test(reason)) {
    reason = 'the remote does not appear to be a git repository';
  }
  // `…would be overwritten by merge:` then the files, one per indented line.
  if (reason.endsWith(':')) {
    const listed: string[] = [];
    for (const line of lines.slice(chosen.index + 1)) {
      if (!/^\s+\S/u.test(line)) break;
      listed.push(line.trim());
    }
    if (listed.length > 0) {
      const shown = listed.slice(0, 3).join(', ');
      reason = `${reason} ${shown}${listed.length > 3 ? ` and ${listed.length - 3} more` : ''}`;
    } else {
      reason = reason.slice(0, -1);
    }
  }
  return reason;
}

function stripPrefix(line: string): string {
  return line.replace(/^(fatal|error):\s*/u, '');
}

export function makeGitError(details: GitErrorDetails): GitError {
  const kind = classifyGitError(details.stderr, details.stdout);
  const firstLine =
    details.stderr.split('\n').find((l) => l.trim().length > 0) ??
    `git exited with code ${details.exitCode}`;
  return new GitError(kind, firstLine.trim(), details);
}
