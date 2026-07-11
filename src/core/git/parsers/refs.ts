/**
 * Parser for `git for-each-ref` over NUL-joined fields (one ref per line).
 * Covers locals, remotes and tags plus HEAD marker, upstream and track info.
 */

/** Field order must match parseForEachRef below. */
export const FOR_EACH_REF_FORMAT =
  '%(refname)%00%(objectname)%00%(objecttype)%00%(upstream:short)%00%(upstream:track)%00%(HEAD)%00%(creatordate:unix)%00%(symref)%00%(subject)';

export const FOR_EACH_REF_PATTERNS = ['refs/heads/**', 'refs/remotes/**', 'refs/tags/**'];

export type RefType = 'head' | 'remote' | 'tag';

export interface RefInfo {
  /** Short name: `main`, `origin/main`, `v1.0`. */
  name: string;
  /** Full name: `refs/heads/main`. */
  fullName: string;
  type: RefType;
  sha: string;
  /** `commit`, or `tag` for annotated tags. */
  objectType: string;
  /** Short upstream name for locals with an upstream. */
  upstream?: string;
  ahead?: number;
  behind?: number;
  upstreamGone?: boolean;
  /** True when HEAD points at this local branch. */
  isHead: boolean;
  /** Unix seconds. */
  creatorDate?: number;
  /** For remote refs: the remote name (`origin`). */
  remote?: string;
  /** Set for symbolic refs such as refs/remotes/origin/HEAD (target full name). */
  symrefTarget?: string;
  subject?: string;
}

export function parseForEachRef(output: string): RefInfo[] {
  const refs: RefInfo[] = [];
  for (const line of output.split('\n')) {
    if (line.length === 0) continue;
    const f = line.split('\0');
    if (f.length < 9) continue;
    const fullName = f[0] as string;
    const sha = f[1] as string;
    const objectType = f[2] as string;
    const upstream = f[3] as string;
    const track = f[4] as string;
    const headMarker = f[5] as string;
    const creator = f[6] as string;
    const symref = f[7] as string;
    const subject = f.slice(8).join('\0'); // subject is last; tolerate stray NULs

    const parsed = classify(fullName);
    if (!parsed) continue;

    const ref: RefInfo = {
      name: parsed.name,
      fullName,
      type: parsed.type,
      sha,
      objectType,
      isHead: headMarker === '*',
      subject: subject.length > 0 ? subject : undefined,
    };
    if (parsed.remote) ref.remote = parsed.remote;
    if (upstream.length > 0) ref.upstream = upstream;
    if (symref.length > 0) ref.symrefTarget = symref;
    const creatorNum = Number.parseInt(creator, 10);
    if (Number.isFinite(creatorNum)) ref.creatorDate = creatorNum;

    if (track === '[gone]') {
      ref.upstreamGone = true;
    } else if (track.length > 0) {
      const ahead = /ahead (\d+)/.exec(track);
      const behind = /behind (\d+)/.exec(track);
      if (ahead) ref.ahead = Number.parseInt(ahead[1] as string, 10);
      if (behind) ref.behind = Number.parseInt(behind[1] as string, 10);
    }
    refs.push(ref);
  }
  return refs;
}

function classify(fullName: string): { type: RefType; name: string; remote?: string } | undefined {
  if (fullName.startsWith('refs/heads/')) {
    return { type: 'head', name: fullName.slice('refs/heads/'.length) };
  }
  if (fullName.startsWith('refs/remotes/')) {
    const name = fullName.slice('refs/remotes/'.length);
    const slash = name.indexOf('/');
    return { type: 'remote', name, remote: slash === -1 ? name : name.slice(0, slash) };
  }
  if (fullName.startsWith('refs/tags/')) {
    return { type: 'tag', name: fullName.slice('refs/tags/'.length) };
  }
  return undefined;
}
