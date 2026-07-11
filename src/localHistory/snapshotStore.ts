/**
 * SnapshotStore (P9-T1): git-independent, content-addressed local history.
 * Layout under <globalStorage>/history/<repoKey>/:
 *   blobs/<sha256[0:2]>/<sha256>.gz   gzip'd file contents (dedupe for free)
 *   manifests/<ulid>.json             SnapshotManifest (master §8)
 * Single-writer via an intra-extension mutex; corruption-tolerant reads;
 * GC honors retention-days and size budgets but never drops the most recent
 * snapshot. vscode-free — the phase registration wires settings and paths.
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { ulid } from '../core/util/ulid';

export type SnapshotTrigger = 'operation' | 'task' | 'save' | 'manual';

export interface SnapshotFileEntry {
  relPath: string;
  /** Empty string for metadata-only stubs (file exceeded maxFileSizeKb). */
  blobSha: string;
  mode: number;
  size: number;
  tooLarge?: boolean;
}

export interface SnapshotManifest {
  id: string;
  ts: number;
  label: string;
  trigger: SnapshotTrigger;
  files: SnapshotFileEntry[];
}

export interface SnapshotStoreOptions {
  /** Store root, e.g. <globalStorage>/history/<repoKey>. */
  storeDir: string;
  /** Absolute repo root — snapshot paths are stored repo-relative. */
  repoRoot: string;
  maxFileSizeKb?: number;
  maxSizeMb?: number;
  retentionDays?: number;
  trace?: (line: string) => void;
  /** Clock override for GC tests. */
  now?: () => number;
}

export interface SnapshotFilter {
  /** Only manifests touching this repo-relative path prefix. */
  pathPrefix?: string;
  trigger?: SnapshotTrigger;
}

type PathLike = string | { fsPath: string };

/** Windows MAX_PATH escape hatch — \\?\ prefix for long absolute paths. */
function longPath(p: string): string {
  if (process.platform !== 'win32') return p;
  if (p.length < 248 || p.startsWith('\\\\?\\')) return p;
  return p.startsWith('\\\\') ? `\\\\?\\UNC\\${p.slice(2)}` : `\\\\?\\${p}`;
}

export class SnapshotStore {
  private readonly blobsDir: string;
  private readonly manifestsDir: string;
  private readonly trace: (line: string) => void;
  private readonly now: () => number;
  private mutex: Promise<unknown> = Promise.resolve();

  readonly maxFileSizeKb: number;
  readonly maxSizeMb: number;
  readonly retentionDays: number;

  constructor(private readonly options: SnapshotStoreOptions) {
    this.blobsDir = path.join(options.storeDir, 'blobs');
    this.manifestsDir = path.join(options.storeDir, 'manifests');
    this.maxFileSizeKb = options.maxFileSizeKb ?? 1024;
    this.maxSizeMb = options.maxSizeMb ?? 500;
    this.retentionDays = options.retentionDays ?? 30;
    this.trace = options.trace ?? (() => undefined);
    this.now = options.now ?? (() => Date.now());
  }

  /** Serialized store mutation. */
  private locked<T>(fn: () => Promise<T> | T): Promise<T> {
    const run = this.mutex.then(fn, fn);
    this.mutex = run.catch(() => undefined);
    return run;
  }

