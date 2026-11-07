/**
 * `.gitignore` editing rules (POST-P14w) — pure, so the escaping and the
 * choice of file are unit-tested rather than discovered on a repository the
 * user cannot easily undo.
 *
 * IntelliJ's `Add to .gitignore` writes an **anchored, repository-relative**
 * pattern into the ignore file nearest the excluded path. Both halves matter:
 * an unanchored `build.log` would also hide `vendor/build.log`, and a pattern
 * written into the wrong file would be scoped to the wrong subtree.
 */

/** Characters git reads as pattern syntax rather than as part of a name. */
const GLOB_META = /[\\*?[\]]/gu;

/**
 * One gitignore pattern for a path expressed **relative to the directory the
 * ignore file lives in**.
 *
 * The leading `/` anchors the pattern to that directory, which is what makes
 * `a/b.txt` mean only `a/b.txt`. Glob metacharacters in the name are escaped:
 * a file genuinely called `notes[1].md` must not become a character class that
 * matches `notes1.md` and misses itself.
 *
 * A folder (POST-P14bf) gets git's trailing `/`, which matches only a
 * directory: `/build/` ignores the folder and everything in it, as IntelliJ
 * writes a folder's rule.
 */
export function ignorePattern(relPath: string, isDir = false): string {
  const normalized = relPath.replace(/\\/gu, '/').replace(/^\/+/u, '').replace(/\/+$/u, '');
  const escaped = normalized
    .split('/')
    .map((segment) => segment.replace(GLOB_META, (c) => `\\${c}`))
    .join('/');
  // `#` and `!` are only special in column 1, which is where this pattern
  // starts — but the `/` prefix already displaces them, so nothing more is
  // needed. A trailing space *would* be stripped by git, so escape that.
  const guarded = escaped.replace(/ $/u, '\\ ');
  return isDir ? `/${guarded}/` : `/${guarded}`;
}

/**
 * Appends the patterns that are not already spelled out in `existing`, and
 * returns the new file text — or `undefined` when every one of them is there.
 *
 * Only *literal* duplicates are suppressed. Deciding whether some other rule
 * already covers a path is `git check-ignore`'s job, and a path that reaches
 * here came out of `Unversioned Files`, so by construction nothing covers it.
 */
export function appendPatterns(existing: string, patterns: readonly string[]): string | undefined {
  const present = new Set(existing.split(/\r?\n/u).map((line) => line.trim()));
  const fresh = patterns.filter((p) => !present.has(p));
  if (fresh.length === 0) return undefined;
  const eol = existing.includes('\r\n') ? '\r\n' : '\n';
  const head = existing.length === 0 || /\r?\n$/u.test(existing) ? existing : existing + eol;
  return head + fresh.join(eol) + eol;
}

/**
 * Which `.gitignore` a path belongs in: the nearest existing one above its
 * directory, else the repository root's (which the caller creates).
 *
 * `ignoreDirs` holds the repo-relative directories that already have one, `''`
 * meaning the repository root. Returning a directory rather than a file path
 * keeps this free of path-separator questions.
 */
export function ignoreFileDirFor(relPath: string, ignoreDirs: ReadonlySet<string>): string {
  const parts = relPath.replace(/\\/gu, '/').split('/');
  for (let depth = parts.length - 1; depth > 0; depth--) {
    const dir = parts.slice(0, depth).join('/');
    if (ignoreDirs.has(dir)) return dir;
  }
  return '';
}

export interface IgnoreEdit {
  /** Repo-relative directory of the `.gitignore` to write; `''` is the root. */
  readonly dir: string;
  /** Patterns to append, in the order the rows were selected. */
  readonly patterns: string[];
}

/**
 * Groups a selection into one edit per ignore file. A selection spanning two
 * subtrees that each own a `.gitignore` writes to both, which is what makes
 * the nearest-file rule usable on a multi-select at all. The paths in
 * `folders` are folders, and get a folder's rule; an ignore file inside a
 * folder cannot ignore the folder itself, so theirs is the nearest above it,
 * which is what `ignoreFileDirFor` finds for any path.
 */
export function planIgnoreEdits(
  relPaths: readonly string[],
  ignoreDirs: ReadonlySet<string>,
  folders: ReadonlySet<string> = new Set(),
): IgnoreEdit[] {
  const byDir = new Map<string, string[]>();
  for (const relPath of relPaths) {
    const dir = ignoreFileDirFor(relPath, ignoreDirs);
    const within = dir === '' ? relPath : relPath.slice(dir.length + 1);
    const pattern = ignorePattern(within, folders.has(relPath));
    const list = byDir.get(dir);
    if (list) {
      if (!list.includes(pattern)) list.push(pattern);
    } else {
      byDir.set(dir, [pattern]);
    }
  }
  return [...byDir].map(([dir, patterns]) => ({ dir, patterns }));
}
