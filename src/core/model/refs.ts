/**
 * Ref helpers layered over the for-each-ref parser DTO.
 */
export type { RefInfo, RefType } from '../git/parsers/refs';
import type { RefInfo } from '../git/parsers/refs';

export interface GroupedRefs {
  locals: RefInfo[];
  remotes: Map<string, RefInfo[]>;
  tags: RefInfo[];
}

export function groupRefs(refs: readonly RefInfo[]): GroupedRefs {
  const locals: RefInfo[] = [];
  const remotes = new Map<string, RefInfo[]>();
  const tags: RefInfo[] = [];
  for (const ref of refs) {
    switch (ref.type) {
      case 'head':
        locals.push(ref);
        break;
      case 'remote': {
        const remote = ref.remote ?? '';
        const list = remotes.get(remote);
        if (list) {
          list.push(ref);
        } else {
          remotes.set(remote, [ref]);
        }
        break;
      }
      case 'tag':
        tags.push(ref);
        break;
    }
  }
  return { locals, remotes, tags };
}

export function findCurrentBranch(refs: readonly RefInfo[]): RefInfo | undefined {
  return refs.find((r) => r.type === 'head' && r.isHead);
}

/** Change-detection equality over the fields the UI renders. */
export function refEquals(a: RefInfo, b: RefInfo): boolean {
  return (
    a.fullName === b.fullName &&
    a.sha === b.sha &&
    a.upstream === b.upstream &&
    a.ahead === b.ahead &&
    a.behind === b.behind &&
    a.upstreamGone === b.upstreamGone &&
    a.isHead === b.isHead
  );
}
