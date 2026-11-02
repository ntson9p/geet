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
 * One difference: a file with no text change is not a stop. VS Code greys out
 * its next-change button on such a file, so stopping there would leave the walk
 * stranded halfway through a commit full of renames.
 *
 * VS Code decides where the changes are: the highlights on screen are its own,
 * and its navigation is the only thing that lands exactly on them. It can only
 * be asked by moving the cursor, though, and at a boundary that means a wrap to
 * the top of the file, which shows. So GitTree's own diff answers first
 * (`predict`): when it says nothing lies ahead, the press announces the boundary
 * without touching the view. Before actually leaving the file VS Code gets the
 * last word, because a wrong prediction must never skip a change, unless all it
 * could have got wrong is already on screen (`nothingHiddenAhead`).
 */
import { computeLineChanges, exceedsLineDiffCap } from '../core/patch/lineDiff';
import { toChanges, type Change } from '../scm/gutter/changeModel';

export type Direction = 'next' | 'prev';

/** The press that does nothing further in this file, and what it does instead. */
export type BoundaryAction =
  /** Tell the user a second press crosses to another file, and remember it. */
  | { readonly kind: 'arm'; readonly toIndex: number }
  /** The second press: open that file's diff. */
  | { readonly kind: 'cross'; readonly toIndex: number; readonly landOn: 'first' | 'last' }
  /** Nowhere left to go in this direction. */
  | { readonly kind: 'end' };

/**
 * What GitTree's own diff expects ahead of the cursor. `unknown` is a pair of
 * files too far apart for it to answer, where only VS Code can.
 */
export type Prediction = 'more' | 'none' | 'unknown';

export interface PressInput {
  /** The previous press stopped at this same spot, going this same way. */
  readonly armed: boolean;
  /** VS Code itself, not just the prediction, has found nothing further from here. */
  readonly confirmed: boolean;
  readonly prediction: Prediction;
}

/**
 * Whether "nothing ahead" can stand without VS Code's word. The two diffs agree on
 * which lines differ, so all it could add is a split of GitTree's last change into
 * two, and a change on screen cannot be walked past unseen. Asking would wrap the
 * view to the top of the file on the way out, so it is worth not asking.
 */
export function nothingHiddenAhead(
  changes: readonly Change[] | undefined,
  direction: Direction,
  visible: { readonly first: number; readonly last: number } | undefined,
): boolean {
  if (changes === undefined || visible === undefined) return false;
  return direction === 'next'
    ? changes.every((c) => c.endLine <= visible.last)
    : changes.every((c) => c.startLine >= visible.first);
}

/**
 * The press, before anything moves: is this already the end of the file, or does
 * VS Code's navigation have to run? It does when the changes may go on, and on
 * the second press, which must not leave a change behind on a prediction's word.
 */
export function needsAsking(input: PressInput): boolean {
  return input.armed ? !input.confirmed : input.prediction !== 'none';
}

/** Whether VS Code's navigation went the way it was asked, rather than wrapping. */
export function movedOn(direction: Direction, before: number, after: number): boolean {
  return direction === 'next' ? after > before : after < before;
}

/** What a press does at the end of a file, given the next stop in that direction. */
export function boundaryAction(
  direction: Direction,
  armed: boolean,
  stop: number | undefined,
): BoundaryAction {
  if (stop === undefined) return { kind: 'end' };
  if (!armed) return { kind: 'arm', toIndex: stop };
  // Entering a file backwards should land on its LAST change, or "previous"
  // would skip everything in it.
  return { kind: 'cross', toIndex: stop, landOn: direction === 'next' ? 'first' : 'last' };
}

/**
 * The next file in a direction that has something to stop at. `hasChanges` is
 * asked in order and may be costly, so it is asked no further than necessary.
 */
export async function nextStop(
  index: number,
  total: number,
  direction: Direction,
  hasChanges: (index: number) => boolean | Promise<boolean>,
): Promise<number | undefined> {
  const step = direction === 'next' ? 1 : -1;
  for (let i = index + step; i >= 0 && i < total; i += step) {
    if (await hasChanges(i)) return i;
  }
  return undefined;
}

