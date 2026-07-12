/**
 * Reflog line parsing & destructive-subject classification (P9-T4). Pure — no
 * vscode dependency — so the formats are unit-testable.
 */

export type DestructionKind = 'reset' | 'checkout-forced' | 'unknown';

/** Reflog line: `<old> <new> <author> <ts> <tz>\t<subject>`. */
export function parseReflogLine(
  line: string,
): { oldSha: string; newSha: string; subject: string } | undefined {
  const tab = line.indexOf('\t');
  if (tab === -1) return undefined;
  const head = line.slice(0, tab).split(' ');
  const oldSha = head[0];
  const newSha = head[1];
  if (oldSha === undefined || newSha === undefined) return undefined;
  if (!/^[0-9a-f]{40,64}$/.test(oldSha) || !/^[0-9a-f]{40,64}$/.test(newSha)) return undefined;
  return { oldSha, newSha, subject: line.slice(tab + 1).trim() };
}

/** Destructive-looking reflog subjects; undefined = benign (commit, pull, …). */
export function classifyReflogSubject(subject: string): DestructionKind | undefined {
  if (/^reset: moving to /.test(subject)) return 'reset';
  if (/^checkout: moving from /.test(subject)) return 'checkout-forced';
  return undefined;
}
