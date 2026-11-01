/**
 * `remote.<name>.push` refspecs, read the way IntelliJ's `GitPushSpecParser`
 * reads them to find where a branch goes by default — the case of a Gerrit
 * remote whose push spec is `HEAD:refs/for/master`. vscode-free.
 *
 * An exact match wins at once; otherwise the first wildcard match does, as
 * pushing one branch to several targets is not supported. A spec that is
 * malformed, or that does not match the branch, is skipped.
 */

const REFS_HEADS = 'refs/heads/';

interface TargetRef {
  ref: string;
  wildcard: boolean;
}

function targetOf(spec: string, branch: string): TargetRef | undefined {
  const parts = spec.split(':');
  if (parts.length !== 2) return undefined;
  const source = (parts[0] ?? '').trim().replace(/^\+/, '');
  const target = (parts[1] ?? '').trim();
  const sourceStar = source.indexOf('*');
  const targetStar = target.indexOf('*');
  if (sourceStar < 0 && targetStar < 0) {
    const exact = source === 'HEAD' || branch === source.replace(/^refs\/heads\//, '');
    return exact ? { ref: target, wildcard: false } : undefined;
  }
  if (sourceStar === source.length - 1 && targetStar === target.length - 1) {
    const prefix = source.replace(/\*+$/, '');
    // Git does not match wildcards against short names: only the full ref.
    const full = `${REFS_HEADS}${branch}`;
    if (!full.startsWith(prefix)) return undefined;
    return { ref: target.replace('*', full.slice(prefix.length)), wildcard: true };
  }
  return undefined;
}

/** The ref `branch` is pushed to under `specs`, or `undefined` when none applies. */
export function pushSpecTargetRef(branch: string, specs: readonly string[]): string | undefined {
  let wildcard: string | undefined;
  for (const spec of specs) {
    const target = targetOf(spec, branch);
    if (target === undefined) continue;
    if (!target.wildcard) return target.ref;
    wildcard ??= target.ref;
  }
  return wildcard;
}
