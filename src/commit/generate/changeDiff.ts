/**
 * A commit's changes, file by file, as a language model is shown them
 * (POST-P14cj, Generate Commit Message). `DiffReader` is fed `git diff`'s
 * output a line at a time and keeps a bounded piece of each file's diff: a
 * ticked lock file of 40,000 lines must cost neither the memory to hold it nor
 * the tokens to send it. What is left out is counted, so the prompt can say so.
 *
 * Pure and free of `vscode` and of git itself, so every case is unit-tested.
 */

export type ChangeStatus = 'added' | 'deleted' | 'modified' | 'renamed' | 'copied';

export interface ChangeDiff {
  /** Repository-relative, with `/`. */
  readonly path: string;
  /** Where it was, when it was renamed or copied. */
  readonly origPath?: string;
  readonly status: ChangeStatus;
  /** Lines added and deleted. Both 0 for a binary file. */
  readonly added: number;
  readonly deleted: number;
  /** Git shows no lines for it. */
  readonly binary: boolean;
  /** The diff as kept: whole, or its first lines when `cutLines` is not 0. Empty for a binary file. */
  readonly diff: string;
  /** How many of the diff's lines were not kept. */
  readonly cutLines: number;
  /** Only some of the file's changes are ticked: this is the ticked part. */
  readonly partial?: boolean;
  /** It is in the commit being amended already, not among the new changes. */
  readonly amended?: boolean;
}

export interface DiffLimits {
  /** The most lines kept of one file's diff. */
  readonly maxFileLines: number;
  /** The most characters kept of one file's diff. */
  readonly maxFileChars: number;
  /** The most characters kept of one line: a minified file is one line of a megabyte. */
  readonly maxLineChars: number;
  /** The most characters kept of all the files together; past it a file keeps its counts alone. */
  readonly maxTotalChars: number;
}

export const DEFAULT_DIFF_LIMITS: DiffLimits = {
  maxFileLines: 600,
  maxFileChars: 30_000,
  maxLineChars: 1_000,
  maxTotalChars: 1_000_000,
};

interface Section {
  path: string;
  origPath: string | undefined;
  status: ChangeStatus;
  added: number;
  deleted: number;
  binary: boolean;
  lines: string[];
  chars: number;
  cutLines: number;
  /** Past the first `@@`: a `---` line is a deleted line from here on, not a header. */
  inHunks: boolean;
}

const HEADER_START = 'diff --git ';

/**
 * The two paths of a `diff --git a/x b/y` line. Unchanged names are the same
 * on both sides, which is how a path with ` b/` in it is told apart; a rename's
 * are read again from its `rename from` and `rename to` lines.
 */
function headerPaths(line: string): { left: string; right: string } | undefined {
  if (!line.startsWith(HEADER_START)) return undefined;
  const rest = line.slice(HEADER_START.length);
  const mid = (rest.length - 1) / 2;
  if (
    Number.isInteger(mid) &&
    rest[mid] === ' ' &&
    rest.startsWith('a/') &&
    rest.startsWith('b/', mid + 1) &&
    rest.slice(2, mid) === rest.slice(mid + 3)
  ) {
    return { left: rest.slice(2, mid), right: rest.slice(2, mid) };
  }
  const m = /^a\/(.*) b\/(.*)$/u.exec(rest);
  return m !== null ? { left: m[1] ?? '', right: m[2] ?? '' } : undefined;
}

/** The path of a `--- a/x` or `+++ b/x` line; undefined for `/dev/null`. */
function sidePath(line: string): string | undefined {
  const rest = line.slice(4);
  if (rest === '/dev/null') return undefined;
  // `a/` and `b/` are git's own prefixes; a tab ends a path with a space in it.
  const cut = rest.indexOf('\t');
  const p = cut === -1 ? rest : rest.slice(0, cut);
  return /^[ab]\//u.test(p) ? p.slice(2) : p;
}

/**
 * Reads unified diffs (`git diff`, or the patch of a partial commit) line by
 * line into `ChangeDiff`s. One reader serves any number of diffs, one after
 * another; `mark` says what the files read from then on are.
 */
export class DiffReader {
  private readonly done: ChangeDiff[] = [];
  private current: Section | undefined;
  private total = 0;
  private marks: Pick<ChangeDiff, 'partial' | 'amended'> = {};

  constructor(private readonly limits: DiffLimits = DEFAULT_DIFF_LIMITS) {}

  /** The files read from here on are a ticked part, or the amended commit's own. */
  mark(marks: Pick<ChangeDiff, 'partial' | 'amended'>): void {
    this.close();
    this.marks = marks;
  }

