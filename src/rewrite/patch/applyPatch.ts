/**
 * Apply Patch (P12-T6, gap analysis §3.9): mailbox patches (`From <sha>`
 * header) replay through `git am -3` so the original commits — messages,
 * authors — are preserved; plain diffs go through `git apply --3way`.
 *
 * Failure policy: an `am` that stops mid-mailbox is aborted (never leaving a
 * half-applied am session behind) and the SAME file falls back to a
 * content-only `apply --3way`, whose conflicts land as ordinary unmerged
 * entries the P6 conflict flow already owns. `--reject` is never passed, so
 * no `.rej` litter can appear; failed hunks are reported from git's own
 * stderr and `ls-files -u`.
 */
import * as fs from 'node:fs';
import type { RepoHandle } from '../../core/core';
import { splitPatchFiles, type PatchFileSection } from '../../core/patch/patchParser';

export interface ApplyPatchOptions {
  threeWay?: boolean;
  reverse?: boolean;
  /** `-p<n>` strip depth; git's default is 1. */
  pDepth?: number;
  whitespaceFix?: boolean;
  /** Force content-apply even for mailbox patches (the dialog's choice). */
  contentOnly?: boolean;
}

export interface ApplyPatchResult {
  status: 'applied' | 'conflicts' | 'failed';
  /** Repo-relative paths git reported as failing or conflicted. */
  rejected: string[];
  /** True when the mailbox was replayed as commits via `git am`. */
  appliedAsCommits: boolean;
  /** First meaningful git error line for the `failed` status. */
  reason?: string;
}

/** Mailbox detection: format-patch emits `From <40-hex> <date>` per commit. */
export function isMailboxPatch(text: string): boolean {
  return /^From [0-9a-f]{40} /m.test(text);
}

/** Pre-apply summary for the dialog (P13-T4): files + hunk counts. */
export function summarizePatch(text: string): Array<{ relPath: string; hunks: number; status: PatchFileSection['status'] }> {
  return splitPatchFiles(text).map((s) => ({
    relPath: s.relPath,
    hunks: s.hunks.length,
    status: s.status,
  }));
}

function failedPathsFromStderr(stderr: string): string[] {
  const out = new Set<string>();
  for (const m of stderr.matchAll(/error: patch failed: (.+):\d+/g)) {
    const p = m[1];
    if (p !== undefined) out.add(p.trim());
  }
  for (const m of stderr.matchAll(/error: (.+): patch does not apply/g)) {
    const p = m[1];
    if (p !== undefined) out.add(p.trim());
  }
  return [...out];
}

export async function applyPatchFile(
  repo: RepoHandle,
  patchFsPath: string,
  opts: ApplyPatchOptions = {},
): Promise<ApplyPatchResult> {
  const text = fs.readFileSync(patchFsPath, 'latin1');
  const mailbox = isMailboxPatch(text) && opts.contentOnly !== true && opts.reverse !== true;

  return repo.queue.enqueue<ApplyPatchResult>({
    label: mailbox ? 'apply patch (git am)' : 'apply patch',
    kind: 'mutate',
    run: async (git, token) => {
      if (mailbox) {
        const am = await git.exec(repo.root, ['am', '-3', patchFsPath], {
          structured: true,
          allowNonZeroExit: true,
          token,
        });
        if (am.exitCode === 0) {
          return { status: 'applied', rejected: [], appliedAsCommits: true };
        }
        // Never leave a paused am session behind — restore, then degrade to a
        // content-only apply of the same file below.
        await git.exec(repo.root, ['am', '--abort'], { allowNonZeroExit: true, token });
      }

      const args = ['apply'];
      if (opts.threeWay !== false) args.push('--3way');
      if (opts.reverse === true) args.push('--reverse');
      if (opts.pDepth !== undefined) args.push(`-p${opts.pDepth}`);
      if (opts.whitespaceFix === true) args.push('--whitespace=fix');
      args.push(patchFsPath);

      const result = await git.exec(repo.root, args, {
        structured: true,
        allowNonZeroExit: true,
        token,
      });
      if (result.exitCode === 0) {
        return { status: 'applied', rejected: [], appliedAsCommits: false };
      }
      const unmerged = await git.exec(repo.root, ['ls-files', '-u', '-z'], {
        structured: true,
        noOptionalLocks: true,
        token,
      });
      if (unmerged.stdout.length > 0) {
        const conflicted = [
          ...new Set(
            unmerged.stdout
              .split('\0')
              .filter((l) => l.length > 0)
              .map((l) => l.split('\t')[1])
              .filter((p): p is string => p !== undefined && p.length > 0),
          ),
        ];
        return { status: 'conflicts', rejected: conflicted, appliedAsCommits: false };
      }
      const reason =
        result.stderr.split('\n').find((l) => l.trim().length > 0) ?? 'git apply failed';
      return {
        status: 'failed',
        rejected: failedPathsFromStderr(result.stderr),
        appliedAsCommits: false,
        reason,
      };
    },
  });
}
