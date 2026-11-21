/**
 * Repo discovery (master P0-T7): maps workspace folders to repository roots
 * via `git rev-parse --show-toplevel` (which walks parents natively), plus an
 * optional breadth-first walk *below* each folder so that opening one plain
 * directory full of checkouts finds them all.
 *
 * The parent-walk alone cannot see that arrangement: `rev-parse` only ever
 * looks upward, so a folder that merely *contains* repositories resolves to
 * nothing and the window comes up empty. The downward walk is the same shape
 * VS Code's built-in git uses for `git.repositoryScanMaxDepth`, with one
 * difference: candidates are pre-filtered on a `.git` entry (one stat) instead
 * of spawning git for every subdirectory, so the probe count equals the real
 * repository count.
 *
 * The nested-repo rule then applies: a repo nested inside another discovered
 * repo is dropped unless it was found *directly* — the probed directory is
 * itself the root. That covers an open workspace folder and a scan hit alike,
 * and on the no-scan path it is exactly the older "unless both open" rule,
 * because probing an open folder returns that folder iff it is a root.
 *
 * vscode-free: the rev-parse probe and the directory reads are injected.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface RepoDiscoveryDeps {
  /** Innermost enclosing repo root for a directory, or undefined. */
  getRepoRoot: (dir: string) => Promise<string | undefined>;
  /** Subdirectory names of `dir`, or undefined when unreadable. */
  listDirs?: (dir: string) => Promise<readonly string[] | undefined>;
  /** True when `dir` carries a `.git` entry (directory or gitfile). */
  hasGitEntry?: (dir: string) => Promise<boolean>;
  trace?: (line: string) => void;
}

export interface ScanOptions {
  /**
   * Directory levels to search below each workspace folder. `0` disables the
   * downward walk (folders and their parents only); `-1` is unlimited.
   */
  maxDepth?: number;
  /** Folder-name globs never descended into (`*` and `?` supported). */
  ignoredFolders?: readonly string[];
  /** Safety valve: directories visited per scan before the walk gives up. */
  visitLimit?: number;
}

/** Bound on the downward walk so an unlimited depth cannot run away. */
export const SCAN_VISIT_LIMIT = 2000;

/** rev-parse probes run in bounded parallel — one process each. */
const PROBE_CONCURRENCY = 8;

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

/**
 * Matches one folder *name* (never a path) against an ignore pattern.
 * `*` and `?` are the only metacharacters, which is the whole of what folder
 * names need; case-folded on win32 like every other path comparison here.
 */
export function matchesFolderName(
  name: string,
  pattern: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const fold = platform === 'win32';
  const n = fold ? name.toLowerCase() : name;
  const p = fold ? pattern.toLowerCase() : pattern;
  if (!/[*?]/.test(p)) return n === p;
  const rx = new RegExp(
    `^${p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`,
  );
  return rx.test(n);
}

interface Discovered {
  root: string;
  /** The probed directory *was* the root — an open folder, or a scan hit. */
  direct: boolean;
}

export class RepoDiscovery {
  constructor(private readonly deps: RepoDiscoveryDeps) {}

  /**
   * Returns repo roots (native path form) for the given workspace folders,
   * deduplicated and with the nested-repo rule applied.
   */
  async scan(folders: readonly string[], options: ScanOptions = {}): Promise<string[]> {
    const maxDepth = options.maxDepth ?? 0;

    const candidates: string[] = [];
    const seen = new Set<string>();
    const addCandidate = (dir: string): void => {
      const key = canonicalKey(dir);
      if (seen.has(key)) return;
      seen.add(key);
      candidates.push(dir);
    };

    for (const folder of folders) addCandidate(folder);
    if (maxDepth !== 0) {
      for (const hit of await this.walk(folders, options)) addCandidate(hit);
    }

    const rootsByKey = await this.probe(candidates);

    // Nested-repo rule: drop a root nested inside another discovered root
    // unless that root was discovered directly.
    const keep: string[] = [];
    for (const [key, entry] of rootsByKey) {
      const nestedInAnother = [...rootsByKey.keys()].some(
        (otherKey) => otherKey !== key && key.startsWith(otherKey + '/'),
      );
      if (nestedInAnother && !entry.direct) {
        this.deps.trace?.(`nested repo dropped (outermost wins): ${entry.root}`);
        continue;
      }
      keep.push(entry.root);
    }
    return keep.sort();
  }

  /**
   * Breadth-first walk below each folder, yielding the directories that carry
   * a `.git` entry. The folders themselves are already candidates, so only
   * their descendants are reported.
   */
  private async walk(folders: readonly string[], options: ScanOptions): Promise<string[]> {
    const listDirs = this.deps.listDirs ?? defaultListDirs;
    const hasGitEntry = this.deps.hasGitEntry ?? defaultHasGitEntry;
    const maxDepth = options.maxDepth ?? 0;
    const ignored = options.ignoredFolders ?? [];
    const visitLimit = options.visitLimit ?? SCAN_VISIT_LIMIT;

    const hits: string[] = [];
    const queue: Array<{ dir: string; depth: number }> = folders.map((dir) => ({ dir, depth: 0 }));
    let visited = 0;
    let capped = false;

    while (queue.length > 0) {
      const cur = queue.shift();
      if (!cur) break;
      if (visited >= visitLimit) {
        capped = true;
        break;
      }
      visited++;

      if (cur.depth > 0 && (await hasGitEntry(cur.dir))) hits.push(cur.dir);
      if (maxDepth !== -1 && cur.depth >= maxDepth) continue;

      const names = await listDirs(cur.dir);
      if (!names) {
        this.deps.trace?.(`scan: unreadable directory skipped: ${cur.dir}`);
        continue;
      }
      for (const name of names) {
        if (name === '.git') continue;
        if (ignored.some((pattern) => matchesFolderName(name, pattern))) continue;
        queue.push({ dir: path.join(cur.dir, name), depth: cur.depth + 1 });
      }
    }

    if (capped) {
      this.deps.trace?.(
        `scan: stopped after ${visitLimit} directories with ${queue.length} still queued; ` +
          'repositories below that point were not found — lower ' +
          'geet.repositoryScan.maxDepth or extend geet.repositoryScan.ignoredFolders',
      );
    }
    return hits;
  }

  /** Probes candidates in bounded parallel, folding duplicates by root key. */
  private async probe(candidates: readonly string[]): Promise<Map<string, Discovered>> {
    const rootsByKey = new Map<string, Discovered>();
    for (let i = 0; i < candidates.length; i += PROBE_CONCURRENCY) {
      const slice = candidates.slice(i, i + PROBE_CONCURRENCY);
      const results = await Promise.all(
        slice.map(async (dir) => {
          try {
            return { dir, root: await this.deps.getRepoRoot(dir) };
          } catch (err) {
            this.deps.trace?.(`discovery failed for ${dir}: ${String(err)}`);
            return { dir, root: undefined };
          }
        }),
      );
      for (const { dir, root } of results) {
        if (!root) continue;
        const normalized = path.normalize(root);
        const key = canonicalKey(normalized);
        const direct = key === canonicalKey(dir);
        const prev = rootsByKey.get(key);
        rootsByKey.set(key, { root: normalized, direct: direct || (prev?.direct ?? false) });
      }
    }
    return rootsByKey;
  }
}

async function defaultListDirs(dir: string): Promise<readonly string[] | undefined> {
  try {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return undefined;
  }
}

async function defaultHasGitEntry(dir: string): Promise<boolean> {
  try {
    await fs.promises.stat(path.join(dir, '.git'));
    return true;
  } catch {
    return false;
  }
}
