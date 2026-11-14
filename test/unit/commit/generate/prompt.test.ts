/**
 * POST-P14cj, Generate Commit Message: what a language model is asked, how the
 * diffs are fitted to what it takes, and what is made of its answer.
 */
import { describe, expect, it } from 'vitest';
import type { ChangeDiff } from '../../../../src/commit/generate/changeDiff';
import {
  buildPrompt,
  changeLine,
  cleanMessage,
  cutToLines,
  expandInstructions,
  MAX_LISTED_FILES,
  MIN_FILE_DIFF_CHARS,
  RECENT_SUBJECTS,
  shareBudget,
  SUBJECT_LIMIT,
} from '../../../../src/commit/generate/prompt';

function change(path: string, over: Partial<ChangeDiff> = {}): ChangeDiff {
  return {
    path,
    status: 'modified',
    added: 1,
    deleted: 1,
    binary: false,
    diff: `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-old\n+new`,
    cutLines: 0,
    ...over,
  };
}

describe('the list of changed files', () => {
  it('says what happened to each file, and by how much', () => {
    expect(changeLine(change('src/a.ts', { added: 10, deleted: 2 }))).toBe('M src/a.ts (+10 -2)');
    expect(changeLine(change('b.ts', { status: 'added', added: 40, deleted: 0 }))).toBe('A b.ts (+40)');
    expect(changeLine(change('c.ts', { status: 'deleted', added: 0, deleted: 12 }))).toBe('D c.ts (-12)');
    expect(changeLine(change('new.ts', { status: 'renamed', origPath: 'old.ts', added: 0, deleted: 0 }))).toBe(
      'R old.ts -> new.ts',
    );
    expect(changeLine(change('d.ts', { status: 'copied', origPath: 'a.ts', added: 1, deleted: 0 }))).toBe(
      'C a.ts -> d.ts (+1)',
    );
  });

  it('says so of a binary file, a file committed in part, and one the amended commit holds already', () => {
    expect(changeLine(change('logo.png', { binary: true, added: 0, deleted: 0, diff: '' }))).toBe(
      'M logo.png (binary or too large to show)',
    );
    expect(changeLine(change('p.ts', { partial: true }))).toBe('M p.ts (+1 -1; only part of its changes)');
    expect(changeLine(change('q.ts', { status: 'added', deleted: 0, amended: true }))).toBe(
      'A q.ts (+1; already in the commit being amended)',
    );
  });
});

describe('sharing the diff budget', () => {
  it('gives every diff its whole when they all fit', () => {
    expect(shareBudget([10, 10], 100)).toEqual([10, 10]);
    expect(shareBudget([], 10)).toEqual([]);
  });

  it('keeps the small ones whole and shares the rest among the large, in the order given', () => {
    // 100 whole, 300 whole, and what is left to the one that cannot fit.
    expect(shareBudget([100, 5000, 300], 1000)).toEqual([100, 600, 300]);
    expect(shareBudget([5000, 5000], 1000)).toEqual([500, 500]);
  });

  it('gives nothing with no budget', () => {
    expect(shareBudget([50, 50], 0)).toEqual([0, 0]);
    expect(shareBudget([50], -5)).toEqual([0]);
  });

  it('gives a share under the minimum to nobody, and what it frees to the next', () => {
    // Three of 300 in 500: 166 each is under 200, so the first gets nothing, and the other two 250 each.
    expect(shareBudget([300, 300, 300], 500, 200)).toEqual([0, 250, 250]);
    // Under the minimum even for the last one alone: nobody.
    expect(shareBudget([300, 300], 199, 200)).toEqual([0, 0]);
    // A diff that fits its share is whole however small the share.
    expect(shareBudget([50, 400, 400], 500, 200)).toEqual([50, 225, 225]);
  });

  it('cuts on whole lines', () => {
    expect(cutToLines('aaa\nbbb\nccc', 8)).toEqual({ text: 'aaa\nbbb', cut: 1 });
    expect(cutToLines('aaa', 10)).toEqual({ text: 'aaa', cut: 0 });
    expect(cutToLines('aaaaaaaaaaaa\nb', 5)).toEqual({ text: '', cut: 2 });
  });
});

