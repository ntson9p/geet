/**
 * P7-T5 — Unshelve engine. Applies a shelf entry (whole or a file subset) to
 * the working tree with IntelliJ's escalation ladder:
 *
 *   1. `git apply --index`         — clean fast path (atomic: touches nothing
 *                                    on failure);
 *   2. `git apply --3way`          — content merge against the `--full-index`
 *                                    blobs the shelve recorded; conflicts stay
 *                                    staged and a P6 session (source
 *                                    `'unshelve'`) takes over;
 *   3. neither applies (blobs GC'd after repo surgery, base gone) — a
 *      `.rej`-free failure the UI answers with an "Export Patch…" escape
 *      hatch. The worktree is never left half-patched.
 *
 * Partial unshelve rides the patchParser section split: the chosen sections
 * are applied from a temp patch and, on success, `finalize()` prunes them out
 * of `changes.patch` (remaining files stay shelved) or deletes the entry when
 * nothing remains. Patch bytes are decoded latin1 — a byte-preserving decode,
 * so re-encoded section slices are byte-identical even for non-UTF-8 content.
 *
 * Applied paths are read back from `git apply --numstat -z` on the very patch
 * we hand to git: real unquoted paths (unicode-safe), no octal-unescaping of
 * diff headers on our side.
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { RepoHandle } from '../core/core';
import { splitPatchFiles, type PatchFileSection } from '../core/patch/patchParser';
import { SNAPSHOT_LABELS } from '../localHistory/hooks';
import type { ConflictSource } from '../merge/conflictSession';
import type { ShelfFileMeta, ShelfMeta, ShelfStore } from './shelfStore';

export type UnshelveResult =
  | { status: 'clean'; relPaths: string[] }
  | { status: 'conflicts'; relPaths: string[] }
  | { status: 'failed'; reason: string };

export interface UnshelveOptions {
  /** Indexes into `sectionsOf()` order; undefined = the whole patch. */
  sectionIndexes?: readonly number[];
  /**
   * Delete (full) or prune (partial) the entry after a CLEAN apply — the
   * conflicts path always keeps the entry; the caller re-runs `finalize()`
   * once the P6 session completes. Default true (IntelliJ default).
   */
  deleteAfter?: boolean;
  /** Changelists paradigm: unstage the applied paths after a clean apply. */
  unstageAfterApply?: boolean;
}

export class UnshelveEngine {
  constructor(
    private readonly repo: RepoHandle,
    private readonly store: ShelfStore,
    /** P6-T7 producer seam — classifies the session a conflicted apply drops. */
    private readonly expectConflict: (repoRoot: string, source: ConflictSource) => void,
    private readonly trace: (line: string) => void = () => undefined,
  ) {}

  /** Integrity-checked section split (throws ShelfIntegrityError). */
  sectionsOf(meta: ShelfMeta): PatchFileSection[] {
    return splitPatchFiles(this.store.readPatch(meta.id).toString('latin1'));
  }

  /** True when the shelf base is NOT an ancestor of HEAD (drift note). */
  async baseDrifted(meta: ShelfMeta): Promise<boolean> {
    const res = await this.repo.queue.enqueue({
      label: vscode.l10n.t('Unshelve: base check'),
      kind: 'read',
      run: (git, token) =>
        git.exec(this.repo.root, ['merge-base', '--is-ancestor', meta.baseSha, 'HEAD'], {
          structured: true,
          allowNonZeroExit: true,
          token,
        }),
    });
    return res.exitCode !== 0;
  }

