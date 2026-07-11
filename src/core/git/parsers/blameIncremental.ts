/**
 * Streaming state machine for `git blame --incremental --porcelain`-style
 * output (--incremental implies the porcelain header layout, emitted in
 * completion order, cheapest first).
 *
 * Group shape:
 *   <sha> <origLine> <finalLine> <numLines>
 *   author …, author-mail …, author-time …, author-tz …,
 *   committer …, summary …, previous <sha> <path>, boundary   (first time per sha)
 *   filename <path>                                            (terminates the group)
 */

export interface BlameRun {
  sha: string;
  /** 1-based line in the blamed (original) revision. */
  origLine: number;
  /** 1-based line in the final (current) file. */
  finalLine: number;
  /** Number of consecutive lines in this run. */
  count: number;
  author: string;
  authorMail?: string;
  /** Unix seconds. */
  authorTime: number;
  authorTz?: string;
  summary: string;
  previous?: { sha: string; path: string };
  isBoundary: boolean;
  filename: string;
}

interface CommitMeta {
  author: string;
  authorMail?: string;
  authorTime: number;
  authorTz?: string;
  summary: string;
  previous?: { sha: string; path: string };
  isBoundary: boolean;
}

const GROUP_HEAD = /^([0-9a-f]{40,64}) (\d+) (\d+) (\d+)$/;

export interface BlameIncrementalParser {
  /** Feed one LF-framed line; returns a completed run when the group closes. */
  feedLine(line: string): BlameRun | undefined;
}

export function createBlameIncrementalParser(): BlameIncrementalParser {
  const metaBySha = new Map<string, CommitMeta>();
  let current:
    | { sha: string; origLine: number; finalLine: number; count: number; meta: CommitMeta }
    | undefined;

  return {
    feedLine(line: string): BlameRun | undefined {
      const head = GROUP_HEAD.exec(line);
      if (head) {
        const sha = head[1] as string;
        let meta = metaBySha.get(sha);
        if (!meta) {
          meta = { author: '', authorTime: 0, summary: '', isBoundary: false };
          metaBySha.set(sha, meta);
        }
        current = {
          sha,
          origLine: Number.parseInt(head[2] as string, 10),
          finalLine: Number.parseInt(head[3] as string, 10),
          count: Number.parseInt(head[4] as string, 10),
          meta,
        };
        return undefined;
      }
      if (!current) return undefined;

      const sp = line.indexOf(' ');
      const key = sp === -1 ? line : line.slice(0, sp);
      const value = sp === -1 ? '' : line.slice(sp + 1);

      switch (key) {
        case 'author':
          current.meta.author = value;
          break;
        case 'author-mail':
          current.meta.authorMail = stripAngles(value);
          break;
        case 'author-time':
          current.meta.authorTime = Number.parseInt(value, 10);
          break;
        case 'author-tz':
          current.meta.authorTz = value;
          break;
        case 'summary':
          current.meta.summary = value;
          break;
        case 'previous': {
          const s = value.indexOf(' ');
          if (s !== -1) {
            current.meta.previous = { sha: value.slice(0, s), path: value.slice(s + 1) };
          }
          break;
        }
        case 'boundary':
          current.meta.isBoundary = true;
          break;
        case 'filename': {
          const run: BlameRun = {
            sha: current.sha,
            origLine: current.origLine,
            finalLine: current.finalLine,
            count: current.count,
            author: current.meta.author,
            authorTime: current.meta.authorTime,
            summary: current.meta.summary,
            isBoundary: current.meta.isBoundary,
            filename: value,
          };
          if (current.meta.authorMail !== undefined) run.authorMail = current.meta.authorMail;
          if (current.meta.authorTz !== undefined) run.authorTz = current.meta.authorTz;
          if (current.meta.previous !== undefined) run.previous = current.meta.previous;
          current = undefined;
          return run;
        }
        default:
          // committer-*, ignored keys — tolerated for forward compat.
          break;
      }
      return undefined;
    },
  };
}

/** `<foo@bar>` → `foo@bar` */
function stripAngles(s: string): string {
  return s.startsWith('<') && s.endsWith('>') ? s.slice(1, -1) : s;
}

/** Convenience for buffered output (tests, small files). */
export function parseBlameIncremental(output: string): BlameRun[] {
  const parser = createBlameIncrementalParser();
  const runs: BlameRun[] = [];
  for (const line of output.split('\n')) {
    const run = parser.feedLine(line);
    if (run) runs.push(run);
  }
  return runs;
}