describe('the request', () => {
  const input = {
    repos: [{ name: 'shop', branch: 'feature/x', changes: [change('src/a.ts'), change('src/b.ts', { status: 'added' as const, deleted: 0 })] }],
    recentSubjects: ['cart: add totals', 'api: name the version'],
    diffBudget: 100_000,
  };

  it('opens with the rules: a subject within the limit, a body only when needed, nothing made up, plain text', () => {
    const { rules } = buildPrompt(input);
    expect(rules).toContain(`at most ${SUBJECT_LIMIT} characters`);
    expect(rules).toContain('imperative mood');
    expect(rules).toContain('Do not invent reasons, issue numbers, names or co-authors.');
    expect(rules).toContain('no code fence');
  });

  it('gives the recent subjects as examples of style, and says they are not to be copied', () => {
    const { rules } = buildPrompt(input);
    expect(rules).toContain('Recent commit messages (style only):\n- cart: add totals\n- api: name the version');
    expect(rules).toContain('do not copy their content');
  });

  it('leaves the style rule out with no history, and shows no more subjects than its limit', () => {
    expect(buildPrompt({ ...input, recentSubjects: [] }).rules).not.toContain('Recent commit messages');
    expect(buildPrompt({ ...input, recentSubjects: ['', '  '] }).rules).not.toContain('Recent commit messages');
    const many = Array.from({ length: 30 }, (_, i) => `subject ${i}`);
    const { rules } = buildPrompt({ ...input, recentSubjects: many });
    expect(rules).toContain(`- subject ${RECENT_SUBJECTS - 1}`);
    expect(rules).not.toContain(`- subject ${RECENT_SUBJECTS}\n`);
    expect(rules.endsWith(`- subject ${RECENT_SUBJECTS - 1}`)).toBe(true);
  });

  it('adds the author’s own instructions last, with IntelliJ’s $GIT_BRANCH_NAME filled in', () => {
    const { rules } = buildPrompt({ ...input, instructions: '  Start with [$GIT_BRANCH_NAME]. Write in French.  ' });
    expect(rules.endsWith('Start with [feature/x]. Write in French.')).toBe(true);
    expect(rules).toContain("The author's own instructions, which come before the rules above where they differ:");
    expect(buildPrompt({ ...input, instructions: '   ' }).rules).not.toContain("author's own instructions");
  });

  it('expands the variable only as a whole word, and to HEAD when detached', () => {
    expect(expandInstructions(' Use $GIT_BRANCH_NAME and $GIT_BRANCH_NAMEX ', 'main')).toBe('Use main and $GIT_BRANCH_NAMEX');
    expect(expandInstructions('$GIT_BRANCH_NAME', undefined)).toBe('HEAD');
  });

  it('names the repository and branch, lists every file, and shows the diffs in one fence', () => {
    const built = buildPrompt(input);
    expect(built.request.startsWith('Repository: shop\nBranch: feature/x\n\nChanged files:\nM src/a.ts (+1 -1)\nA src/b.ts (+1)\n')).toBe(true);
    expect(built.request).toContain('Diffs:\n```diff\ndiff --git a/src/a.ts b/src/a.ts');
    expect(built.request).toContain('+new\ndiff --git a/src/b.ts b/src/b.ts');
    expect(built.request.endsWith('```\n\nWrite the commit message for these changes now.')).toBe(true);
    expect(built).toMatchObject({ shownWhole: 2, shownCut: 0, listedOnly: 0 });
  });

  it('says a detached HEAD has no branch', () => {
    const { request } = buildPrompt({ ...input, repos: [{ name: 'shop', changes: [change('a.ts')] }] });
    expect(request).toContain('Branch: none (detached HEAD)');
  });

  it('cuts a diff that does not fit and says how many lines went, the collector’s cut lines included', () => {
    const long = change('big.json', { diff: Array.from({ length: 200 }, (_, i) => `+line ${i}`).join('\n'), cutLines: 40 });
    const built = buildPrompt({ ...input, repos: [{ name: 'shop', branch: 'main', changes: [long] }], diffBudget: 400 });
    const shown = built.request.split('```diff\n')[1]!.split('\n```')[0]!.split('\n');
    const kept = shown.length - 1;
    expect(shown.at(-1)).toBe(`[... ${200 - kept + 40} more lines of this diff not shown]`);
    expect(kept).toBeGreaterThan(20);
    expect(built).toMatchObject({ shownWhole: 0, shownCut: 1, listedOnly: 0 });
  });

  it('says one line, not one lines', () => {
    const built = buildPrompt({ ...input, repos: [{ name: 's', branch: 'm', changes: [change('a.ts', { cutLines: 1 })] }] });
    expect(built.request).toContain('[... 1 more line of this diff not shown]');
  });

  it('lists a file by name alone when binary, or when there is no room for a piece worth showing', () => {
    const big = (name: string): ChangeDiff => change(name, { diff: 'x'.repeat(40) + '\n' + 'y'.repeat(MIN_FILE_DIFF_CHARS * 3) });
    const built = buildPrompt({
      ...input,
      repos: [{ name: 'shop', branch: 'main', changes: [change('logo.png', { binary: true, diff: '' }), big('one.ts'), big('two.ts')] }],
      // Under the minimum even for one of them alone: neither is shown in part.
      diffBudget: MIN_FILE_DIFF_CHARS - 1,
    });
    expect(built.request).toContain('M logo.png (binary or too large to show)');
    expect(built.request).toContain('M one.ts (+1 -1)');
    expect(built.listedOnly).toBe(3);
    expect(built.request).toContain('(No diff is shown: write the message from the list of files.)');
    expect(built.request).not.toContain('```diff');
  });

  it('with Amend, says the message replaces the last commit’s, and quotes that one', () => {
    const { request } = buildPrompt({
      ...input,
      repos: [{ name: 'shop', branch: 'main', amendedMessage: 'fix: the thing\n\nIts body.\n', changes: [change('a.ts', { amended: true })] }],
    });
    expect(request).toContain('This commit amends the last commit');
    expect(request).toContain('The message of the commit being amended:\n<<<\nfix: the thing\n\nIts body.\n>>>');
    expect(request).toContain('M a.ts (+1 -1; already in the commit being amended)');
  });

  it('with several repositories, heads each one and asks for one message for all', () => {
    const { request, rules } = buildPrompt({
      ...input,
      repos: [
        { name: 'api', branch: 'main', changes: [change('a.ts')] },
        { name: 'web', branch: 'develop', changes: [change('b.ts')] },
      ],
      instructions: 'on $GIT_BRANCH_NAME',
    });
    expect(request).toContain('## Repository: api\nBranch: main');
    expect(request).toContain('## Repository: web\nBranch: develop');
    expect(request.endsWith('the same message is used for the commit in each repository.')).toBe(true);
    // The variable is the first repository's branch.
    expect(rules.endsWith('on main')).toBe(true);
  });

  it('names no more files than its limit, and says how many it left out', () => {
    const changes = Array.from({ length: MAX_LISTED_FILES + 2 }, (_, i) => change(`f${i}.ts`, { diff: '' }));
    const { request } = buildPrompt({ ...input, repos: [{ name: 'big', branch: 'main', changes }] });
    expect(request).toContain(`Changed files (${MAX_LISTED_FILES + 2} in all):`);
    expect(request).toContain(`M f${MAX_LISTED_FILES - 1}.ts (+1 -1)\n[... and 2 more files]`);
    expect(request).not.toContain(`M f${MAX_LISTED_FILES}.ts`);
  });
});

