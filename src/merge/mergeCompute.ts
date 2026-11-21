/**
 * P6-T2 — merge computation layer: index stages → canonical re-merge →
 * ordered segment model (master §8).
 *
 * The re-merge is regenerated from stages :1/:2/:3 with
 * `git merge-file -p --diff3` so the result is independent of the user's
 * `merge.conflictStyle` and of whatever markers the original merge left in
 * the worktree. Lines are kept WITH their terminators throughout — CRLF
 * content and missing final newlines survive byte-exact, and serialization
 * is plain concatenation.
 *
 * vscode-free on purpose: the heavy unit suite runs under vitest against
 * real git through the same executor the extension uses.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/** Master §8 contract (resultRange is added by T3's decoration tracking). */
export interface ConflictBlock {
  id: number;
  base: string[];
  ours: string[];
  theirs: string[];
  resolution?: 'ours' | 'theirs' | 'both' | 'auto' | 'manual';
  /** Content for 'auto' (wand) and 'manual' (live editor) resolutions. */
  resolvedLines?: string[];
}

export type MergeSegment =
  | { kind: 'common'; lines: string[] }
  | { kind: 'conflict'; block: ConflictBlock };

/** [startLine, endLine) of a block's region inside the assembled result. */
export interface BlockRange {
  blockId: number;
  startLine: number;
  endLine: number;
}

export interface MergeComputation {
  segments: MergeSegment[];
  /** The conflict blocks in order — same objects as in `segments`. */
  blocks: ConflictBlock[];
  /** Common segments verbatim; unresolved conflicts render their BASE text
   *  (IntelliJ parity — unresolved regions show the base). */
  initialText: string;
  /** Line ranges of each block inside `initialText` (pre-edit anchors). */
  initialRanges: BlockRange[];
  stages: { base: string; ours: string; theirs: string };
}

export type MergeInput =
  | { kind: 'text'; merge: MergeComputation }
  | { kind: 'binary' }
  | { kind: 'too-large'; bytes: number };

/** Spec step 1: stages larger than this route to the binary/large QuickPick. */
export const STAGE_SIZE_CAP = 10 * 1024 * 1024;

/** Content lines never collide with 32-char markers (git default is 7). */
const MARKER_SIZE = 32;

/**
 * Split preserving line terminators: "a\r\nb\nc" → ["a\r\n", "b\n", "c"].
 * Concatenating the result reproduces the input byte-exact.
 */
export function splitKeepEol(text: string): string[] {
  if (text.length === 0) return [];
  const lines = text.split('\n');
  const last = lines.pop() as string;
  const out = lines.map((l) => l + '\n');
  if (last.length > 0) out.push(last);
  return out;
}

function isMarker(line: string, ch: '<' | '|' | '=' | '>', size: number): boolean {
  if (line.length < size) return false;
  for (let i = 0; i < size; i++) {
    if (line.charCodeAt(i) !== ch.charCodeAt(0)) return false;
  }
  // Exactly the marker (± label): next char is space or the line ends (\r?\n).
  const rest = line.slice(size);
  return rest === '' || rest === '\n' || rest === '\r\n' || rest.startsWith(' ');
}

/**
 * Parse `git merge-file -p --diff3` output into the ordered segment model.
 * Throws on malformed marker sequences — with a 32-char marker size that
 * indicates a real bug, not user content.
 */
export function parseDiff3(merged: string, markerSize: number = MARKER_SIZE): MergeSegment[] {
  const lines = splitKeepEol(merged);
  const segments: MergeSegment[] = [];
  let common: string[] = [];
  let nextId = 0;

  const flushCommon = (): void => {
    if (common.length > 0) {
      segments.push({ kind: 'common', lines: common });
      common = [];
    }
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i] as string;
    if (!isMarker(line, '<', markerSize)) {
      common.push(line);
      i++;
      continue;
    }
    flushCommon();
    i++; // past <<<<<<<
    const ours: string[] = [];
    const base: string[] = [];
    const theirs: string[] = [];
    while (i < lines.length && !isMarker(lines[i] as string, '|', markerSize)) {
      ours.push(lines[i] as string);
      i++;
    }
    if (i >= lines.length) throw new Error('merge parse: missing ||||||| marker');
    i++; // past |||||||
    while (i < lines.length && !isMarker(lines[i] as string, '=', markerSize)) {
      base.push(lines[i] as string);
      i++;
    }
    if (i >= lines.length) throw new Error('merge parse: missing ======= marker');
    i++; // past =======
    while (i < lines.length && !isMarker(lines[i] as string, '>', markerSize)) {
      theirs.push(lines[i] as string);
      i++;
    }
    if (i >= lines.length) throw new Error('merge parse: missing >>>>>>> marker');
    i++; // past >>>>>>>
    segments.push({ kind: 'conflict', block: { id: nextId++, base, ours, theirs } });
  }
  flushCommon();
  return segments;
}

/** Common verbatim; conflicts render base (red "unresolved" region in T3). */
export function assembleInitialResult(segments: MergeSegment[]): {
  text: string;
  ranges: BlockRange[];
} {
  const parts: string[] = [];
  const ranges: BlockRange[] = [];
  let lineNo = 0;
  for (const seg of segments) {
    const lines = seg.kind === 'common' ? seg.lines : seg.block.base;
    if (seg.kind === 'conflict') {
      ranges.push({ blockId: seg.block.id, startLine: lineNo, endLine: lineNo + lines.length });
    }
    parts.push(...lines);
    lineNo += lines.length;
  }
  return { text: parts.join(''), ranges };
}

/**
 * Segments + per-block resolutions → final text. Unresolved blocks render
 * base (Apply gates on zero unresolved at the T4 level, not here).
 * 'both' = ours then theirs (IntelliJ "Accept Both — yours first").
 */
