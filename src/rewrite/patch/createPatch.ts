/**
 * Create Patch (P12-T6, gap analysis §3.9 — previously absent entirely):
 * commits/ranges via `git format-patch` (mailbox format, so `git am` can
 * replay them commit-for-commit, `--binary` so binary content rides along),
 * working-tree selections via a scratch-index diff.
 *
 * Byte safety: executor stdout is utf8-decoded and not byte-safe for
 * `--binary` payloads (the P7-T3 lesson), so git always writes the bytes
 * itself — `format-patch -o <dir>` emits one file per commit which are then
 * concatenated with fs, and the worktree diff goes through `--output=`.
 * Text-returning callers get a latin1 read of those bytes (byte-preserving).
 *
 * The plan named `buildPatch` for worktree selections; that emits
 * zero-context hunks only `apply --unidiff-zero` can read — the same
 * incompatibility P11-T7 hit — so the selection is staged into a scratch
 * index and `git diff --cached HEAD` writes an ordinary patch. Deviation
 * recorded in the phase doc.
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { RepoHandle } from '../../core/core';
import { literalPathspec, literalPathspecs } from '../../core/git/pathspec';

export type CreatePatchSource =
  | { kind: 'commits'; shas: string[] }
  | { kind: 'range'; from: string; to: string }
  | {
      kind: 'worktree';
      wholePaths: readonly string[];
      partials: ReadonlyArray<{ relPath: string; includedText: string }>;
    };

/** Selected commits ordered oldest→newest so the mailbox replays in history order. */
async function orderShas(repo: RepoHandle, shas: readonly string[]): Promise<string[]> {
  if (shas.length <= 1) return [...shas];
  const result = await repo.queue.enqueue({
    label: 'order patch commits',
    kind: 'read',
    run: (git, token) =>
      git.exec(repo.root, ['rev-list', '--topo-order', '--no-walk', ...shas], {
        structured: true,
        noOptionalLocks: true,
        token,
      }),
  });
  return result.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .reverse();
}

/** Creates the patch at `targetFsPath`; git writes every byte itself. */
export async function createPatchToFile(
  repo: RepoHandle,
  source: CreatePatchSource,
  targetFsPath: string,
): Promise<void> {
  fs.mkdirSync(path.dirname(targetFsPath), { recursive: true });
  if (source.kind === 'worktree') {
    await createWorktreePatch(repo, source.wholePaths, source.partials, targetFsPath);
    return;
  }
  const revArgs =
    source.kind === 'commits'
      ? (await orderShas(repo, source.shas)).map((sha) => ['-1', sha] as const)
      : [[`${source.from}..${source.to}`] as const];

  const outDir = path.join(
    repo.dirs.gitDir,
    `geet-format-patch-${crypto.randomBytes(4).toString('hex')}`,
  );
  await repo.queue.enqueue({
    label: 'create patch file',
    kind: 'read',
    run: async (git, token) => {
      try {
        fs.writeFileSync(targetFsPath, '');
        for (const rev of revArgs) {
          fs.mkdirSync(outDir, { recursive: true });
          await git.exec(
            repo.root,
            ['format-patch', '--binary', '--full-index', '-o', outDir, ...rev],
            { token },
          );
          for (const name of fs.readdirSync(outDir).sort()) {
            fs.appendFileSync(targetFsPath, fs.readFileSync(path.join(outDir, name)));
            fs.rmSync(path.join(outDir, name), { force: true });
          }
        }
      } finally {
        fs.rmSync(outDir, { recursive: true, force: true });
      }
    },
  });
}

/** The same patch as text (latin1 — byte-preserving) for clipboard targets. */
export async function createPatchText(repo: RepoHandle, source: CreatePatchSource): Promise<string> {
  const scratch = path.join(
    repo.dirs.gitDir,
    `geet-createpatch-${crypto.randomBytes(4).toString('hex')}.patch`,
  );
  try {
    await createPatchToFile(repo, source, scratch);
    return fs.readFileSync(scratch, 'latin1');
  } finally {
    fs.rmSync(scratch, { force: true });
  }
}

async function createWorktreePatch(
  repo: RepoHandle,
  wholePaths: readonly string[],
  partials: ReadonlyArray<{ relPath: string; includedText: string }>,
  targetFsPath: string,
): Promise<void> {
  const scratchIndex = path.join(
    repo.dirs.gitDir,
    `geet-createpatch-index-${crypto.randomBytes(4).toString('hex')}`,
  );
  await repo.queue.enqueue({
    label: 'create patch from selection',
    kind: 'read',
    run: async (git, token) => {
      const env = { GIT_INDEX_FILE: scratchIndex };
      try {
        await git.exec(repo.root, ['read-tree', 'HEAD'], { env, token });
        if (wholePaths.length > 0) {
          await git.exec(repo.root, ['add', '--', ...literalPathspecs(wholePaths)], { env, token });
        }
        for (const partial of partials) {
          const lsTree = (
            await git.exec(repo.root, ['ls-tree', 'HEAD', '--', literalPathspec(partial.relPath)], {
              structured: true,
              token,
            })
          ).stdout.trim();
          const mode = lsTree.split(' ')[0] ?? '';
          const oid = (
            await git.exec(repo.root, ['hash-object', '-w', '--stdin'], {
              structured: true,
              stdin: partial.includedText,
              token,
            })
          ).stdout.trim();
          await git.exec(
            repo.root,
            [
              'update-index',
              '--cacheinfo',
              `${mode.length > 0 ? mode : '100644'},${oid},${partial.relPath}`,
            ],
            { env, token },
          );
        }
        await git.exec(
          repo.root,
          [
            'diff',
            '--binary',
            '--full-index',
            '--no-renames',
            `--output=${targetFsPath}`,
            '--cached',
            'HEAD',
          ],
          { env, token },
        );
      } finally {
        fs.rmSync(scratchIndex, { force: true });
        fs.rmSync(`${scratchIndex}.lock`, { force: true });
      }
    },
  });
}
