/**
 * Repo discovery (master P0-T7): maps workspace folders to repository roots
 * via `git rev-parse --show-toplevel` (which walks parents natively), then
 * applies the nested-repo rule: a repo nested inside another discovered repo
 * is dropped unless its root is itself an open workspace folder ("outermost
 * wins unless both open").
 *
 * vscode-free: the rev-parse probe is injected.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface RepoDiscoveryDeps {
  /** Innermost enclosing repo root for a directory, or undefined. */
  getRepoRoot(dir: string): Promise<string | undefined>;
  trace?(line: string): void;
}

/**
 * Canonical comparison key: absolute, forward slashes, case-folded on win32.
 * Existing paths are realpath'd — on Windows this expands 8.3 short names
 * (`ADA~1.LOV`) so they compare equal to git's long-form output.
 */
export function canonicalKey(p: string, platform: NodeJS.Platform = process.platform): string {
  let abs = path.resolve(p);
  try {
    abs = fs.realpathSync.native(abs);
  } catch {
    // Nonexistent path (e.g. a deleted file event) — resolve textually.
  }
  let key = abs.replace(/\\/g, '/');
  if (key.length > 1 && key.endsWith('/')) key = key.slice(0, -1);
  return platform === 'win32' ? key.toLowerCase() : key;
}

export class RepoDiscovery {
  constructor(private readonly deps: RepoDiscoveryDeps) {}

  /**
   * Returns repo roots (native path form) for the given workspace folders,
   * deduplicated and with the nested-repo rule applied.
   */
  async scan(folders: readonly string[]): Promise<string[]> {
    const folderKeys = new Set(folders.map((f) => canonicalKey(f)));
    const rootsByKey = new Map<string, string>();

    for (const folder of folders) {
      let root: string | undefined;
      try {
        root = await this.deps.getRepoRoot(folder);
      } catch (err) {
        this.deps.trace?.(`discovery failed for ${folder}: ${String(err)}`);
      }
      if (!root) continue;
      const normalized = path.normalize(root);
      rootsByKey.set(canonicalKey(normalized), normalized);
    }

    // Nested-repo rule: drop a root nested inside another discovered root
    // unless the nested root is itself an open workspace folder.
    const keep: string[] = [];
    for (const [key, root] of rootsByKey) {
      const nestedInAnother = [...rootsByKey.keys()].some(
        (otherKey) => otherKey !== key && key.startsWith(otherKey + '/'),
      );
      if (nestedInAnother && !folderKeys.has(key)) {
        this.deps.trace?.(`nested repo dropped (outermost wins): ${root}`);
        continue;
      }
      keep.push(root);
    }
    return keep.sort();
  }
}