describe('the answer', () => {
  it('is taken as it is when it is a plain message', () => {
    expect(cleanMessage('feat: add the parser\n\nIt reads the system patterns.')).toBe(
      'feat: add the parser\n\nIt reads the system patterns.',
    );
  });

  it('comes out of a code fence, with or without a language, a lead-in or a line after', () => {
    expect(cleanMessage('```text\nfeat: a\n\nbody\n```')).toBe('feat: a\n\nbody');
    expect(cleanMessage('```\nfix: b\n```')).toBe('fix: b');
    expect(cleanMessage('Here is the commit message:\n```\nfix: b\n```')).toBe('fix: b');
    expect(cleanMessage('```text\nfeat: i\n```\nHope this helps!')).toBe('feat: i');
  });

  it('comes out of a fence that was never closed: an answer cut short', () => {
    expect(cleanMessage('```\nfeat: cut short')).toBe('feat: cut short');
  });

  it('keeps a fence further down: a message whose body shows code', () => {
    const message = 'fix: c\n\nExample:\n```\ncode\n```';
    expect(cleanMessage(message)).toBe(message);
  });

  it('loses the quotes around it, but not ones that belong to it', () => {
    expect(cleanMessage('"chore: d"')).toBe('chore: d');
    expect(cleanMessage('`single`')).toBe('single');
    expect(cleanMessage("'it's e'")).toBe("'it's e'");
    expect(cleanMessage('`a` is now `b`')).toBe('`a` is now `b`');
  });

  it('loses a `Commit message:` label, and keeps a prefix that only looks like one', () => {
    expect(cleanMessage('Commit message: docs: f')).toBe('docs: f');
    expect(cleanMessage('commit message:\nfix: g')).toBe('fix: g');
    expect(cleanMessage('message: g is a prefix here')).toBe('message: g is a prefix here');
  });

  it('tidies line ends, trailing spaces and runs of blank lines', () => {
    expect(cleanMessage('feat: h   \r\n\r\n\r\n\r\nbody  ')).toBe('feat: h\n\nbody');
    expect(cleanMessage('   \n  ')).toBe('');
    expect(cleanMessage('')).toBe('');
  });
});
