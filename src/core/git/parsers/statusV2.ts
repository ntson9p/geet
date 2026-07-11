/**
 * Parser for `git status --porcelain=v2 -z --branch --untracked-files=all`.
 * Locale-independent by construction; requires `-z` (NUL record terminators,
 * rename source as an extra NUL-separated field).
 */

export interface StatusHeader {
  /** HEAD commit sha; undefined on an unborn branch. */
  oid?: string;
  initial: boolean;
  /** Current branch short name; undefined when detached. */
  head?: string;
  detached: boolean;
  upstream?: string;
  ahead?: number;
  behind?: number;
  /** Upstream configured but its ref no longer exists (no branch.ab emitted). */
  upstreamGone: boolean;
}

export type StatusEntryKind = 'ordinary' | 'renamed' | 'copied' | 'unmerged' | 'untracked' | 'ignored';

export interface UnmergedStages {
  mode1: string;
  mode2: string;
  mode3: string;
  sha1: string;
  sha2: string;
  sha3: string;
}

export interface StatusEntry {
  kind: StatusEntryKind;
  /** Repo-relative path with forward slashes, exactly as git emits it. */
  path: string;
  /** Rename/copy source path. */
  origPath?: string;
  /** Index (staged) status char; '.' when unmodified. For unmerged: first conflict char. */
  x: string;
  /** Worktree status char; '.' when unmodified. */
  y: string;
  submodule: string;
  modeHead?: string;
  modeIndex?: string;
  modeWorktree?: string;
  shaHead?: string;
  shaIndex?: string;
  /** Similarity score for renames/copies (R100 → 100). */
  renameScore?: number;
  stages?: UnmergedStages;
}

export interface StatusResult {
  header: StatusHeader;
  entries: StatusEntry[];
}

const ZERO_OID = /^0+$/;

export function parseStatusV2(output: string): StatusResult {
  const header: StatusHeader = { initial: false, detached: false, upstreamGone: false };
  const entries: StatusEntry[] = [];

  const tokens = output.split('\0');
  let sawUpstream = false;
  let sawAb = false;

  for (let i = 0; i < tokens.length; i++) {
    const record = tokens[i];
    if (record === undefined || record.length === 0) continue;

    if (record.startsWith('# ')) {
      parseHeaderLine(record.slice(2), header, (u) => (sawUpstream = u), () => (sawAb = true));
      continue;
    }

    switch (record.charAt(0)) {
      case '1': {
        const e = parseOrdinary(record);
        if (e) entries.push(e);
        break;
      }
      case '2': {
        // Rename/copy: the source path is the following NUL-separated token.
        const orig = tokens[++i] ?? '';
        const e = parseRenameCopy(record, orig);
        if (e) entries.push(e);
        break;
      }
      case 'u': {
        const e = parseUnmerged(record);
        if (e) entries.push(e);
        break;
      }
      case '?':
        entries.push(untrackedOrIgnored('untracked', record));
        break;
      case '!':
        entries.push(untrackedOrIgnored('ignored', record));
        break;
      default:
        // Unknown record type — forward-compat: skip.
        break;
    }
  }

  header.upstreamGone = sawUpstream && !sawAb;
  return { header, entries };
}

function parseHeaderLine(
  line: string,
  header: StatusHeader,
  setUpstream: (v: boolean) => void,
  setAb: () => void,
): void {
  if (line.startsWith('branch.oid ')) {
    const v = line.slice('branch.oid '.length);
    if (v === '(initial)') {
      header.initial = true;
    } else {
      header.oid = v;
    }
  } else if (line.startsWith('branch.head ')) {
    const v = line.slice('branch.head '.length);
    if (v === '(detached)') {
      header.detached = true;
    } else {
      header.head = v;
    }
  } else if (line.startsWith('branch.upstream ')) {
    header.upstream = line.slice('branch.upstream '.length);
    setUpstream(true);
  } else if (line.startsWith('branch.ab ')) {
    const m = /^branch\.ab \+(\d+) -(\d+)$/.exec(line);
    if (m) {
      header.ahead = Number.parseInt(m[1] as string, 10);
      header.behind = Number.parseInt(m[2] as string, 10);
      setAb();
    }
  }
}

/** `1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>` */
function parseOrdinary(record: string): StatusEntry | undefined {
  const parts = splitN(record, ' ', 8);
  if (parts.length < 9) return undefined;
  const [, xy, sub, mH, mI, mW, hH, hI, path] = parts as [string, string, string, string, string, string, string, string, string];
  return {
    kind: 'ordinary',
    path,
    x: xy[0] ?? '.',
    y: xy[1] ?? '.',
    submodule: sub,
    modeHead: mH,
    modeIndex: mI,
    modeWorktree: mW,
    shaHead: normalizeSha(hH),
    shaIndex: normalizeSha(hI),
  };
}

/** `2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <Xscore> <path>` + NUL + origPath */
function parseRenameCopy(record: string, origPath: string): StatusEntry | undefined {
  const parts = splitN(record, ' ', 9);
  if (parts.length < 10) return undefined;
  const [, xy, sub, mH, mI, mW, hH, hI, score, path] = parts as [string, string, string, string, string, string, string, string, string, string];
  const kind: StatusEntryKind = score.startsWith('C') ? 'copied' : 'renamed';
  return {
    kind,
    path,
    origPath,
    x: xy[0] ?? '.',
    y: xy[1] ?? '.',
    submodule: sub,
    modeHead: mH,
    modeIndex: mI,
    modeWorktree: mW,
    shaHead: normalizeSha(hH),
    shaIndex: normalizeSha(hI),
    renameScore: Number.parseInt(score.slice(1), 10),
  };
}

/** `u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>` */
function parseUnmerged(record: string): StatusEntry | undefined {
  const parts = splitN(record, ' ', 10);
  if (parts.length < 11) return undefined;
  const [, xy, sub, m1, m2, m3, mW, h1, h2, h3, path] = parts as [string, string, string, string, string, string, string, string, string, string, string];
  return {
    kind: 'unmerged',
    path,
    x: xy[0] ?? '.',
    y: xy[1] ?? '.',
    submodule: sub,
    modeWorktree: mW,
    stages: { mode1: m1, mode2: m2, mode3: m3, sha1: h1, sha2: h2, sha3: h3 },
  };
}

function untrackedOrIgnored(kind: 'untracked' | 'ignored', record: string): StatusEntry {
  return {
    kind,
    path: record.slice(2),
    x: '.',
    y: kind === 'untracked' ? '?' : '!',
    submodule: 'N...',
  };
}

/** Splits on `sep` at most `n` times; the remainder (which may contain `sep`) is the last element. */
function splitN(s: string, sep: string, n: number): string[] {
  const out: string[] = [];
  let rest = s;
  for (let i = 0; i < n; i++) {
    const idx = rest.indexOf(sep);
    if (idx === -1) break;
    out.push(rest.slice(0, idx));
    rest = rest.slice(idx + 1);
  }
  out.push(rest);
  return out;
}

function normalizeSha(sha: string): string | undefined {
  return ZERO_OID.test(sha) ? undefined : sha;
}
