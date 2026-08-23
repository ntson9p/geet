/**
 * The cross-file change-navigation state machine (P14-T7), pure and
 * vscode-free so IntelliJ's two-stage gesture is unit-tested rather than
 * discovered by clicking.
 *
 * What this replaces: VS Code's diff editor wraps to the top of the *same*
 * file when you run off the end, because a diff editor knows only two
 * documents and has no concept of a file sequence. GitTree opens the diffs, so
 * it holds the sequence — that is the whole reason this is possible here and
 * not there.
 *
 * IntelliJ's behaviour, reproduced: at the last change of a file the first
 * press does NOT jump. It arms and says so; the second press moves to the next
 * file. At the very end of the last file it says that instead, and never wraps.
 */
import { nextChange, prevChange, type Change } from '../scm/gutter/changeModel';

export type NavAction =
  /** Move the cursor within the current file. */
  | { kind: 'reveal'; line: number }
  /** Tell the user a second press crosses to another file, and remember it. */
  | { kind: 'arm'; toIndex: number }
  /** The second press: open that file's diff. */
  | { kind: 'cross'; toIndex: number; landOn: 'first' | 'last' }
  /** Nowhere left to go in this direction. */
  | { kind: 'end' };

export interface NavInput {
  readonly changes: readonly Change[];
  /** 0-based cursor line on the modified side. */
  readonly line: number;
  readonly direction: 'next' | 'prev';
  /** Position of the open file within its sequence. */
  readonly index: number;
  readonly total: number;
  /** True when the previous press already armed this same boundary. */
  readonly armed: boolean;
}

export function navigationStep(input: NavInput): NavAction {
  const { changes, line, direction, index, total, armed } = input;

  const target =
    direction === 'next' ? nextChange(changes, line) : prevChange(changes, line);
  if (target) {
    // Landing on the first line of the block is what the user is looking at,
    // for a deletion as much as for an added run.
    return { kind: 'reveal', line: target.startLine };
  }

  const toIndex = direction === 'next' ? index + 1 : index - 1;
  if (toIndex < 0 || toIndex >= total) return { kind: 'end' };
  if (!armed) return { kind: 'arm', toIndex };
  // Entering a file backwards should land on its LAST change, or "previous"
  // would skip everything in it.
  return { kind: 'cross', toIndex, landOn: direction === 'next' ? 'first' : 'last' };
}

/**
 * Where the cursor goes when a crossing lands. `undefined` means the file has
 * no changes at all — rare but real for a rename with no content edit, and the
 * caller should leave the cursor at the top rather than throw.
 */
export function landingLine(
  changes: readonly Change[],
  landOn: 'first' | 'last',
): number | undefined {
  if (changes.length === 0) return undefined;
  return landOn === 'first'
    ? changes[0]!.startLine
    : changes[changes.length - 1]!.startLine;
}
