/**
 * Parser for `git worktree list --porcelain` (P13-T6, gap analysis §3.10).
 * GitTree already resolves worktree paths internally through `commondir`, but
 * had no way to list, create or remove one — this is the read half.
 *
 * The porcelain format is a blank-line-separated record per worktree, each a
 * set of `key[ value]` lines:
 *
 *   worktree /path/to/main
 *   HEAD 0000…
 *   branch refs/heads/main
 *
 *   worktree /path/to/wt
 *   HEAD 1111…
 *   detached
 *   locked reason text
 *   prunable gitdir file points to non-existent location
 *
 * `bare` replaces HEAD/branch entirely. `locked` and `prunable` may appear with
 * or without a reason, which is why they are modelled as "present + optional
 * text" rather than a plain string.
 */

export interface WorktreeInfo {
  /** Absolute path as git prints it (forward slashes on Windows too). */
  path: string;
  /** Commit the worktree is checked out at; absent for a bare repository. */
  head?: string;
  /** Short branch name (`refs/heads/x` → `x`); absent when detached or bare. */
  branch?: string;
  detached: boolean;
  bare: boolean;
  locked: boolean;
  /** Reason git recorded with `worktree lock --reason`, when there was one. */
  lockReason?: string;
  prunable: boolean;
  prunableReason?: string;
  /** The first record is always the main worktree. */
  isMain: boolean;
}

/** `refs/heads/feature/x` → `feature/x`; anything else is returned as-is. */
export function shortBranchName(ref: string): string {
  return ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref;
}

export function parseWorktreeList(output: string): WorktreeInfo[] {
  const worktrees: WorktreeInfo[] = [];
  // Records are separated by a blank line; tolerate CRLF and a trailing blank.
  for (const record of output.split(/\r?\n\r?\n/u)) {
    let current: WorktreeInfo | undefined;
    for (const rawLine of record.split(/\r?\n/u)) {
      const line = rawLine.trimEnd();
      if (line.length === 0) continue;
      const space = line.indexOf(' ');
      const key = space === -1 ? line : line.slice(0, space);
      const value = space === -1 ? '' : line.slice(space + 1);
      if (key === 'worktree') {
        current = {
          path: value,
          detached: false,
          bare: false,
          locked: false,
          prunable: false,
          isMain: worktrees.length === 0,
        };
        continue;
      }
      if (!current) continue; // stray line before the first record header
      switch (key) {
        case 'HEAD':
          current.head = value;
          break;
        case 'branch':
          current.branch = shortBranchName(value);
          break;
        case 'detached':
          current.detached = true;
          break;
        case 'bare':
          current.bare = true;
          break;
        case 'locked':
          current.locked = true;
          if (value.length > 0) current.lockReason = value;
          break;
        case 'prunable':
          current.prunable = true;
          if (value.length > 0) current.prunableReason = value;
          break;
        default:
          break; // forward-compatible: unknown keys are ignored, not fatal
      }
    }
    if (current) worktrees.push(current);
  }
  return worktrees;
}
