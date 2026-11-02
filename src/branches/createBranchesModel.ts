/**
 * What the New Branch form says once its branch is made in several repositories
 * (POST-P14ax), vscode-free so every combination is unit-tested.
 *
 * Making the branch can fail in one repository after another went through, and
 * checking it out can meet local changes in the way. Neither stops the rest any
 * more: the branch is made everywhere it can be, checked out where it can be,
 * and one notification says which, problems first.
 */
import { listNames } from './checkoutAcrossModel';

export type CreateResult =
  | {
      readonly kind: 'created';
      readonly label: string;
      /** Made and checked out, rather than only made. */
      readonly checkedOut: boolean;
      /** Local changes in the way were set aside and put back, or kept in the stash. */
      readonly setAside?: 'restored' | 'kept';
      /** Local changes in the way were thrown away (Local History has them). */
      readonly forced?: boolean;
    }
  /** Made, and not checked out: local changes were in the way and the user left them. */
  | { readonly kind: 'blocked'; readonly label: string; readonly head?: string; readonly files: readonly string[] }
  | { readonly kind: 'failed'; readonly label: string; readonly reason: string };

export interface CreateSummary {
  readonly kind: 'info' | 'warning';
  readonly message: string;
  /** Putting local changes back conflicted somewhere: there is something to resolve. */
  readonly conflicts: boolean;
}

function sentence(text: string): string {
  return /[.!?]$/u.test(text) ? text : `${text}.`;
}

/**
 * IntelliJ's words, for one repository or several: a branch off where you are
 * "was created"; one checked out from another ref is "Checked out new branch x
 * from y".
 */
export function summarizeNewBranch(
  name: string,
  from: string,
  results: readonly CreateResult[],
): CreateSummary {
  const created = results.filter((r): r is Extract<CreateResult, { kind: 'created' }> => r.kind === 'created');
  const blocked = results.filter((r): r is Extract<CreateResult, { kind: 'blocked' }> => r.kind === 'blocked');
  const failed = results.filter((r): r is Extract<CreateResult, { kind: 'failed' }> => r.kind === 'failed');
  const kept = created.filter((r) => r.setAside === 'kept');
  const several = results.length > 1;

  const parts: string[] = [];
  for (const r of failed.slice(0, 3)) parts.push(sentence(`Couldn't create ${name} in ${r.label}: ${r.reason}`));
  if (failed.length > 3) parts.push(`${failed.length - 3} more couldn't create it.`);
  for (const r of blocked) {
    const files = r.files.length === 0 ? 'local changes' : `local changes to ${listNames(r.files, 3)}`;
    parts.push(
      `${r.label} stays on ${r.head ?? 'its commit'}: your ${files} would be overwritten. ${name} is there, not checked out.`,
    );
  }
  if (kept.length > 0) {
    parts.push(
      `In ${listNames(kept.map((r) => r.label))}, putting your local changes back conflicted; they are kept in the stash.`,
    );
  }

  const where = (rs: readonly { label: string }[]): string =>
    !several ? '' : ` in ${rs.length > 4 ? `${rs.length} repositories` : listNames(rs.map((r) => r.label))}`;
  const out = created.filter((r) => r.checkedOut);
  const madeOnly = created.filter((r) => !r.checkedOut);
  if (out.length > 0) {
    parts.push(
      from === 'HEAD'
        ? `Branch ${name} was created and checked out${where(out)}.`
        : `Checked out new branch ${name} from ${from}${where(out)}.`,
    );
  }
  if (madeOnly.length > 0) parts.push(`Branch ${name} was created${where(madeOnly)}.`);
  const restored = created.filter((r) => r.setAside === 'restored');
  if (restored.length > 0) {
    parts.push(`Your local changes in ${listNames(restored.map((r) => r.label))} were set aside and put back.`);
  }
  const forced = created.filter((r) => r.forced === true);
  if (forced.length > 0) {
    parts.push(`Your local changes in ${listNames(forced.map((r) => r.label))} were discarded; Local History has them.`);
  }
  const conflicts = kept.length > 0;
  return {
    kind: failed.length > 0 || blocked.length > 0 || conflicts ? 'warning' : 'info',
    message: parts.join(' '),
    conflicts,
  };
}
