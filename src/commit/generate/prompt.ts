/**
 * The request a language model is sent for a commit message, and what is made
 * of its answer (POST-P14cj, Generate Commit Message). Pure and free of
 * `vscode`, so the prompt, the fitting and the clean-up are unit-tested with no
 * model at all: the model's answer is the one part that cannot be.
 *
 * The shape follows what Copilot's own generator sends (its
 * `gitCommitMessagePrompt.tsx`): the rules, the repository and branch, recent
 * messages for their style only, then the changes. IntelliJ's AI Assistant
 * adds the author's own instructions and `$GIT_BRANCH_NAME`; so does this.
 */
import type { ChangeDiff } from './changeDiff';

export interface PromptRepo {
  /** The name the Commit window shows it by. */
  readonly name: string;
  /** Nothing when HEAD is detached. */
  readonly branch?: string;
  /** With Amend ticked: the message of the commit being rewritten. */
  readonly amendedMessage?: string;
  readonly changes: readonly ChangeDiff[];
}

export interface PromptInput {
  readonly repos: readonly PromptRepo[];
  /** Subjects of recent commits, newest first: style to follow, never content. */
  readonly recentSubjects: readonly string[];
  /** `gittree.commit.messageGeneration.instructions`, as typed. */
  readonly instructions?: string;
  /** The most characters of diff text to send, all files together. */
  readonly diffBudget: number;
}

export interface BuiltPrompt {
  /** The rules, sent first. The Language Model API has no system message: this is a user's. */
  readonly rules: string;
  /** The repository, its changes, and the ask. */
  readonly request: string;
  /** Files whose diff is in the request whole. */
  readonly shownWhole: number;
  /** Files whose diff is there in part. */
  readonly shownCut: number;
  /** Files named in the list only: binary, or no room left. */
  readonly listedOnly: number;
}

/** A subject longer than this is cut where git's own one-line logs start to wrap. */
export const SUBJECT_LIMIT = 72;
/** How many recent subjects are shown: enough for a convention to show, few enough not to be copied. */
export const RECENT_SUBJECTS = 10;
/** The least room a file's diff is given when it cannot be shown whole; under it, it is listed by name alone. */
export const MIN_FILE_DIFF_CHARS = 200;
/** The most files a repository's list names: a merge can change thousands, and the list alone must fit. */
export const MAX_LISTED_FILES = 300;

/** IntelliJ's variable in the author's instructions: the branch being committed to. */
export function expandInstructions(text: string, branch: string | undefined): string {
  return text.replace(/\$GIT_BRANCH_NAME\b/gu, branch ?? 'HEAD').trim();
}

const STATUS_LETTER: Record<ChangeDiff['status'], string> = {
  added: 'A',
  deleted: 'D',
  modified: 'M',
  renamed: 'R',
  copied: 'C',
};

/** One row of the file list: `M src/a.ts (+10 -2)`. */
export function changeLine(change: ChangeDiff): string {
  const name = change.origPath !== undefined ? `${change.origPath} -> ${change.path}` : change.path;
  const counts: string[] = [];
  if (change.binary) counts.push('binary or too large to show');
  else {
    if (change.added > 0) counts.push(`+${change.added}`);
    if (change.deleted > 0) counts.push(`-${change.deleted}`);
  }
  const notes: string[] = [];
  if (counts.length > 0) notes.push(counts.join(' '));
  if (change.partial === true) notes.push('only part of its changes');
  if (change.amended === true) notes.push('already in the commit being amended');
  return `${STATUS_LETTER[change.status]} ${name}${notes.length > 0 ? ` (${notes.join('; ')})` : ''}`;
}

/**
 * How many characters of each diff fit in `budget`: every diff whole when they
 * all fit, else the small ones whole and the large ones an equal share of what
 * is left, so one lock file cannot crowd out ten source files. A share under
 * `min` is not worth showing: that diff gets nothing, and the ones after it
 * share what it would have had.
 */
export function shareBudget(sizes: readonly number[], budget: number, min = 0): number[] {
  const out = sizes.map(() => 0);
  const order = sizes.map((size, i) => ({ size, i })).sort((a, b) => a.size - b.size);
  let left = Math.max(0, Math.floor(budget));
  order.forEach(({ size, i }, at) => {
    const share = Math.floor(left / (order.length - at));
    const given = size <= share ? size : share >= min ? share : 0;
    out[i] = given;
    left -= given;
  });
  return out;
}

/** `text` cut to whole lines within `limit` characters, and how many lines went. */
export function cutToLines(text: string, limit: number): { text: string; cut: number } {
  if (text.length <= limit) return { text, cut: 0 };
  const lines = text.split('\n');
  const kept: string[] = [];
  let used = 0;
  for (const line of lines) {
    if (used + line.length + 1 > limit) break;
    kept.push(line);
    used += line.length + 1;
  }
  return { text: kept.join('\n'), cut: lines.length - kept.length };
}

const linesLeftOut = (n: number): string => `[... ${n} more ${n === 1 ? 'line' : 'lines'} of this diff not shown]`;

