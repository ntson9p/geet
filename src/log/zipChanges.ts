/**
 * The Changed Files pane for several selected commits, as IntelliJ builds it
 * (`VcsLogUtil.collectChanges` → `CommittedChangesTreeBrowser.zipChanges`):
 * the files **those commits** changed — not every file between the oldest and
 * the newest, which would pull in commits nobody selected — with each file
 * running from its version before the earliest selected commit that touched
 * it to its version after the latest one. A file renamed along the way is one
 * row, from its first name to its last. Pure and vscode-free.
 */

/** One file of one commit, as `--name-status` reports it. */
export interface CommitFileEntry {
  readonly status: string;
  readonly path: string;
  readonly origPath?: string;
}

export interface CommitFiles {
  readonly sha: string;
  readonly files: readonly CommitFileEntry[];
}

/** A file's side of a change: where it was, and in which revision. */
interface Side {
  readonly path: string;
  /** A revision `git show <rev>:<path>` reads: a sha, or `<sha>^`. */
  readonly rev: string;
}

interface Change {
  readonly before?: Side;
  readonly after?: Side;
}

/** One row of the merged list. `before`/`after` are the revisions the diff opens. */
export interface ZippedFile {
  /** `A`, `D`, `M` or `R`, from the two ends. */
  readonly status: string;
  readonly path: string;
  readonly origPath?: string;
  /** The revision before the earliest change; absent for a file that is new. */
  readonly before?: string;
  /** The revision after the latest change; absent for a file that is gone. */
  readonly after?: string;
}

/**
 * A `--name-status` row as a change. A copy is a new file, as IntelliJ reads
 * one: the original is still where it was.
 */
function changeOf(sha: string, file: CommitFileEntry): Change {
  const kind = file.status.charAt(0);
  const parent = `${sha}^`;
  switch (kind) {
    case 'A':
    case 'C':
      return { after: { path: file.path, rev: sha } };
    case 'D':
      return { before: { path: file.path, rev: parent } };
    case 'R':
      return {
        before: { path: file.origPath ?? file.path, rev: parent },
        after: { path: file.path, rev: sha },
      };
    default:
      return { before: { path: file.path, rev: parent }, after: { path: file.path, rev: sha } };
  }
}

function rowOf(change: Change): ZippedFile {
  const { before, after } = change;
  if (before === undefined) return { status: 'A', path: after!.path, after: after!.rev };
  if (after === undefined) return { status: 'D', path: before.path, before: before.rev };
  if (before.path !== after.path) {
    return { status: 'R', path: after.path, origPath: before.path, before: before.rev, after: after.rev };
  }
  return { status: 'M', path: after.path, before: before.rev, after: after.rev };
}

/**
 * Merges the commits' changes, **oldest commit first**. IntelliJ's algorithm,
 * keyed by where each file ends up: a change that starts where an earlier one
 * ended continues it, keeping the earlier start. Deletions go last, at their
 * own path. A file added and then deleted inside the selection drops out.
 */
export function zipChanges(oldestFirst: readonly CommitFiles[]): ZippedFile[] {
  // Keyed by the after-path; `null` holds deletions until the end. A JS Map
  // keeps first-insertion order, as IntelliJ's linked MultiMap does.
  const map = new Map<string | null, Change[]>();
  const put = (key: string | null, change: Change): void => {
    const bucket = map.get(key);
    if (bucket) bucket.push(change);
    else map.set(key, [change]);
  };

  for (const commit of oldestFirst) {
    for (const file of commit.files) {
      const change = changeOf(commit.sha, file);
      const afterPath = change.after?.path ?? null;
      if (change.before === undefined) {
        put(afterPath, change);
        continue;
      }
      const bucket = map.get(change.before.path);
      if (bucket === undefined || bucket.length === 0) {
        put(afterPath, change);
        continue;
      }
      const old = bucket.shift()!;
      if (old.before !== undefined || change.after !== undefined) {
        put(afterPath, { ...(old.before ? { before: old.before } : {}), ...(change.after ? { after: change.after } : {}) });
      }
    }
  }

  const deleted = map.get(null);
  map.delete(null);
  for (const change of deleted ?? []) put(change.before!.path, change);

  return [...map.values()].flat().map(rowOf);
}

/**
 * Reads `git log --no-walk=unsorted --format=%x1e%H --name-status -z` output:
 * per commit a record separator, the sha, then its NUL-separated name-status.
 */
export function parseCommitsNameStatus(
  stdout: string,
  parseNameStatusZ: (raw: string) => CommitFileEntry[],
): CommitFiles[] {
  const out: CommitFiles[] = [];
  for (const record of stdout.split('\x1e')) {
    const nul = record.indexOf('\0');
    const sha = (nul === -1 ? record : record.slice(0, nul)).trim();
    if (!/^[0-9a-f]{40,64}$/u.test(sha)) continue;
    const rest = nul === -1 ? '' : record.slice(nul + 1).replace(/^[\0\n]+/u, '');
    out.push({ sha, files: parseNameStatusZ(rest) });
  }
  return out;
}
