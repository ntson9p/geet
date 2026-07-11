/**
 * Parser for `git stash list --format` with NUL fields / \x1e records.
 */

export const STASH_LIST_FORMAT = '%gd%x00%H%x00%at%x00%gs%x1e';
export const STASH_RECORD_SEPARATOR = '\x1e';

export interface StashInfo {
  /** N in stash@{N}. */
  index: number;
  /** Reflog selector, e.g. `stash@{0}`. */
  selector: string;
  sha: string;
  /** Full reflog subject, e.g. `WIP on main: 1a2b3c fix` or `On main: my message`. */
  message: string;
  /** Branch parsed from the subject; undefined for autostash and exotic subjects. */
  branch?: string;
  /** Unix seconds. */
  time: number;
}

const SELECTOR = /^stash@\{(\d+)\}$/;
const SUBJECT_BRANCH = /^(?:WIP on|On) ([^:]+):/;

export function parseStashList(output: string): StashInfo[] {
  const stashes: StashInfo[] = [];
  for (const frameRaw of output.split(STASH_RECORD_SEPARATOR)) {
    const frame = frameRaw.startsWith('\n') ? frameRaw.slice(1) : frameRaw;
    if (frame.length === 0) continue;
    const f = frame.split('\0');
    if (f.length < 4) continue;
    const selector = f[0] as string;
    const selMatch = SELECTOR.exec(selector);
    if (!selMatch) continue;
    const message = f.slice(3).join('\0');
    const branchMatch = SUBJECT_BRANCH.exec(message);
    const info: StashInfo = {
      index: Number.parseInt(selMatch[1] as string, 10),
      selector,
      sha: f[1] as string,
      time: Number.parseInt(f[2] as string, 10),
      message,
    };
    if (branchMatch?.[1] !== undefined) info.branch = branchMatch[1];
    stashes.push(info);
  }
  return stashes;
}