function rulesText(input: PromptInput, branch: string | undefined): string {
  const out: string[] = [
    'You write git commit messages. You are given the changes of one commit, and you answer with the commit message for it and nothing else.',
    '',
    'Rules:',
    `- Start with a subject line of at most ${SUBJECT_LIMIT} characters that says what the commit does, in the imperative mood, with no full stop at its end.`,
    '- If the changes need explaining, leave one blank line after the subject and add a short body saying what changed and why, wrapped at 72 characters. Leave the body out for a small or obvious change.',
    '- Describe only what the changes show. Do not invent reasons, issue numbers, names or co-authors.',
    '- Answer with the commit message as plain text: no code fence, no quotation marks around it, no heading, no explanation before or after it.',
  ];
  const recent = input.recentSubjects.filter((s) => s.trim().length > 0).slice(0, RECENT_SUBJECTS);
  if (recent.length > 0) {
    out.push(
      "- Follow the conventions of this repository's recent commit messages, listed below: their prefixes, capitalisation, tense and language. They are examples of style only; do not copy their content.",
      '',
      'Recent commit messages (style only):',
      ...recent.map((s) => `- ${s.trim()}`),
    );
  }
  const own = input.instructions !== undefined ? expandInstructions(input.instructions, branch) : '';
  if (own.length > 0) {
    out.push('', "The author's own instructions, which come before the rules above where they differ:", own);
  }
  return out.join('\n');
}

/**
 * The two messages of a request. `diffBudget` is shared among every file's
 * diff; the list of files names them all (up to `MAX_LISTED_FILES` a
 * repository), so the model knows of a change even when it is shown none of it.
 */
export function buildPrompt(input: PromptInput): BuiltPrompt {
  const several = input.repos.length > 1;
  const first = input.repos[0];
  const rules = rulesText(input, first?.branch);

  const all = input.repos.flatMap((repo) => repo.changes);
  const shares = shareBudget(
    all.map((c) => (c.binary ? 0 : c.diff.length)),
    input.diffBudget,
    MIN_FILE_DIFF_CHARS,
  );
  let shownWhole = 0;
  let shownCut = 0;
  let listedOnly = 0;
  let at = 0;

  const out: string[] = [];
  for (const repo of input.repos) {
    if (several) out.push(`## Repository: ${repo.name}`);
    else out.push(`Repository: ${repo.name}`);
    out.push(repo.branch !== undefined ? `Branch: ${repo.branch}` : 'Branch: none (detached HEAD)');
    if (repo.amendedMessage !== undefined) {
      out.push(
        '',
        'This commit amends the last commit: the message you write replaces its message, and describes its changes together with the new ones.',
        'The message of the commit being amended:',
        '<<<',
        repo.amendedMessage.trim(),
        '>>>',
      );
    }
    const listed = repo.changes.slice(0, MAX_LISTED_FILES).map(changeLine);
    const unlisted = repo.changes.length - listed.length;
    out.push(
      '',
      `Changed files${unlisted > 0 ? ` (${repo.changes.length} in all)` : ''}:`,
      ...listed,
      ...(unlisted > 0 ? [`[... and ${unlisted} more ${unlisted === 1 ? 'file' : 'files'}]`] : []),
      '',
    );
    const diffs: string[] = [];
    for (const change of repo.changes) {
      const share = shares[at++] ?? 0;
      if (change.binary || change.diff.length === 0 || share === 0) {
        listedOnly++;
        continue;
      }
      const { text, cut } = cutToLines(change.diff, share);
      const left = cut + change.cutLines;
      if (text.length === 0) {
        listedOnly++;
        continue;
      }
      if (left > 0) shownCut++;
      else shownWhole++;
      diffs.push(left > 0 ? `${text}\n${linesLeftOut(left)}` : text);
    }
    if (diffs.length > 0) out.push('Diffs:', '```diff', diffs.join('\n'), '```', '');
    else out.push('(No diff is shown: write the message from the list of files.)', '');
  }
  out.push(
    several
      ? 'Write one commit message for these changes now: the same message is used for the commit in each repository.'
      : 'Write the commit message for these changes now.',
  );
  return { rules, request: out.join('\n'), shownWhole, shownCut, listedOnly };
}

/**
 * The inside of a code fence the answer is wrapped in: one that opens the
 * answer, or follows a single line ending in a colon (`Here is the message:`),
 * with at most a line after it. A fence further down is left alone: it is part
 * of a message whose body shows code.
 */
function unfenced(text: string): string {
  const open = text.indexOf('```');
  if (open === -1) return text;
  const before = text.slice(0, open).trim();
  if (before.length > 0 && (before.includes('\n') || !before.endsWith(':'))) return text;
  const afterOpen = text.slice(open + 3);
  const firstBreak = afterOpen.indexOf('\n');
  // The rest of the opening line is the fence's language, if any.
  if (firstBreak === -1) return text;
  const body = afterOpen.slice(firstBreak + 1);
  const close = body.startsWith('```') ? 0 : body.indexOf('\n```');
  if (close === -1) return body.trim(); // opened and never closed: an answer cut short
  const inner = body.slice(0, close);
  const rest = body.slice(close === 0 ? 3 : close + 4).trim();
  return rest.includes('\n') ? text : inner.trim();
}

/**
 * The commit message in a model's answer. Asked for plain text, a model still
 * wraps it in a code fence often enough (Copilot's own generator asks for one
 * and unwraps it), puts a label before it, or quotes it.
 */
export function cleanMessage(raw: string): string {
  let text = raw.replace(/\r\n?/gu, '\n').trim();
  text = unfenced(text);
  // `Commit message:` and nothing shorter: `message:` can be a repository's own prefix.
  text = text.replace(/^commit message\s*:\s*/iu, '').trim();
  // The whole message in one pair of quotes or backticks.
  const quoted = /^(["'`])([\s\S]*)\1$/u.exec(text);
  if (quoted !== null && !(quoted[2] ?? '').includes(quoted[1] ?? '')) text = (quoted[2] ?? '').trim();
  return text
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/u, ''))
    .join('\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
}