  /**
   * Records the current on-disk bytes of `files` (absolute paths or Uris).
   * Missing files are skipped (a delete in flight is not an error); oversized
   * files become metadata-only stubs. Returns the manifest id, or undefined
   * when nothing was recordable.
   */
  snapshot(label: string, trigger: SnapshotTrigger, files: readonly PathLike[]): Promise<string | undefined> {
    return this.locked(() => {
      const entries: SnapshotFileEntry[] = [];
      const capBytes = this.maxFileSizeKb * 1024;
      for (const f of files) {
        const abs = typeof f === 'string' ? f : f.fsPath;
        const rel = path.relative(this.options.repoRoot, abs);
        if (rel.startsWith('..') || path.isAbsolute(rel)) continue; // outside repo
        let stat: fs.Stats;
        try {
          stat = fs.statSync(longPath(abs));
        } catch {
          continue; // vanished — fine
        }
        if (!stat.isFile()) continue;
        const relPath = rel.replace(/\\/g, '/');
        if (stat.size > capBytes) {
          entries.push({ relPath, blobSha: '', mode: stat.mode, size: stat.size, tooLarge: true });
          continue;
        }
        let content: Buffer;
        try {
          content = fs.readFileSync(longPath(abs));
        } catch (err) {
          this.trace(`snapshot: unreadable ${relPath}: ${String(err)}`);
          continue;
        }
        const sha = crypto.createHash('sha256').update(content).digest('hex');
        this.writeBlobIfMissing(sha, content);
        entries.push({ relPath, blobSha: sha, mode: stat.mode, size: stat.size });
      }
      if (entries.length === 0) return undefined;

      const manifest: SnapshotManifest = {
        id: ulid(this.now()),
        ts: this.now(),
        label,
        trigger,
        files: entries,
      };
      fs.mkdirSync(longPath(this.manifestsDir), { recursive: true });
      fs.writeFileSync(
        longPath(path.join(this.manifestsDir, `${manifest.id}.json`)),
        JSON.stringify(manifest),
      );
      this.trace(`snapshot ${manifest.id} "${label}" (${entries.length} files)`);
      return manifest.id;
    });
  }