export function serializeResult(segments: MergeSegment[]): string {
  const parts: string[] = [];
  for (const seg of segments) {
    if (seg.kind === 'common') {
      parts.push(...seg.lines);
      continue;
    }
    const b = seg.block;
    switch (b.resolution) {
      case 'ours':
        parts.push(...b.ours);
        break;
      case 'theirs':
        parts.push(...b.theirs);
        break;
      case 'both':
        parts.push(...b.ours, ...b.theirs);
        break;
      case 'auto':
      case 'manual': {
        if (!b.resolvedLines) {
          throw new Error(`block ${b.id}: '${b.resolution}' resolution without resolvedLines`);
        }
        parts.push(...b.resolvedLines);
        break;
      }
      case undefined:
        parts.push(...b.base);
        break;
    }
  }
  return parts.join('');
}

// ---- stage reading + canonical re-merge -------------------------------------

/**
 * Repo-bound exec seam. Production wraps the repo's OperationQueue reads;
 * unit tests wrap GitExecutorImpl directly. Must resolve (not throw) on
 * non-zero exits — the computer interprets exit codes itself.
 */
export type MergeExec = (args: string[]) => Promise<{
  stdout: string;
  stderr: string;
  exitCode: number;
}>;

export interface MergeComputerOptions {
  /** Byte cap per stage before routing to the too-large QuickPick. */
  sizeCap?: number;
  /** Scratch directory root for merge-file temp files. */
  tmpRoot?: string;
}

export class MergeComputer {
  private readonly sizeCap: number;
  private readonly tmpRoot: string;

  constructor(
    private readonly exec: MergeExec,
    options?: MergeComputerOptions,
  ) {
    this.sizeCap = options?.sizeCap ?? STAGE_SIZE_CAP;
    this.tmpRoot = options?.tmpRoot ?? os.tmpdir();
  }

  /**
   * Compute the merge model for a conflicted path (repo-relative, posix).
   * Classifies binary / too-large inputs instead of merging them.
   *
   * `ours` is the user's side: stage 2, or stage 3 when `reversed` — mid-rebase,
   * where git's stage 2 is the branch being rebased onto (POST-QA F7).
   */
  async compute(rel: string, options: { reversed?: boolean } = {}): Promise<MergeInput> {
    // Size guard first — never pull an oversized blob into memory.
    let maxBytes = 0;
    for (const stage of [1, 2, 3] as const) {
      const size = await this.exec(['cat-file', '-s', `:${stage}:${rel}`]);
      if (size.exitCode === 0) {
        const bytes = Number.parseInt(size.stdout.trim(), 10);
        if (Number.isFinite(bytes)) maxBytes = Math.max(maxBytes, bytes);
      }
    }
    if (maxBytes > this.sizeCap) return { kind: 'too-large', bytes: maxBytes };

    const order = options.reversed === true ? ([1, 3, 2] as const) : ([1, 2, 3] as const);
    const [base, ours, theirs] = await Promise.all(order.map((stage) => this.readStage(rel, stage)));
    if (base === undefined && ours === undefined && theirs === undefined) {
      throw new Error(`${rel}: no index stages — not a conflicted path`);
    }
    for (const content of [base, ours, theirs]) {
      if (content !== undefined && looksBinary(content)) return { kind: 'binary' };
    }

    const merged = await this.mergeFile(base ?? '', ours ?? '', theirs ?? '');
    const segments = parseDiff3(merged);
    const { text, ranges } = assembleInitialResult(segments);
    return {
      kind: 'text',
      merge: {
        segments,
        blocks: segments.flatMap((s) => (s.kind === 'conflict' ? [s.block] : [])),
        initialText: text,
        initialRanges: ranges,
        stages: { base: base ?? '', ours: ours ?? '', theirs: theirs ?? '' },
      },
    };
  }

  /** Missing stage (deleted side, no common ancestor) → undefined. */
  private async readStage(rel: string, stage: 1 | 2 | 3): Promise<string | undefined> {
    const result = await this.exec(['show', `:${stage}:${rel}`]);
    return result.exitCode === 0 ? result.stdout : undefined;
  }

  /**
   * Canonical re-merge on temp files: `--diff3` + a fixed marker size make
   * the output independent of `merge.conflictStyle` and immune to content
   * that contains 7-char marker lines. Exit code = conflict count; >127
   * signals a real error.
   */
  private async mergeFile(base: string, ours: string, theirs: string): Promise<string> {
    const dir = fs.mkdtempSync(path.join(this.tmpRoot, 'geet-merge-'));
    try {
      const oursPath = path.join(dir, 'ours');
      const basePath = path.join(dir, 'base');
      const theirsPath = path.join(dir, 'theirs');
      fs.writeFileSync(oursPath, ours);
      fs.writeFileSync(basePath, base);
      fs.writeFileSync(theirsPath, theirs);
      // --diff3 outranks any parseable merge.conflictstyle config. (A config
      // value this git build can't parse still dies — git validates every
      // config entry it reads, and shadowing via -c does not skip that — but
      // such a setup breaks the user's own merges long before ours.)
      const result = await this.exec([
        'merge-file',
        '-p',
        '--diff3',
        `--marker-size=${MARKER_SIZE}`,
        '-L',
        'ours',
        '-L',
        'base',
        '-L',
        'theirs',
        oursPath,
        basePath,
        theirsPath,
      ]);
      if (result.exitCode > 127 || result.exitCode < 0) {
        throw new Error(`git merge-file failed: ${result.stderr}`);
      }
      return result.stdout;
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
}

/** git's heuristic: a NUL byte in the first 8000 bytes marks binary content. */
export function looksBinary(content: string): boolean {
  const probe = content.slice(0, 8000);
  return probe.includes('\0');
}
