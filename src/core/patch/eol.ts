/**
 * Line endings as git stores them (POST-QA F1).
 *
 * A checkout under `core.autocrlf=true` — the Git for Windows default — or a
 * `text`/`eol` attribute writes CRLF to the working tree while the blob keeps
 * LF, and git's clean filter turns CRLF back into LF on the way in. Diffing the
 * blob against the raw working-tree text therefore reports every line as
 * changed: the change bars light up the whole file, a per-change commit sees
 * one giant change, and a staged hunk carries its `\r` into the index.
 *
 * `toBlobEol` undoes the checkout conversion before anything is diffed, so a
 * diff describes the changes git itself sees. Line numbers never move (only a
 * `\r` before each `\n` goes), so the changes computed on the result address
 * the editor's lines unchanged. It converts only when the blob holds no CR at
 * all: a file committed with CRLF is compared byte for byte, as git would.
 * A file the user really converted to CRLF under `core.autocrlf=false` reads
 * as unchanged here; IntelliJ's change markers ignore line separators
 * entirely, so that is the IntelliJ behaviour too.
 *
 * Pure and vscode-free.
 */

export interface BlobEolText {
  /** The working-tree text with the checkout's CRLF turned back into LF. */
  readonly text: string;
  /** True when CRLF was converted: write-backs to the working tree restore it. */
  readonly crlf: boolean;
}

export function toBlobEol(blobText: string, worktreeText: string): BlobEolText {
  if (blobText.includes('\r') || !worktreeText.includes('\r\n')) {
    return { text: worktreeText, crlf: false };
  }
  return { text: worktreeText.replace(/\r\n/gu, '\n'), crlf: true };
}

/** LF → CRLF for text going back to a working tree `toBlobEol` converted. */
export function withCrlf(text: string): string {
  return text.replace(/\r?\n/gu, '\r\n');
}
