/**
 * What the Rebase dialog's Interactive hands the interactive rebase editor, and
 * what it hears back (POST-P14cw). Vscode-free, for the unit tests.
 *
 * The dialog asks through `geet.rebase.interactive`, which the Log calls with
 * the commits picked there; this argument is told apart by its shape.
 */

/** `geet.rebase.interactive`'s argument from the Rebase dialog. */
export interface RebaseOntoArgs {
  repoRoot: string;
  /** The new base. */
  onto: string;
  /** Replay only the commits after this one (`--onto <onto> <from>`). */
  from?: string;
}

/** The editor opened, or why it did not, in words for the dialog to show. */
export type RebaseOntoResult =
  | { opened: true }
  | { opened: false; severity: 'info' | 'error'; message: string };

export function isRebaseOntoArgs(arg: unknown): arg is RebaseOntoArgs {
  if (typeof arg !== 'object' || arg === null) return false;
  const a = arg as Record<string, unknown>;
  return (
    typeof a['repoRoot'] === 'string' &&
    typeof a['onto'] === 'string' &&
    (a['from'] === undefined || typeof a['from'] === 'string')
  );
}
