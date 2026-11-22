/**
 * Which part of `.git/logs/HEAD` is new and came from outside Geet (P9-T4,
 * POST-P14da). Pure — no vscode dependency — so it is unit-testable.
 *
 * Git only appends to the reflog, or rewrites it whole (`reflog expire`), so a
 * byte offset says what has been read. Geet's own lines are told apart by
 * where they are, not by when they came. While one of Geet's own mutations
 * runs, the new lines are left unread. When it finishes they are skipped:
 * its git has exited, so all of them are written by then. Whatever is
 * appended after that came from outside, however soon.
 *
 * Before, any change seen less than a second after one of Geet's mutations
 * counted as Geet's own. An external `git reset --hard` in that second went
 * unnoticed (on Linux and macOS CI, every time).
 */
export class ReflogTail {
  constructor(private offset: number) {}

  /** One of Geet's own mutations has finished: the log up to `size` bytes is its own. */
  ownUpTo(size: number): void {
    this.offset = size;
  }

  /**
   * The byte range written since the last read, for the caller to classify,
   * or undefined when there is nothing new that is not Geet's own.
   *
   * @param size the log's size now
   * @param mutationRunning one of Geet's own mutations is running, so what is
   *   new is taken to be its own and left for {@link ownUpTo}
   */
  takeExternal(size: number, mutationRunning: boolean): { from: number; to: number } | undefined {
    // Rewritten shorter (reflog expire): nothing in it is new.
    if (size < this.offset) this.offset = size;
    if (mutationRunning || size === this.offset) return undefined;
    const range = { from: this.offset, to: size };
    this.offset = size;
    return range;
  }
}