  private writeBlobIfMissing(sha: string, content: Buffer): void {
    const dir = path.join(this.blobsDir, sha.slice(0, 2));
    const file = path.join(dir, `${sha}.gz`);
    if (fs.existsSync(longPath(file))) return; // dedupe
    fs.mkdirSync(longPath(dir), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
    fs.writeFileSync(longPath(tmp), zlib.gzipSync(content));
    try {
      fs.renameSync(longPath(tmp), longPath(file));
    } catch {
      // Concurrent writer won the race — the tmp file is redundant.
      fs.rmSync(longPath(tmp), { force: true });
    }
  }

  /** Newest first. Corrupt manifests are skipped with a trace line. */
  list(filter?: SnapshotFilter): SnapshotManifest[] {
    let names: string[];
    try {
      names = fs.readdirSync(longPath(this.manifestsDir)).filter((n) => n.endsWith('.json'));
    } catch {
      return [];
    }
    const manifests: SnapshotManifest[] = [];
    for (const name of names) {
      const manifest = this.readManifestFile(path.join(this.manifestsDir, name));
      if (!manifest) continue;
      if (filter?.trigger && manifest.trigger !== filter.trigger) continue;
      if (filter?.pathPrefix !== undefined) {
        const prefix = filter.pathPrefix.replace(/\\/g, '/');
        const touches = manifest.files.some(
          (f) => f.relPath === prefix || f.relPath.startsWith(prefix.length > 0 ? `${prefix}/` : ''),
        );
        if (!touches) continue;
      }
      manifests.push(manifest);
    }
    // ULIDs sort chronologically; newest first.
    return manifests.sort((a, b) => (a.id < b.id ? 1 : -1));
  }

  get(id: string): SnapshotManifest | undefined {
    return this.readManifestFile(path.join(this.manifestsDir, `${id}.json`));
  }

  private readManifestFile(file: string): SnapshotManifest | undefined {
    try {
      const parsed = JSON.parse(fs.readFileSync(longPath(file), 'utf8')) as SnapshotManifest;
      if (typeof parsed.id !== 'string' || !Array.isArray(parsed.files)) throw new Error('shape');
      return parsed;
    } catch (err) {
      if (fs.existsSync(longPath(file))) {
        this.trace(`corrupt manifest skipped: ${path.basename(file)} (${String(err)})`);
      }
      return undefined;
    }
  }

  /** Reads one file's bytes out of a snapshot. */
  read(id: string, relPath: string): Buffer | undefined {
    const manifest = this.get(id);
    const entry = manifest?.files.find((f) => f.relPath === relPath.replace(/\\/g, '/'));
    if (!entry || entry.blobSha.length === 0) return undefined;
    const blob = path.join(this.blobsDir, entry.blobSha.slice(0, 2), `${entry.blobSha}.gz`);
    try {
      return zlib.gunzipSync(fs.readFileSync(longPath(blob)));
    } catch (err) {
      this.trace(`blob read failed for ${id}/${relPath}: ${String(err)}`);
      return undefined;
    }
  }

  delete(id: string): Promise<void> {
    return this.locked(() => {
      fs.rmSync(longPath(path.join(this.manifestsDir, `${id}.json`)), { force: true });
      this.sweepUnreferencedBlobs();
    });
  }

  /**
   * GC (P9-T1 step 4): drop manifests older than retentionDays, then
   * oldest-first until under maxSizeMb; never the most recent snapshot.
   * Blobs swept by refcount from surviving manifests.
   */
  gc(): Promise<{ droppedManifests: number; sweptBlobs: number }> {
    return this.locked(() => {
      const all = this.list(); // newest first
      const keep = new Set(all.map((m) => m.id));
      const cutoff = this.now() - this.retentionDays * 24 * 60 * 60 * 1000;
      let dropped = 0;

      for (const m of all) {
        if (m === all[0]) continue; // never the most recent
        if (m.ts < cutoff) {
          keep.delete(m.id);
          dropped++;
        }
      }

      // Size budget: blobs referenced by surviving manifests, oldest dropped first.
      const budget = this.maxSizeMb * 1024 * 1024;
      let survivors = all.filter((m) => keep.has(m.id));
      let total = this.referencedBlobSize(survivors);
      for (let i = survivors.length - 1; i > 0 && total > budget; i--) {
        const victim = survivors[i] as SnapshotManifest;
        keep.delete(victim.id);
        dropped++;
        survivors = all.filter((m) => keep.has(m.id));
        total = this.referencedBlobSize(survivors);
      }

      for (const m of all) {
        if (!keep.has(m.id)) {
          fs.rmSync(longPath(path.join(this.manifestsDir, `${m.id}.json`)), { force: true });
        }
      }
      const swept = this.sweepUnreferencedBlobs();
      if (dropped > 0 || swept > 0) {
        this.trace(`gc: dropped ${dropped} manifests, swept ${swept} blobs`);
      }
      return { droppedManifests: dropped, sweptBlobs: swept };
    });
  }

  private referencedBlobSize(manifests: readonly SnapshotManifest[]): number {
    const shas = new Set<string>();
    for (const m of manifests) {
      for (const f of m.files) if (f.blobSha.length > 0) shas.add(f.blobSha);
    }
    let total = 0;
    for (const sha of shas) {
      try {
        total += fs.statSync(longPath(path.join(this.blobsDir, sha.slice(0, 2), `${sha}.gz`))).size;
      } catch {
        // missing blob — counts as zero
      }
    }
    return total;
  }

  private sweepUnreferencedBlobs(): number {
    const referenced = new Set<string>();
    for (const m of this.list()) {
      for (const f of m.files) if (f.blobSha.length > 0) referenced.add(f.blobSha);
    }
    let swept = 0;
    let shards: string[];
    try {
      shards = fs.readdirSync(longPath(this.blobsDir));
    } catch {
      return 0;
    }
    for (const shard of shards) {
      const shardDir = path.join(this.blobsDir, shard);
      let blobs: string[];
      try {
        blobs = fs.readdirSync(longPath(shardDir));
      } catch {
        continue;
      }
      for (const blobName of blobs) {
        const sha = blobName.replace(/\.gz$/, '');
        if (!referenced.has(sha)) {
          fs.rmSync(longPath(path.join(shardDir, blobName)), { force: true });
          swept++;
        }
      }
    }
    return swept;
  }

  /** Total bytes in blobs/ (storage-usage display). */
  storageBytes(): number {
    let total = 0;
    let shards: string[];
    try {
      shards = fs.readdirSync(longPath(this.blobsDir));
    } catch {
      return 0;
    }
    for (const shard of shards) {
      const dir = path.join(this.blobsDir, shard);
      try {
        for (const f of fs.readdirSync(longPath(dir))) {
          total += fs.statSync(longPath(path.join(dir, f))).size;
        }
      } catch {
        // shard vanished mid-walk
      }
    }
    return total;
  }
}

/** Filesystem-safe per-repo store key: readable slug + stable hash. */
export function repoStoreKey(canonicalRepoKey: string): string {
  const base = path.basename(canonicalRepoKey).replace(/[^a-zA-Z0-9-_]/g, '_').slice(0, 40) || 'repo';
  const hash = crypto.createHash('sha256').update(canonicalRepoKey).digest('hex').slice(0, 12);
  return `${base}-${hash}`;
}
