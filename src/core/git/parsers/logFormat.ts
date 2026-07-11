/**
 * Log record format (master P0-T3 step 3): NUL-separated fields, \x1e record
 * separator. Streamed through GitExecutor.stream with delimiter '\x1e'.
 */

/** 10 fields: H P an ae at cn ct D s b — record-terminated by \x1e. */
export const LOG_FORMAT = '%H%x00%P%x00%an%x00%ae%x00%at%x00%cn%x00%ct%x00%D%x00%s%x00%b%x1e';
export const LOG_RECORD_SEPARATOR = '\x1e';
const FIELD_COUNT = 10;

export interface Commit {
  sha: string;
  parents: string[];
  authorName: string;
  authorEmail: string;
  /** Unix seconds. */
  authorTime: number;
  committerName: string;
  committerTime: number;
  /** Raw decorations from %D, split on ', ' (e.g. "HEAD -> main", "tag: v1.0", "origin/main"). */
  refs: string[];
  subject: string;
  body: string;
}

/**
 * Parses one \x1e-framed record. Returns undefined for unusable frames
 * (empty trailing frame, or a fragment produced by a body that itself
 * contained the record separator — see parseLogOutput for the repair path).
 */
export function parseLogRecord(frame: string): Commit | undefined {
  // git log appends \n between records; the frame after the separator starts
  // with that newline.
  const cleaned = frame.startsWith('\n') ? frame.slice(1) : frame;
  if (cleaned.length === 0) return undefined;
  const f = cleaned.split('\0');
  if (f.length < FIELD_COUNT) return undefined;
  const sha = f[0] as string;
  if (!/^[0-9a-f]{40,64}$/.test(sha)) return undefined;
  const parents = (f[1] as string).length > 0 ? (f[1] as string).split(' ') : [];
  const decorations = f[7] as string;
  return {
    sha,
    parents,
    authorName: f[2] as string,
    authorEmail: f[3] as string,
    authorTime: Number.parseInt(f[4] as string, 10),
    committerName: f[5] as string,
    committerTime: Number.parseInt(f[6] as string, 10),
    refs: decorations.length > 0 ? decorations.split(', ') : [],
    subject: f[8] as string,
    body: f.slice(9).join('\0').replace(/\n+$/, ''),
  };
}

/**
 * Buffered variant with repair for the pathological case of a commit body
 * containing \x1e: fragments that don't look like a record are re-joined to
 * the previous record's body.
 */
export function parseLogOutput(output: string): Commit[] {
  const commits: Commit[] = [];
  for (const frame of output.split(LOG_RECORD_SEPARATOR)) {
    const commit = parseLogRecord(frame);
    if (commit) {
      commits.push(commit);
    } else if (commits.length > 0 && frame.length > 0 && frame.trim().length > 0) {
      const prev = commits[commits.length - 1] as Commit;
      prev.body = `${prev.body}${LOG_RECORD_SEPARATOR}${frame.replace(/\n+$/, '')}`;
    }
  }
  return commits;
}

export interface Decoration {
  name: string;
  type: 'branch' | 'remote-branch' | 'tag' | 'head';
}

/** Splits a raw %D decoration entry list into typed badges. */
export function parseDecorations(refs: readonly string[]): { headTarget?: string; decorations: Decoration[] } {
  let headTarget: string | undefined;
  const decorations: Decoration[] = [];
  for (const raw of refs) {
    if (raw === 'HEAD') {
      decorations.push({ name: 'HEAD', type: 'head' });
    } else if (raw.startsWith('HEAD -> ')) {
      headTarget = raw.slice('HEAD -> '.length);
      decorations.push({ name: headTarget, type: 'branch' });
    } else if (raw.startsWith('tag: ')) {
      decorations.push({ name: raw.slice('tag: '.length), type: 'tag' });
    } else if (raw.includes('/')) {
      decorations.push({ name: raw, type: 'remote-branch' });
    } else {
      decorations.push({ name: raw, type: 'branch' });
    }
  }
  return { headTarget, decorations };
}
