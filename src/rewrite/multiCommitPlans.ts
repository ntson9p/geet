/**
 * The plans behind the log's Drop Commits and Squash Commits…, for any number
 * of selected commits, adjacent or not — IntelliJ's `GitDropOperation` and
 * `GitSquashOperation` over its rebase todo model — and Squash's starting
 * message (`GitSquashedCommitsMessage.prettySquash`). Pure and vscode-free; the
 * service in `multiCommitEdit.ts` does the git reads and runs the plans.
 */
import type { RebasePlan, RebasePlanEntry } from './rebase/planSerializer';

/**
 * Whether the selected commits are one unbroken run of `range` (oldest
 * first). Dropping such a run needs no todo at all — `rebase --onto` past it —
 * which is also the only way to drop every commit above the base: a todo of
 * nothing but `drop` lines is refused by the plan validator.
 */
export function isContiguous(range: readonly string[], selected: ReadonlySet<string>): boolean {
  const at = range.flatMap((sha, i) => (selected.has(sha) ? [i] : []));
  if (at.length !== selected.size) return false;
  return at.every((index, k) => k === 0 || index === at[k - 1]! + 1);
}

/** Every commit of `range` kept, but the selected ones dropped. */
export function buildDropPlan(
  baseSha: string,
  range: readonly string[],
  selected: ReadonlySet<string>,
): RebasePlan {
  return {
    baseSha,
    entries: range.map((sha): RebasePlanEntry => ({ sha, action: selected.has(sha) ? 'drop' : 'pick' })),
  };
}

/**
 * IntelliJ's squash: the oldest selected commit becomes the root, the other
 * selected commits are moved up to sit right behind it (in their own order)
 * and folded in, and the root takes the new message. Commits that were not
 * selected keep their places.
 */
export function buildSquashPlan(
  baseSha: string,
  range: readonly string[],
  selected: ReadonlySet<string>,
  message: string,
): RebasePlan {
  const members = range.filter((sha) => selected.has(sha));
  const root = members[0];
  const entries: RebasePlanEntry[] = [];
  for (const sha of range) {
    if (sha === root) {
      entries.push({ sha, action: 'reword', message });
      for (const member of members.slice(1)) entries.push({ sha: member, action: 'fixup' });
    } else if (!selected.has(sha)) {
      entries.push({ sha, action: 'pick' });
    }
  }
  return { baseSha, entries };
}

const SQUASH_SEPARATOR = '\n\n\n';
const AUTOSQUASH_SUBJECT = /^(fixup|squash|amend)! (.+)/u;

const subjectOf = (message: string): string => message.split('\n', 1)[0] ?? '';

function isAutosquash(message: string): boolean {
  return AUTOSQUASH_SUBJECT.test(subjectOf(message));
}

/**
 * The message Squash Commits… starts from (IntelliJ's `prettySquash`): every
 * selected commit's message, once each, three newlines apart. A `fixup!` /
 * `squash!` / `amend!` commit whose target is in the selection gives only its
 * body, so the folded subject is not repeated.
 */
export function prettySquash(messages: readonly string[]): string {
  const subjects = new Set(messages.filter((m) => !isAutosquash(m)).map(subjectOf));
  const out = new Set<string>();
  for (const message of messages) {
    const target = AUTOSQUASH_SUBJECT.exec(subjectOf(message))?.[2];
    if (target !== undefined && subjects.has(target)) {
      const body = message.includes('\n') ? message.slice(message.indexOf('\n') + 1).trim() : '';
      if (body.length > 0) out.add(body);
    } else {
      out.add(message);
    }
  }
  return [...out].join(SQUASH_SEPARATOR);
}