  async unshelve(meta: ShelfMeta, opts: UnshelveOptions = {}): Promise<UnshelveResult> {
    const all = this.sectionsOf(meta); // readPatch integrity gate throws here
    const chosen =
      opts.sectionIndexes === undefined
        ? all
        : opts.sectionIndexes
            .map((i) => all[i])
            .filter((s): s is PatchFileSection => s !== undefined);
    if (chosen.length === 0) return { status: 'failed', reason: 'nothing to unshelve' };

    const tmp = path.join(
      os.tmpdir(),
      `gittree-unshelve-${process.pid}-${crypto.randomBytes(4).toString('hex')}.patch`,
    );
    fs.writeFileSync(tmp, Buffer.from(chosen.map((s) => s.text).join(''), 'latin1'));
    try {
      // Real (unquoted) paths straight from git's own parse of the patch.
      const numstat = await this.repo.queue.enqueue({
        label: vscode.l10n.t('Unshelve: read patch paths'),
        kind: 'read',
        run: (git, token) =>
          git.exec(this.repo.root, ['apply', '--numstat', '-z', tmp], {
            structured: true,
            token,
          }),
      });
      const relPaths = numstat.stdout
        .split('\0')
        .filter((row) => row.length > 0)
        .map((row) => row.split('\t')[2])
        .filter((p): p is string => p !== undefined && p.length > 0);

      const outcome = await this.repo.queue.enqueue<
        { kind: 'clean' } | { kind: 'conflicts' } | { kind: 'failed'; reason: string }
      >({
        label: vscode.l10n.t('Unshelve: {0}', meta.name),
        kind: 'mutate',
        isDestructive: true,
        snapshotLabel:
          opts.deleteAfter === false ? SNAPSHOT_LABELS.unshelve : SNAPSHOT_LABELS.unshelveWithRemove,
        run: async (git, token) => {
          const unstage = async (): Promise<void> => {
            if (opts.unstageAfterApply === true && relPaths.length > 0) {
              // Changelists bypass the index — return the files to plain
              // worktree modifications the lists can own (P5-T3 precedent).
              await git.exec(this.repo.root, ['reset', '-q', '--', ...relPaths], { token });
            }
          };
          const clean = await git.exec(this.repo.root, ['apply', '--index', tmp], {
            structured: true,
            allowNonZeroExit: true,
            token,
          });
          if (clean.exitCode === 0) {
            await unstage();
            return { kind: 'clean' };
          }
          this.trace(`apply --index failed (${clean.exitCode}) — retrying --3way`);
          const three = await git.exec(this.repo.root, ['apply', '--3way', tmp], {
            structured: true,
            allowNonZeroExit: true,
            token,
          });
          if (three.exitCode === 0) {
            await unstage();
            return { kind: 'clean' };
          }
          const unmerged = await git.exec(this.repo.root, ['ls-files', '-u', '-z'], {
            structured: true,
            token,
          });
          if (unmerged.stdout.length > 0) return { kind: 'conflicts' };
          const reason =
            three.stderr.split('\n').find((l) => l.length > 0) ??
            clean.stderr.split('\n').find((l) => l.length > 0) ??
            'git apply failed';
          return { kind: 'failed', reason };
        },
      });

      if (outcome.kind === 'clean') {
        if (opts.deleteAfter !== false) this.finalize(meta.id, opts.sectionIndexes);
        await this.repo.refresher.refreshNow();
        return { status: 'clean', relPaths };
      }
      if (outcome.kind === 'conflicts') {
        // Producer hint BEFORE the refresh that creates the session (P6-T7).
        this.expectConflict(this.repo.root, 'unshelve');
        await this.repo.refresher.refreshNow();
        return { status: 'conflicts', relPaths };
      }
      return { status: 'failed', reason: outcome.reason };
    } finally {
      try {
        fs.rmSync(tmp, { force: true });
      } catch {
        // temp patch — best effort
      }
    }
  }

  /**
   * Remove the applied sections from the entry: full unshelve deletes it,
   * partial rewrites `changes.patch` to the remaining sections and
   * re-consecrates the meta (statuses inherited from the old file table where
   * the path still matches — keeps `untracked` distinct from `added`).
   * Deferred to conflict-session completion by the register layer. No-ops
   * when the entry is already gone.
   */
  finalize(id: string, sectionIndexes?: readonly number[]): void {
    const meta = this.store.get(id);
    if (!meta) return;
    if (sectionIndexes === undefined) {
      this.store.delete(id);
      return;
    }
    const applied = new Set(sectionIndexes);
    const remaining = this.sectionsOf(meta).filter((_, i) => !applied.has(i));
    if (remaining.length === 0) {
      this.store.delete(id);
      return;
    }
    fs.writeFileSync(
      this.store.patchPath(id),
      Buffer.from(remaining.map((s) => s.text).join(''), 'latin1'),
    );
    const files: ShelfFileMeta[] = remaining.map((s) => {
      const prior = meta.files.find((f) => f.relPath === s.relPath);
      return prior ?? { relPath: s.relPath, status: s.status, isBinary: s.isBinary };
    });
    this.store.updateAfterEdit(id, files);
  }
}
