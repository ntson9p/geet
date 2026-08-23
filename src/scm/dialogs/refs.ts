/**
 * The ref list every P13-T3 picker offers (merge onto, rebase onto/from, reset
 * to). Read from the repository model's snapshot rather than a fresh `git
 * for-each-ref`, so a dialog opens at the speed of the already-maintained model.
 */
import type { RepoHandle } from '../../core/core';
import type { DialogRefDto } from '../../shared/protocol';

export function dialogRefs(repo: RepoHandle): DialogRefDto[] {
  const snap = repo.model.snapshot;
  const out: DialogRefDto[] = [];
  for (const ref of snap.refs) {
    const kind = ref.type === 'head' ? 'local' : ref.type === 'remote' ? 'remote' : 'tag';
    if (kind === 'local' && ref.isHead) continue; // merging a branch into itself is not an option
    out.push({ name: ref.name, kind, ...(ref.upstream !== undefined ? { upstream: ref.upstream } : {}) });
  }
  // Locals first, then remotes, then tags — the order the pickers read best in.
  const rank = (r: DialogRefDto): number => (r.kind === 'local' ? 0 : r.kind === 'remote' ? 1 : 2);
  return out.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}

/** The ref a dialog should open on: the upstream when there is one, else the first local. */
export function defaultRef(repo: RepoHandle, refs: readonly DialogRefDto[]): string {
  const upstream = repo.model.snapshot.upstream;
  if (upstream !== undefined && refs.some((r) => r.name === upstream)) return upstream;
  return refs[0]?.name ?? '';
}
