/**
 * Stable per-repo identity for global-state keys (favorites, message
 * history): the origin remote URL hashed — survives re-clones — falling back
 * to the repo root path.
 */
import * as crypto from 'node:crypto';
import type { RepoHandle } from '../core';

const cache = new Map<string, string>();

export async function repoIdentityHash(repo: RepoHandle): Promise<string> {
  const cached = cache.get(repo.root);
  if (cached !== undefined) return cached;
  const result = await repo.queue.enqueue({
    label: 'read remote url',
    kind: 'read',
    run: (git, token) =>
      git.exec(repo.root, ['config', '--get', 'remote.origin.url'], {
        structured: true,
        noOptionalLocks: true,
        allowNonZeroExit: true,
        token,
      }),
  });
  const identity =
    result.exitCode === 0 && result.stdout.trim().length > 0 ? result.stdout.trim() : repo.root;
  const hash = crypto.createHash('sha256').update(identity).digest('hex').slice(0, 16);
  cache.set(repo.root, hash);
  return hash;
}
