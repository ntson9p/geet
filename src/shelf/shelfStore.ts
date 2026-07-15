/**
 * P7-T3 — Shelf storage engine: IntelliJ-style shelve as `.patch` files that
 * live entirely OUTSIDE `.git` and outside the workspace (survives repo
 * deletion and destructive git surgery). Layout per entry:
 *
 *   <storeDir>/<id>/changes.patch   git binary patch (byte-exact, --output)
 *   <storeDir>/<id>/meta.json       name/comment/base/branch/file table/sha256
 *
 * Capture runs as ONE queued mutation so the `add -N` → diff → `reset` dance
 * for untracked files can never interleave with another index writer (the
 * queue serializes mutations and cancels in-flight readers). The patch is
 * written by git itself (`--output=`) — executor stdout is utf8-decoded and
 * therefore not byte-safe for arbitrary file content.
 *
 * Verify-then-remove invariant: when removal is requested, the fresh patch
 * must `git apply --check --reverse` against the worktree BEFORE anything is
 * touched; the P9 snapshot hook fires before the whole op (superset of the
 * spec's "snapshot before restore"). A failed check keeps the shelve and
 * skips removal.
 *
 * vscode-free (mirrors SnapshotStore): the register layer injects the store
 * dir, the queue and localized progress labels; UI phases (T4/T5) localize
 * errors when surfacing them.
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { OperationQueue } from '../core/ops/operationQueue';
import { Emitter, type Disposable, type Event } from '../core/util/events';
import { SNAPSHOT_LABELS } from '../localHistory/hooks';

export type ShelfFileStatus = 'modified' | 'added' | 'deleted' | 'untracked';

export interface ShelfFileMeta {
  relPath: string;
  status: ShelfFileStatus;
  isBinary: boolean;
}

export interface ShelfMeta {
  id: string;
  name: string;
  comment: string;
  /** Epoch milliseconds. */
  createdAt: number;
  baseSha: string;
  branch: string;
  files: ShelfFileMeta[];
  /** Untracked content rides inside the patch (add -N dance) — no sidecars. */
  untrackedSnapshots: 'embedded';
  /** Integrity: sha256(hex) of changes.patch, checked before unshelve/edit. */
  patchSha256: string;
}

export interface ShelveOptions {
  name: string;
  comment?: string;
  /** Repo-relative pathspec subset; default = every dirty file. */
  paths?: readonly string[];
  /** IntelliJ shelve default: revert the shelved changes from the worktree. */
  removeFromWorktree?: boolean;
}

export interface ShelveResult {
  meta: ShelfMeta;
  removed: boolean;
  /** Set when verify-then-remove failed: the shelve is saved, removal skipped. */
  removalSkippedReason?: string;
}

/** A patch whose bytes no longer match the recorded sha256 (or is missing). */
export class ShelfIntegrityError extends Error {
  constructor(
    readonly shelfId: string,
    message: string,
  ) {
    super(message);
    this.name = 'ShelfIntegrityError';
  }
}

export interface ShelfStoreDeps {
  /** Per-repo directory outside `.git` and outside the workspace. */
  storeDir: string;
  repoRoot: string;
  queue: OperationQueue;
  /** Localized progress label for the capture mutation (register layer). */
  progressLabel?: (name: string) => string;
  trace?: (line: string) => void;
}

const META_FILE = 'meta.json';
const PATCH_FILE = 'changes.patch';

function sha256(bytes: Buffer): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

/**
 * File table from `diff --no-renames --name-status -z` + `--numstat -z` over
 * the same pathspec: numstat's `-\t-` rows flag binaries; an `A` whose path
 * was `??` in status (pre `add -N`) records as `untracked`, not `added`.
 * Exported for unit tests.
 */
