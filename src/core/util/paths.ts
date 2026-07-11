/**
 * Path canonicalization for repo-relative math. Windows can hand us the same
 * file under different spellings (8.3 short names like ADA~1.LOV, drive-letter
 * case, junctions); computing `path.relative(repoRoot, file)` across mixed
 * spellings produces `..\\..` traversals and breaks every rel-path consumer.
 * Both sides are realpath'd (with a nearest-existing-ancestor fallback for
 * deleted files) before comparing.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const cache = new Map<string, string>();

/** Best-effort canonical absolute path; falls back through existing ancestors. */
export function toRealPath(p: string): string {
  const abs = path.resolve(p);
  const cached = cache.get(abs);
  if (cached !== undefined) return cached;
  let result: string;
  try {
    result = fs.realpathSync.native(abs);
  } catch {
    const parent = path.dirname(abs);
    result = parent === abs ? abs : path.join(toRealPath(parent), path.basename(abs));
  }
  if (cache.size > 10_000) cache.clear();
  cache.set(abs, result);
  return result;
}

/**
 * Repo-relative path with forward slashes, or undefined when the file lies
 * outside the repo. Canonicalizes both sides first.
 */
export function repoRelative(repoRoot: string, fsPath: string): string | undefined {
  const rel = path.relative(toRealPath(repoRoot), toRealPath(fsPath));
  if (rel.length === 0 || rel.startsWith('..') || path.isAbsolute(rel)) return undefined;
  return rel.replace(/\\/g, '/');
}