  /** One line of a diff, without its line break. */
  push(raw: string): void {
    // A CRLF file's lines end in `\r`; git's own lines never do.
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    // Every line of a hunk starts with ` `, `+`, `-` or `\`, so this one is git's own.
    const header = headerPaths(line);
    if (header !== undefined) {
      this.close();
      const { left, right } = header;
      this.current = {
        // Equal on both sides unless renamed, and then `rename to` names it.
        path: right,
        origPath: left !== right ? left : undefined,
        status: 'modified',
        added: 0,
        deleted: 0,
        binary: false,
        lines: [],
        chars: 0,
        cutLines: 0,
        inHunks: false,
      };
      this.keep(line);
      return;
    }
    const s = this.current;
    if (s === undefined) return; // before the first file: nothing of ours
    if (!s.inHunks) {
      if (line.startsWith('@@')) {
        s.inHunks = true;
      } else {
        this.readHeaderLine(s, line);
        this.keep(line);
        return;
      }
    } else if (line.startsWith('+')) {
      s.added++;
    } else if (line.startsWith('-')) {
      s.deleted++;
    }
    this.keep(line);
  }

  private readHeaderLine(s: Section, line: string): void {
    if (line.startsWith('new file mode')) s.status = 'added';
    else if (line.startsWith('deleted file mode')) s.status = 'deleted';
    else if (line.startsWith('rename from ')) {
      s.status = 'renamed';
      s.origPath = line.slice('rename from '.length);
    } else if (line.startsWith('rename to ')) s.path = line.slice('rename to '.length);
    else if (line.startsWith('copy from ')) {
      s.status = 'copied';
      s.origPath = line.slice('copy from '.length);
    } else if (line.startsWith('copy to ')) s.path = line.slice('copy to '.length);
    else if (line.startsWith('Binary files ') || line === 'GIT binary patch') s.binary = true;
    else if (line.startsWith('--- ')) {
      const p = sidePath(line);
      if (p !== undefined && s.status !== 'renamed' && s.status !== 'copied') s.origPath = p !== s.path ? p : undefined;
    } else if (line.startsWith('+++ ')) {
      const p = sidePath(line);
      if (p !== undefined) s.path = p;
    }
  }

  private keep(line: string): void {
    const s = this.current;
    if (s === undefined) return;
    const { maxFileLines, maxFileChars, maxLineChars, maxTotalChars } = this.limits;
    const text = line.length > maxLineChars ? `${line.slice(0, maxLineChars)}…` : line;
    const cost = text.length + 1;
    if (
      s.cutLines > 0 ||
      s.lines.length >= maxFileLines ||
      s.chars + cost > maxFileChars ||
      this.total + cost > maxTotalChars
    ) {
      s.cutLines++;
      return;
    }
    s.lines.push(text);
    s.chars += cost;
    this.total += cost;
  }

  private close(): void {
    const s = this.current;
    this.current = undefined;
    if (s === undefined) return;
    // A rename with nothing changed has no `---`/`+++`; its header named both sides.
    const origPath = s.origPath !== undefined && s.origPath !== s.path ? s.origPath : undefined;
    this.done.push({
      path: s.path,
      ...(origPath !== undefined ? { origPath } : {}),
      status: s.status,
      added: s.binary ? 0 : s.added,
      deleted: s.binary ? 0 : s.deleted,
      binary: s.binary,
      // A binary file's lines say only that it is one, which `binary` says.
      diff: s.binary ? '' : s.lines.join('\n'),
      cutLines: s.binary ? 0 : s.cutLines,
      ...this.marks,
    });
  }

  /** Every file read, in the order read. The reader can be fed again after it. */
  finish(): ChangeDiff[] {
    this.close();
    return [...this.done];
  }
}

/** NUL anywhere in the first stretch is git's own test for a binary file. */
export function looksBinary(text: string): boolean {
  return text.slice(0, 8_000).includes('\0');
}

/**
 * A file git does not track yet, as the diff that adds it: what `git diff`
 * would write once it is added. Read through `reader`, so the same limits hold.
 */
export function readNewFile(reader: DiffReader, relPath: string, content: string | undefined): void {
  const p = relPath.replace(/\\/g, '/');
  reader.push(`diff --git a/${p} b/${p}`);
  reader.push('new file mode 100644');
  if (content === undefined || looksBinary(content)) {
    // Unreadable or too large counts as binary: named, with no lines to show.
    reader.push(`Binary files /dev/null and b/${p} differ`);
    return;
  }
  if (content.length === 0) return;
  const lines = content.split('\n');
  const endsWithBreak = content.endsWith('\n');
  if (endsWithBreak) lines.pop();
  reader.push('--- /dev/null');
  reader.push(`+++ b/${p}`);
  reader.push(`@@ -0,0 +1,${lines.length} @@`);
  for (const line of lines) reader.push(`+${line}`);
  if (!endsWithBreak) reader.push('\\ No newline at end of file');
}