export function buildShelfFiles(
  nameStatusZ: string,
  numstatZ: string,
  untracked: ReadonlySet<string>,
): ShelfFileMeta[] {
  const binary = new Set<string>();
  for (const row of numstatZ.split('\0')) {
    if (row.length === 0) continue;
    const parts = row.split('\t');
    const rel = parts[2];
    if (rel !== undefined && (parts[0] === '-' || parts[1] === '-')) binary.add(rel);
  }
  const files: ShelfFileMeta[] = [];
  const fields = nameStatusZ.split('\0');
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const code = fields[i] as string;
    if (code.length === 0) break;
    const rel = fields[i + 1] as string;
    const status: ShelfFileStatus = code.startsWith('A')
      ? untracked.has(rel)
        ? 'untracked'
        : 'added'
      : code.startsWith('D')
        ? 'deleted'
        : 'modified';
    files.push({ relPath: rel, status, isBinary: binary.has(rel) });
  }
  return files;
}

export class ShelfStore implements Disposable {
  private readonly _onDidChange = new Emitter<void>();
  readonly onDidChange: Event<void> = this._onDidChange.event;
  private readonly trace: (line: string) => void;

  constructor(private readonly deps: ShelfStoreDeps) {
    this.trace = deps.trace ?? (() => undefined);
  }

  get storeDir(): string {
    return this.deps.storeDir;
  }

  entryDir(id: string): string {
    return path.join(this.deps.storeDir, id);
  }

  patchPath(id: string): string {
    return path.join(this.entryDir(id), PATCH_FILE);
  }

  /** All committed entries (valid meta.json), newest first. Never throws. */
  list(): ShelfMeta[] {
    let ids: string[];
    try {
      ids = fs.readdirSync(this.deps.storeDir);
    } catch {
      return []; // store not created yet
    }
    const out: ShelfMeta[] = [];
    for (const id of ids) {
      const meta = this.readMeta(id);
      if (meta) out.push(meta);
    }
    return out.sort((a, b) => b.createdAt - a.createdAt);
  }

  get(id: string): ShelfMeta | undefined {
    return this.readMeta(id);
  }

  /** True when changes.patch exists and matches the recorded sha256. */
  verify(id: string): boolean {
    const meta = this.readMeta(id);
    if (!meta) return false;
    try {
      return sha256(fs.readFileSync(this.patchPath(id))) === meta.patchSha256;
    } catch {
      return false;
    }
  }

  /** Patch bytes, integrity-checked — unshelve/edit MUST go through this. */
  readPatch(id: string): Buffer {
    const meta = this.readMeta(id);
    if (!meta) throw new ShelfIntegrityError(id, `shelf entry ${id} has no readable metadata`);
    let bytes: Buffer;
    try {
      bytes = fs.readFileSync(this.patchPath(id));
    } catch (err) {
      throw new ShelfIntegrityError(id, `changes.patch unreadable: ${String(err)}`);
    }
    if (sha256(bytes) !== meta.patchSha256) {
      throw new ShelfIntegrityError(
        id,
        'changes.patch does not match its recorded sha256 — refusing to use it',
      );
    }
    return bytes;
  }

  /** Meta-only rewrite (T4 Rename/Comment). Patch bytes and hash untouched. */
  rename(id: string, name: string, comment?: string): void {
    const meta = this.readMeta(id);
    if (!meta) throw new Error(`shelf entry ${id} not found`);
    meta.name = name;
    if (comment !== undefined) meta.comment = comment;
    this.writeMeta(meta);
    this._onDidChange.fire();
  }

  delete(id: string): void {
    fs.rmSync(this.entryDir(id), { recursive: true, force: true });
    this._onDidChange.fire();
  }

