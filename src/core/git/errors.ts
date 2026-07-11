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

export function makeGitError(details: GitErrorDetails): GitError {
  const kind = classifyGitError(details.stderr, details.stdout);
  const firstLine =
    details.stderr.split('\n').find((l) => l.trim().length > 0) ??
    `git exited with code ${details.exitCode}`;
  return new GitError(kind, firstLine.trim(), details);
}
