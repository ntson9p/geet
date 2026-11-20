/**
 * POST-P14ck guard: every path Geet puts after a `--` goes as a literal
 * pathspec, or is no pathspec at all. Git read a ticked `[id].tsx` as a
 * pattern that also names `i.tsx` and `d.tsx` — committing them, rolling
 * their changes back, deleting them — and nothing said so. A new call site
 * that spreads paths after `--` without `literalPathspecs` fails here, as does
 * an allowance below that no longer matches anything.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '../../../..');

/** What may follow a `'--'` without the helper, and why it is no pathspec. */
const NOT_PATHS: ReadonlyArray<{ file: string; next: RegExp; why: string }> = [
  { file: 'src/branches/branchCleanup.ts', next: /^(\.\.\.list\.map\(\(c\) => c\.name\)|d\.name\b)/u, why: 'branch names' },
  { file: 'src/branches/branchOps.ts', next: /^branch\b/u, why: 'a branch name; `git merge -- <branch>` takes a ref' },
  { file: 'src/branches/newBranchArgs.ts', next: /^o\.name\b/u, why: 'a branch name and its start point' },
  { file: 'src/localHistory/recoveryWatch.ts', next: /^branch\b/u, why: 'a branch name' },
  { file: 'src/log/commitActions.ts', next: /^name\.trim\(\)/u, why: 'a branch or tag name' },
  {
    file: 'src/log/commitActions.ts',
    next: /^\.\.\.paths\] : \[\]\)/u,
    why: "Compare Versions: the log filter's own pathspecs, made literal where they were picked",
  },
  {
    file: 'src/log/logFilter.ts',
    next: /^\.\.\.f\.paths\)/u,
    why: 'the filter holds pathspecs: a typed glob stays one, a picked path was made literal when picked',
  },
  {
    file: 'src/log/blame/blameService.ts',
    next: /^rel\)/u,
    why: "blame takes the file's name, and would read a `:(literal)` prefix as part of it",
  },
  { file: 'src/scm/dialogs/cloneArgs.ts', next: /^o\.url\.trim\(\)/u, why: 'a URL and a directory' },
  { file: 'src/scm/dialogs/mergeArgs.ts', next: /^o\.ref\)/u, why: 'a ref' },
  { file: 'src/scm/dialogs/pushDialog.ts', next: /^\]/u, why: 'the end of a revision list: nothing follows' },
  { file: 'src/scm/dialogs/pushDialog.ts', next: /^url\]/u, why: 'a remote URL' },
  { file: 'src/core/git/pathspec.ts', next: /^\)/u, why: 'the helper itself, finding the separator' },
];

const LITERAL = /^(\.\.\.literalPathspecs\(|literalPathspec\()/u;

function sources(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) sources(p, out);
    else if (e.name.endsWith('.ts')) out.push(p);
  }
  return out;
}

interface Separator {
  readonly file: string;
  readonly line: number;
  /** The code after `'--'`, its comma and whitespace skipped. */
  readonly next: string;
}

function separators(): Separator[] {
  const found: Separator[] = [];
  for (const abs of sources(path.join(root, 'src'))) {
    const file = path.relative(root, abs).replace(/\\/gu, '/');
    const text = fs.readFileSync(abs, 'utf8');
    for (const m of text.matchAll(/'--'/gu)) {
      const at = m.index ?? 0;
      found.push({
        file,
        line: text.slice(0, at).split('\n').length,
        next: text
          .slice(at + 4)
          .replace(/^[\s,]+/u, '')
          .slice(0, 60)
          .replace(/\s+/gu, ' '),
      });
    }
  }
  return found;
}

describe('paths after `--` (POST-P14ck)', () => {
  const all = separators();

  it('finds the call sites at all', () => {
    // A scan that matched nothing would pass everything below.
    expect(all.length).toBeGreaterThan(40);
    expect(all.filter((s) => LITERAL.test(s.next)).length).toBeGreaterThan(30);
  });

  it('puts every path after `--` through literalPathspec(s), unless it is no pathspec', () => {
    const unexplained = all
      .filter((s) => !LITERAL.test(s.next))
      .filter((s) => !NOT_PATHS.some((n) => n.file === s.file && n.next.test(s.next)))
      .map((s) => `${s.file}:${s.line}  '--', ${s.next}`);
    expect(unexplained).toEqual([]);
  });

  it('keeps no allowance that matches nothing any more', () => {
    const stale = NOT_PATHS.filter(
      (n) => !all.some((s) => s.file === n.file && !LITERAL.test(s.next) && n.next.test(s.next)),
    ).map((n) => `${n.file} ${String(n.next)} (${n.why})`);
    expect(stale).toEqual([]);
  });

  it("never uses git's global --literal-pathspecs, which git hands on to hooks", () => {
    // `git --literal-pathspecs commit` runs the hooks with
    // GIT_LITERAL_PATHSPECS=1, and a hook's own `-- '*.ts'` matches nothing.
    // A string in code, not the backquoted name in a comment.
    const global = sources(path.join(root, 'src'))
      .filter((abs) => /['"]--literal-pathspecs['"]/u.test(fs.readFileSync(abs, 'utf8')))
      .map((abs) => path.relative(root, abs).replace(/\\/gu, '/'));
    expect(global).toEqual([]);
  });
});
