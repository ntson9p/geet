/**
 * Push argv assembly (P13-T1), vscode-free so the flag matrix is unit-testable.
 * One function owns the mapping from dialog options to `git push` arguments;
 * the dialog's "will run" line and the actual execution both read it, so what
 * the user is shown is what runs.
 *
 * Flag mapping, IntelliJ's `GitPushParamsImpl`:
 *   Run Git hooks OFF        → --no-verify
 *   Push tags: All           → --tags
 *   Push tags: Current Branch→ --follow-tags   (IntelliJ's `GitPushTagMode.FOLLOW`)
 *   Force                    → --force-with-lease (+ --force-if-includes when
 *                              the git build supports it; P5 push-safety rule)
 *   Set upstream             → --set-upstream (`pushModel.setsUpstream` decides)
 * The target is always an explicit `<remote> <source>:<target ref>` refspec
 * (`pushModel.pushRefspec`), which is what makes retargeting in the dialog
 * honest.
 */

export type PushTagsMode = 'none' | 'all' | 'follow';

export interface PushArgsOptions {
  readonly remote: string;
  /** `<source>:<target ref>`, from `pushRefspec`. */
  readonly refspec: string;
  readonly setUpstream: boolean;
  readonly tags: PushTagsMode;
  readonly runHooks: boolean;
  readonly force: boolean;
  /** `git push --force-with-lease --force-if-includes` supported (caps). */
  readonly forceIfIncludes: boolean;
}

export function buildPushArgs(o: PushArgsOptions): string[] {
  const args = ['push'];
  if (!o.runHooks) args.push('--no-verify');
  if (o.tags === 'all') args.push('--tags');
  else if (o.tags === 'follow') args.push('--follow-tags');
  if (o.force) {
    args.push('--force-with-lease');
    if (o.forceIfIncludes) args.push('--force-if-includes');
  }
  if (o.setUpstream) args.push('--set-upstream');
  args.push(o.remote, o.refspec);
  return args;
}

/**
 * `origin/feature/x` → `{remote: 'origin', branch: 'feature/x'}`. Split on the
 * longest **known** remote name first: both remote names and branch names may
 * contain slashes, so a naive first-slash split mis-reads `team/fork/main`.
 * Falls back to the first slash when no configured remote matches.
 */
export function splitUpstream(
  upstream: string,
  remotes: readonly string[],
): { remote: string; branch: string } | undefined {
  const byLength = [...remotes].sort((a, b) => b.length - a.length);
  for (const r of byLength) {
    if (upstream.startsWith(`${r}/`)) return { remote: r, branch: upstream.slice(r.length + 1) };
  }
  const slash = upstream.indexOf('/');
  if (slash > 0) return { remote: upstream.slice(0, slash), branch: upstream.slice(slash + 1) };
  return undefined;
}