  /** T4 Import Patch…: wrap externally-produced patch bytes with meta. */
  importPatch(
    name: string,
    bytes: Buffer,
    info: { baseSha: string; branch: string; comment?: string },
    files: ShelfFileMeta[],
  ): ShelfMeta {
    const createdAt = Date.now();
    const id = `${new Date(createdAt).toISOString().replace(/[-:T]/gu, '').slice(0, 14)}-${crypto
      .randomBytes(3)
      .toString('hex')}`;
    fs.mkdirSync(this.entryDir(id), { recursive: true });
    fs.writeFileSync(this.patchPath(id), bytes);
    const meta: ShelfMeta = {
      id,
      name,
      comment: info.comment ?? '',
      createdAt,
      baseSha: info.baseSha,
      branch: info.branch,
      files,
      untrackedSnapshots: 'embedded',
      patchSha256: sha256(bytes),
    };
    this.writeMeta(meta);
    this._onDidChange.fire();
    return meta;
  }

  /**
   * T4 edit-patch: after the caller VALIDATED the edited bytes on disk,
   * re-consecrate the entry — new sha256 + refreshed file table.
   */
  updateAfterEdit(id: string, files: ShelfFileMeta[]): void {
    const meta = this.readMeta(id);
    if (!meta) throw new Error(`shelf entry ${id} not found`);
    meta.files = files;
    meta.patchSha256 = sha256(fs.readFileSync(this.patchPath(id)));
    this.writeMeta(meta);
    this._onDidChange.fire();
  }

