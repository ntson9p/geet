/**
 * Paths handed to git as pathspecs, read as the names they are (POST-P14ck).
 *
 * Git reads every path after `--` as a pattern, not a name: `[id].tsx` also
 * matches `i.tsx` and `d.tsx`, `*` and `?` match anything, and a path that
 * starts with `:` opens pathspec magic. So a ticked `[id].tsx` also committed a
 * changed `i.tsx` beside it, rolling it back threw away that file's changes
 * too, and cleaning an untracked `[x].txt` deleted an untracked `x.txt`
 * (each run against git 2.55). `:(literal)` in front makes git read the path
 * as the name it is.
 *
 * Only a path that needs it gets the prefix — one holding a character git
 * globs with (`*`, `?`, `[`, `\`: its `is_glob_special`) or starting with `:` —
 * so every other command line, and what the Console shows, stays as it was.
 *
 * Not git's own `--literal-pathspecs`: git hands that on to every process it
 * starts as `GIT_LITERAL_PATHSPECS=1`, hooks included, and a pre-commit hook's
 * `git diff --cached -- '*.ts'` then matches nothing (verified; Magit's FAQ
 * says the same, and Emacs's vc-git set the variable, broke hooks and went
 * back to the prefix, bug#39452). The prefix reaches only the command it is
 * given to.
 *
 * Only for pathspecs. `git blame -- <file>` takes the file's name and reads the
 * prefix as part of it; `git show <rev>:<path>`, `update-index --cacheinfo`,
 * `hash-object` and `merge-file` take names already.
 *
 * vscode-free and node-free: the webview imports `pathOfPathspec`.
 */

/** Git's pathspec magic that turns off globbing and every other magic. */
export const LITERAL_MAGIC = ':(literal)';

/** The characters git globs with (`is_glob_special`). */
const GLOB_SPECIAL = /[*?[\\]/u;

/**
 * A repository-relative path as a pathspec that matches that path alone.
 * Takes a path, never a pathspec: given one already prefixed, it prefixes
 * again, and git then finds no such file — loudly, rather than the wrong one.
 */
export function literalPathspec(relPath: string): string {
  return relPath.startsWith(':') || GLOB_SPECIAL.test(relPath) ? `${LITERAL_MAGIC}${relPath}` : relPath;
}

/** `literalPathspec` over a list: what every `git … -- <paths>` passes. */
export function literalPathspecs(relPaths: readonly string[]): string[] {
  return relPaths.map(literalPathspec);
}

/** The path a `literalPathspec` names, for showing it; anything else as it is. */
export function pathOfPathspec(spec: string): string {
  return spec.startsWith(LITERAL_MAGIC) ? spec.slice(LITERAL_MAGIC.length) : spec;
}

/**
 * Git's reading of a boolean environment variable (`git_parse_maybe_bool`):
 * `true`/`yes`/`on`, `false`/`no`/`off` in any case, empty for false, or a
 * number (with git's `k`/`m`/`g` units), true when not zero. Undefined for
 * anything else, which git refuses outright.
 */
export function gitBoolean(value: string): boolean | undefined {
  const v = value.toLowerCase();
  if (v === '') return false;
  if (v === 'true' || v === 'yes' || v === 'on') return true;
  if (v === 'false' || v === 'no' || v === 'off') return false;
  const number = /^\s*[-+]?(0x[0-9a-f]+|\d+)[kmg]?$/u.exec(v);
  if (number === null) return undefined;
  return !/^(0x)?0+$/u.test(number[1]!);
}

/** `GIT_LITERAL_PATHSPECS`'s value in a child's environment, as git finds it. */
function literalVariable(
  env: Readonly<Record<string, string | undefined>>,
  platform: string,
): string | undefined {
  const exact = env['GIT_LITERAL_PATHSPECS'];
  if (exact !== undefined || platform !== 'win32') return exact;
  // Windows names variables without regard to case, and git reads them so.
  const key = Object.keys(env).find((k) => k.toUpperCase() === 'GIT_LITERAL_PATHSPECS');
  return key === undefined ? undefined : env[key];
}

/**
 * The argv to run in this environment. With `GIT_LITERAL_PATHSPECS` on, git
 * reads every pathspec literally on its own and turns magic off as well, so
 * `:(literal)` would become part of the name: the prefix comes off again.
 * Only after `--`, where GitTree's pathspecs always are — a commit message or
 * a stash's name before it is never touched.
 */
export function pathspecsForEnvironment(
  args: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  platform: string,
): readonly string[] {
  const value = literalVariable(env, platform);
  if (value === undefined || gitBoolean(value) !== true) return args;
  const end = args.indexOf('--');
  if (end < 0) return args;
  return args.map((a, i) => (i > end && a.startsWith(LITERAL_MAGIC) ? a.slice(LITERAL_MAGIC.length) : a));
}
