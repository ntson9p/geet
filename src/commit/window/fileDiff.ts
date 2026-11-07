/**
 * Commit-window file diffs (P11-T3): the one place that answers "what are this
 * file's changes right now". The preview pane, the `M of N changes` badge and
 * the partial-commit patch builder all call through here, so what the user
 * ticks and what git receives cannot describe different hunks.
 *
 * The base is HEAD, not the index. The changelists paradigm bypasses staging —
 * `git commit --only` commits worktree content regardless of what is staged —
 * so HEAD↔worktree is precisely the change set the commit will produce.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { RepoHandle } from '../../core/core';
import { toBlobEol } from '../../core/patch/eol';
import { computeLineChanges } from '../../core/patch/lineDiff';
import { buildPatch, type LineChange } from '../../core/patch/patchBuilder';

export interface FileDiff {
  readonly relPath: string;
  readonly originalText: string;
  /**
   * The working-tree file on the blob's line endings (`toBlobEol`), so the
   * changes are the ones git sees and a partial commit stores what `git add`
   * would. Anything written back to the working tree from it goes through
   * `withCrlf` when `worktreeCrlf` is set.
   */
  readonly modifiedText: string;
  /** The working tree's CRLF was turned into LF to diff against the blob. */
  readonly worktreeCrlf: boolean;
  readonly changes: LineChange[];
  /**
   * Per-change inclusion is unavailable: the file is binary, or one side is
   * missing (untracked/deleted), where "half a change" has no meaning.
   */
  readonly wholeFileOnly: boolean;
}

/** NUL anywhere is git's own binary heuristic; a patch over it is meaningless. */
function isBinary(text: string): boolean {
  return text.includes('\0');
}

async function readHead(repo: RepoHandle, relPath: string): Promise<string | undefined> {
  const result = await repo.queue.enqueue({
    label: `show HEAD:${relPath}`,
    kind: 'read',
    run: (git, token) =>
      // Spelled out rather than imported from `vdocs/revContentProvider`: that
      // module pulls in `vscode`, and keeping this one free of it is what lets
      // the plan logic below be unit-tested.
      git.exec(repo.root, ['show', `HEAD:${relPath}`], {
        structured: true,
        noOptionalLocks: true,
        allowNonZeroExit: true,
        token,
      }),
  });
  return result.exitCode === 0 ? result.stdout : undefined;
}

async function readWorktree(repo: RepoHandle, relPath: string): Promise<string | undefined> {
  try {
    return await fs.readFile(path.join(repo.root, relPath), 'utf8');
  } catch {
    return undefined; // deleted, or unreadable — treated as "no modified side"
  }
}

/**
 * Reads both sides and diffs them. Never throws: an unreadable side yields a
 * `wholeFileOnly` diff so callers degrade to whole-file inclusion rather than
 * failing a commit.
 */
export async function computeFileDiff(repo: RepoHandle, raw: string): Promise<FileDiff> {
  // git speaks forward slashes on every platform, and so does `buildPatch`.
  const relPath = raw.replace(/\\/g, '/');
  const [head, worktree] = await Promise.all([readHead(repo, relPath), readWorktree(repo, relPath)]);
  const originalText = head ?? '';
  const worktreeText = worktree ?? '';
  const missingSide = head === undefined || worktree === undefined;
  if (missingSide || isBinary(originalText) || isBinary(worktreeText)) {
    return {
      relPath,
      originalText,
      modifiedText: worktreeText,
      worktreeCrlf: false,
      changes: [],
      wholeFileOnly: true,
    };
  }
  const { text: modifiedText, crlf } = toBlobEol(originalText, worktreeText);
  return {
    relPath,
    originalText,
    modifiedText,
    worktreeCrlf: crlf,
    changes: computeLineChanges(originalText, modifiedText),
    wholeFileOnly: false,
  };
}

export interface PartialFile {
  readonly relPath: string;
  /** Unified diff of the included changes, for `git apply --cached`. */
  readonly patch: string;
}

export interface PartialPlan {
  /** Files committed in full — the existing `--only` / `git add` path. */
  readonly wholePaths: string[];
  /** Files committed as a patch of selected changes. */
  readonly partials: PartialFile[];
  /** Ticked files contributing nothing (every change excluded). */
  readonly skipped: string[];
  /**
   * Files whose selection no longer matched their changes and were therefore
   * demoted to whole-file. Surfaced to the user — silently committing more than
   * was ticked would be the worst possible outcome here.
   */
  readonly stale: string[];
}

export interface PartialPlanDeps {
  /** Reads a file's current changes. Injected so the branching is unit-tested. */
  readDiff(relPath: string): Promise<FileDiff>;
  /** Indices to commit, or undefined for the whole file (including stale). */
  resolveIncluded(relPath: string, changes: readonly LineChange[]): number[] | undefined;
  /** Whether a per-change selection exists at all. */
  hasSelection(relPath: string): boolean;
}

/**
 * Splits the ticked paths into whole-file and partial groups. Runs **after** the
 * check pipeline, because a reformat rewrites the file and renumbers every
 * change; anything computed earlier would be stale by exactly the amount that
 * matters.
 */
export async function planPartialCommit(
  relPaths: readonly string[],
  deps: PartialPlanDeps,
): Promise<PartialPlan> {
  const wholePaths: string[] = [];
  const partials: PartialFile[] = [];
  const skipped: string[] = [];
  const stale: string[] = [];

  for (const relPath of relPaths) {
    if (!deps.hasSelection(relPath)) {
      wholePaths.push(relPath);
      continue;
    }
    const diff = await deps.readDiff(relPath);
    if (diff.wholeFileOnly) {
      // Binary, or one side missing. Not a stale selection — this file never
      // had per-change inclusion to lose, so it commits whole without a warning.
      wholePaths.push(relPath);
      continue;
    }
    const included = deps.resolveIncluded(relPath, diff.changes);
    if (included === undefined) {
      // Selection exists but no longer lines up — commit the whole file and say so.
      stale.push(relPath);
      wholePaths.push(relPath);
      continue;
    }
    if (included.length === 0) {
      skipped.push(relPath);
      continue;
    }
    if (included.length === diff.changes.length) {
      wholePaths.push(relPath);
      continue;
    }
    partials.push({
      relPath,
      patch: buildPatch({
        relPath,
        originalText: diff.originalText,
        modifiedText: diff.modifiedText,
        changes: included.map((i) => diff.changes[i] as LineChange),
      }),
    });
  }

  return { wholePaths, partials, skipped, stale };
}