  /**
   * Capture (and optionally remove) as one queued mutation. Tracked changes:
   * `git diff --binary --full-index HEAD`; untracked join via a temporary
   * `add -N` whose index effect is always reverted (try/finally). Renames are
   * disabled (`--no-renames`) so every entry is a plain add/delete/modify and
   * the meta schema stays flat.
   */
  async shelve(opts: ShelveOptions): Promise<ShelveResult> {
    const name = opts.name.trim();
    if (name.length === 0) throw new Error('shelf name required');
    const remove = opts.removeFromWorktree === true;
    const createdAt = Date.now();
    const id = `${new Date(createdAt).toISOString().replace(/[-:T]/gu, '').slice(0, 14)}-${crypto
      .randomBytes(3)
      .toString('hex')}`;
    const dir = this.entryDir(id);
    const patchFile = this.patchPath(id);
    const pathspec = opts.paths !== undefined && opts.paths.length > 0 ? ['--', ...opts.paths] : [];
    const { repoRoot } = this.deps;

    const result = await this.deps.queue.enqueue<ShelveResult>({
      label: this.deps.progressLabel?.(name) ?? `Shelve: ${name}`,
      kind: 'mutate',
      ...(remove
        ? { isDestructive: true, snapshotLabel: SNAPSHOT_LABELS.shelveWithRemove }
        : {}),
      run: async (git, token) => {
        // 1. Classify BEFORE the add -N dance: untracked list + emptiness guard.
        const st = await git.exec(
          repoRoot,
          ['status', '--porcelain', '-z', '--untracked-files=all', ...pathspec],
          { structured: true, noOptionalLocks: true, token },
        );
        const untracked: string[] = [];
        let sawAny = false;
        const entries = st.stdout.split('\0');
        for (let i = 0; i < entries.length; i++) {
          const entry = entries[i] as string;
          if (entry.length < 4) continue;
          sawAny = true;
          if (entry.startsWith('??')) untracked.push(entry.slice(3));
          if (entry.startsWith('R') || entry.startsWith('C')) i++; // orig path field
        }
        if (!sawAny) throw new Error('nothing to shelve');
        const untrackedSet = new Set(untracked);

        // 2/3. Temporary intent-to-add so untracked content joins the diff;
        // the finally leg restores the index no matter what fails in between.
        let files: ShelfFileMeta[];
        if (untracked.length > 0) await git.exec(repoRoot, ['add', '-N', '--', ...untracked], { token });
        try {
          const names = await git.exec(
            repoRoot,
            ['diff', '--no-renames', '--name-status', '-z', 'HEAD', ...pathspec],
            { structured: true, token },
          );
          const nums = await git.exec(
            repoRoot,
            ['diff', '--no-renames', '--numstat', '-z', 'HEAD', ...pathspec],
            { structured: true, token },
          );
          files = buildShelfFiles(names.stdout, nums.stdout, untrackedSet);
          if (files.length === 0) throw new Error('nothing to shelve');
          fs.mkdirSync(dir, { recursive: true });
          await git.exec(
            repoRoot,
            [
              'diff',
              '--binary',
              '--full-index',
              '--no-renames',
              `--output=${patchFile}`,
              'HEAD',
              ...pathspec,
            ],
            { token },
          );
        } finally {
          if (untracked.length > 0) {
            try {
              await git.exec(repoRoot, ['reset', '-q', '--', ...untracked], { token });
            } catch (err) {
              this.trace(`shelve: index restore (reset -N undo) failed: ${String(err)}`);
            }
          }
        }

        const patchBytes = fs.readFileSync(patchFile);
        if (patchBytes.length === 0) {
          fs.rmSync(dir, { recursive: true, force: true });
          throw new Error('nothing to shelve');
        }
        const baseSha = (
          await git.exec(repoRoot, ['rev-parse', 'HEAD'], { structured: true, token })
        ).stdout.trim();
        const branch = (
          await git.exec(repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD'], { structured: true, token })
        ).stdout.trim();
        const meta: ShelfMeta = {
          id,
          name,
          comment: opts.comment ?? '',
          createdAt,
          baseSha,
          branch,
          files,
          untrackedSnapshots: 'embedded',
          patchSha256: sha256(patchBytes),
        };
        // meta.json lands last — its presence marks the entry committed.
        this.writeMeta(meta);
        this.trace(`shelved "${name}" (${files.length} file(s)) → ${dir}`);

        if (!remove) return { meta, removed: false };

        // 4. Verify-then-remove: the patch must provably re-apply before any
        // worktree byte is touched. (P9 snapshot already fired pre-op.)
        const check = await git.exec(repoRoot, ['apply', '--check', '--reverse', patchFile], {
          structured: true,
          allowNonZeroExit: true,
          token,
        });
        if (check.exitCode !== 0) {
          const reason = check.stderr.split('\n')[0] ?? 'git apply --check --reverse failed';
          this.trace(`shelve "${name}": reverse-apply check failed — removal skipped (${reason})`);
          return { meta, removed: false, removalSkippedReason: reason };
        }
        const restorable = files
          .filter((f) => f.status === 'modified' || f.status === 'deleted')
          .map((f) => f.relPath);
        const added = files
          .filter((f) => f.status === 'added' || f.status === 'untracked')
          .map((f) => f.relPath);
        if (restorable.length > 0) {
          await git.exec(
            repoRoot,
            ['restore', '--source=HEAD', '--worktree', '--staged', '--', ...restorable],
            { token },
          );
        }
        if (added.length > 0) {
          // Not in HEAD: unstage (no-op for untracked), then delete the file.
          await git.exec(repoRoot, ['reset', '-q', '--', ...added], {
            allowNonZeroExit: true,
            token,
          });
          for (const rel of added) fs.rmSync(path.join(repoRoot, rel), { force: true });
        }
        return { meta, removed: true };
      },
    });
    this._onDidChange.fire();
    return result;
  }

  private readMeta(id: string): ShelfMeta | undefined {
    try {
      const raw = JSON.parse(
        fs.readFileSync(path.join(this.entryDir(id), META_FILE), 'utf8'),
      ) as ShelfMeta;
      if (typeof raw.id === 'string' && typeof raw.patchSha256 === 'string' && Array.isArray(raw.files)) {
        return raw;
      }
    } catch {
      // fall through — uncommitted/foreign dir or broken meta
    }
    return undefined;
  }

  private writeMeta(meta: ShelfMeta): void {
    fs.writeFileSync(path.join(this.entryDir(meta.id), META_FILE), JSON.stringify(meta, null, 2));
  }

  dispose(): void {
    this._onDidChange.dispose();
  }
}
