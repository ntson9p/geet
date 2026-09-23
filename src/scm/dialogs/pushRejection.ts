/**
 * A rejected push, as data (POST-P14af) — vscode-free so the reading of git's
 * output and the "may we update and push again?" rule are unit-tested.
 *
 * IntelliJ answers a push the remote refused because it has commits you do
 * not with its `Push Rejected` dialog: Merge or Rebase, then push again. Every
 * other refusal — a lease that went stale, a hook or a protected branch on the
 * server — is only reported, because no update can fix it.
 *
 * git prints one status line per ref it tried to push. The bracketed status
 * and the reason in parentheses are fixed English in git's source (the ref
 * status table in `transport.c` is not translated), so they are the stable
 * thing to read whatever the user's locale — unlike the `hint:` prose below.
 */
import { updateChoices, type UpdateStrategy } from './updateArgs';

/**
 * `behind`: the remote has commits the pushed branch does not (`fetch first`,
 * `non-fast-forward`) — the one an update fixes. `stale`: a force push whose
 * lease no longer holds. `other`: anything the remote itself refused.
 */
export type PushRejection = 'behind' | 'stale' | 'other';

export interface RejectedRef {
  readonly rejection: PushRejection;
  /** git's own reason, e.g. `fetch first` or `pre-receive hook declined`. */
  readonly reason: string;
}

/**
 * ` ! [rejected]        main -> main (fetch first)`, or with `--porcelain`
 * `!\trefs/heads/main:refs/heads/main\t[rejected] (fetch first)`. Anchored on
 * the leading `!` so a `remote:` line that happens to quote one is not read
 * as a status of its own.
 */
const STATUS_LINE = /^\s*!\s.*\[(rejected|remote rejected)\].*\(([^)]*)\)\s*$/u;

export function rejectedRefs(stderr: string): RejectedRef[] {
  const refs: RejectedRef[] = [];
  for (const line of stderr.split(/\r?\n/u)) {
    const m = STATUS_LINE.exec(line);
    if (!m) continue;
    const reason = (m[2] ?? '').trim();
    const local = m[1] === 'rejected';
    const rejection: PushRejection =
      local && (reason === 'fetch first' || reason === 'non-fast-forward')
        ? 'behind'
        : local && reason === 'stale info'
          ? 'stale'
          : 'other';
    refs.push({ rejection, reason });
  }
  return refs;
}

/**
 * The rejection a push is reported as, or `undefined` when git refused
 * nothing — the push failed some other way (authentication, network, a
 * local hook). `behind` wins over the rest: it is the one an update can fix.
 */
export function pushRejectionOf(stderr: string): RejectedRef | undefined {
  const refs = rejectedRefs(stderr);
  return (
    refs.find((r) => r.rejection === 'behind') ??
    refs.find((r) => r.rejection === 'stale') ??
    refs[0]
  );
}

/** A forced push is never "updated" into success: the user chose to overwrite. */
export function isForcePush(args: readonly string[]): boolean {
  return args.some((a) => a === '--force' || a === '-f' || a.startsWith('--force-with-lease'));
}

export interface RetryContext {
  readonly rejection: PushRejection | undefined;
  readonly force: boolean;
  /** The pushed branch is the one checked out. */
  readonly current: boolean;
  /** …and it is pushed to the branch it tracks. */
  readonly toUpstream: boolean;
  /** A merge, rebase or similar is already in progress. */
  readonly busy: boolean;
}

/**
 * IntelliJ's rule for offering Merge or Rebase: the current branch, pushed to
 * the branch it tracks, refused only because the remote moved on. A branch
 * that is not checked out cannot be merged into, one pushed anywhere but its
 * upstream would be updated from the wrong place, and a repository already
 * mid-merge cannot start another.
 */
export function canUpdateAndRetry(c: RetryContext): boolean {
  return c.rejection === 'behind' && !c.force && c.current && c.toUpstream && !c.busy;
}

/**
 * The buttons, in order; the first is the default. Normally the strategy
 * answered last comes first, as in Update Project's question. With merge
 * commits of your own not yet pushed, IntelliJ recommends merging — a rebase
 * would flatten them — so Merge comes first whatever was chosen before.
 */
export function pushRejectedChoices(
  remembered: UpdateStrategy,
  unpushedMerges: boolean,
): UpdateStrategy[] {
  return unpushedMerges ? ['merge', 'rebase'] : (updateChoices(remembered, false) as UpdateStrategy[]);
}

/**
 * Update-and-push rounds one push may take. Each round fetches, integrates
 * and pushes again; a remote that moves again in between rejects the push
 * again, and the next round picks that up. A bound, so a remote that keeps
 * refusing for a reason no update fixes cannot keep merging forever.
 */
export const MAX_PUSH_ATTEMPTS = 3;

/**
 * The sentence a failed push is reported with: git's own `fatal:` or `error:`
 * line, prefix dropped. Not simply the first line of stderr, which for a
 * push is `To <url>` — a line that says where, not what went wrong.
 */
export function pushFailureLine(stderr: string): string {
  const lines = stderr
    .split(/\r?\n/u)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const flagged = lines.find((l) => /^(fatal|error):/iu.test(l));
  if (flagged !== undefined) return flagged.replace(/^(fatal|error):\s*/iu, '');
  return lines.find((l) => !l.startsWith('To ') && !l.startsWith('hint:')) ?? '';
}