/**
 * A rename or copy git scored at 100% has identical contents on both sides,
 * which can be told without reading either.
 */
export function hasIdenticalSides(status: string): boolean {
  return status === 'R100' || status === 'C100';
}

/**
 * The lines VS Code compares, as `computeLineChanges` wants them. Its models
 * compare lines without their endings, so a CRLF file against an LF one is not
 * a change, and trimmed unless `diffEditor.ignoreTrimWhitespace` is off.
 */
function comparable(text: string, ignoreTrimWhitespace: boolean): string {
  const lines = text.split(/\r\n|\r|\n/u);
  return (ignoreTrimWhitespace ? lines.map((l) => l.trim()) : lines).join('\n');
}

/**
 * The changes between two texts as GitTree's own diff sees them, or `undefined`
 * when the texts are too far apart for it to be exact: it would answer with one
 * block from the first change to the last, and "nothing after this one" would be
 * wrong for everything in between.
 */
export function predictedChanges(
  original: string,
  modified: string,
  ignoreTrimWhitespace: boolean,
): readonly Change[] | undefined {
  const a = comparable(original, ignoreTrimWhitespace);
  const b = comparable(modified, ignoreTrimWhitespace);
  if (exceedsLineDiffCap(a, b)) return undefined;
  return toChanges(computeLineChanges(a, b));
}

/**
 * Whether VS Code's navigation would find a change ahead of `line`: the same
 * comparison its `goToDiff` makes, on the first line of each change.
 *
 * `lastLine` is the last line in the editor. A deletion at the very end anchors
 * past it, and the cursor can go no further than the last line, from which VS
 * Code always wraps.
 */
export function predict(
  changes: readonly Change[] | undefined,
  line: number,
  direction: Direction,
  lastLine: number,
): Prediction {
  if (changes === undefined) return 'unknown';
  if (direction === 'next') {
    if (line >= lastLine) return 'none';
    return changes.some((c) => Math.min(c.startLine, lastLine) > line) ? 'more' : 'none';
  }
  return changes.some((c) => Math.min(c.startLine, lastLine) < line) ? 'more' : 'none';
}

/**
 * The line a crossing lands on as far as GitTree's own diff can tell, so that the
 * file opens there rather than at its top. VS Code's navigation still has the
 * last word on it.
 */
export function expectedLanding(
  changes: readonly Change[] | undefined,
  landOn: 'first' | 'last',
): number {
  if (changes === undefined || changes.length === 0) return 0;
  const lines = changes.map((c) => c.startLine);
  return landOn === 'first' ? Math.min(...lines) : Math.max(...lines);
}

/**
 * Whether a crossing is over as soon as the file is open. With no change, or
 * with the change sought on the first line, VS Code's navigation would never
 * move the cursor, and waiting for it to would hold the next press for nothing.
 * Every added or deleted file is like this.
 */
export function alreadyLanded(
  changes: readonly Change[] | undefined,
  landOn: 'first' | 'last',
): boolean {
  return changes !== undefined && expectedLanding(changes, landOn) === 0;
}

/**
 * Whether a hover at this line would cover the editor's toolbar. VS Code draws a
 * hover above its line if the window has the room, counting what is above the
 * editor, so one near the top goes over the tabs and toolbar. In a window narrower
 * than about 1200px it lands right on the next-change button the pointer is still
 * on, and the second click, the one it asks for, hits the hover instead. Four lines
 * is the height of the hint.
 */
export function hoverWouldCoverToolbar(line: number, firstVisibleLine: number): boolean {
  return line - firstVisibleLine < 4;
}

/** `foo.ts (62c3e1a)` becomes `foo.ts (62c3e1a) 3/7`: where you are, on the tab. */
export function positionedTitle(title: string, index: number, total: number): string {
  return total > 1 ? `${title} ${index + 1}/${total}` : title;
}
