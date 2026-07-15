/**
 * patchParser (named by P7-T5, first consumed by P7-T4): splits a git patch
 * into per-file sections whose raw texts concatenate back to the original
 * byte-for-byte (partial unshelve = keep a subset of sections), and applies
 * a section's hunks to base text in memory (shelf per-file diff preview —
 * no worktree or index is ever touched).
 *
 * Scope: git-generated unified diffs (`git diff` / `--binary`). Binary
 * sections are carried opaquely (isBinary, no hunks). Quoted paths (git
 * quotes non-ASCII only when core.quotepath is on — the executor forces it
 * off) get minimal unquoting for robustness against imported patches.
 */

export interface PatchHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  /** Body lines with their leading marker (' ', '+', '-', '\'). */
  lines: string[];
}

export interface PatchFileSection {
  /** New-side repo-relative path (deleted files: the old path). */
  relPath: string;
  oldPath: string;
  status: 'modified' | 'added' | 'deleted';
  isBinary: boolean;
  /** Full section text incl. headers — sections concatenate to the patch. */
  text: string;
  hunks: PatchHunk[];
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/u;

function unquote(p: string): string {
  if (p.startsWith('"') && p.endsWith('"')) {
    return p.slice(1, -1).replace(/\\([\\"tn])/gu, (_, c: string) =>
      c === 't' ? '\t' : c === 'n' ? '\n' : c,
    );
  }
  return p;
}

function stripPrefix(p: string): string {
  return p.startsWith('a/') || p.startsWith('b/') ? p.slice(2) : p;
}

/** Split into per-file sections; `sections.map(s => s.text).join('')` === input. */
export function splitPatchFiles(patchText: string): PatchFileSection[] {
  // Keep terminators so section texts concatenate losslessly.
  const lines = patchText.split(/(?<=\n)/u);
  const starts: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if ((lines[i] as string).startsWith('diff --git ')) starts.push(i);
  }
  const sections: PatchFileSection[] = [];
  for (let s = 0; s < starts.length; s++) {
    const from = starts[s] as number;
    const to = s + 1 < starts.length ? (starts[s + 1] as number) : lines.length;
    const body = lines.slice(from, to);
    const text = body.join('');

    let status: PatchFileSection['status'] = 'modified';
    let isBinary = false;
    let oldPath = '';
    let newPath = '';
    const hunks: PatchHunk[] = [];
    let current: PatchHunk | undefined;
    for (const rawLine of body) {
      const line = rawLine.endsWith('\n') ? rawLine.slice(0, -1) : rawLine;
      const m = HUNK_RE.exec(line);
      if (m) {
        current = {
          oldStart: Number.parseInt(m[1] as string, 10),
          oldLines: m[2] !== undefined ? Number.parseInt(m[2], 10) : 1,
          newStart: Number.parseInt(m[3] as string, 10),
          newLines: m[4] !== undefined ? Number.parseInt(m[4], 10) : 1,
          lines: [],
        };
        hunks.push(current);
        continue;
      }
      if (current) {
        // Hunk bodies are exactly marker-prefixed lines; anything else (a
        // following section's headers can't occur — split above) ends them.
        if (line.startsWith(' ') || line.startsWith('+') || line.startsWith('-') || line.startsWith('\\') || line === '') {
          current.lines.push(line === '' ? ' ' : line); // editors may strip the lone context space
          continue;
        }
        current = undefined;
      }
      if (line.startsWith('new file mode')) status = 'added';
      else if (line.startsWith('deleted file mode')) status = 'deleted';
      else if (line.startsWith('GIT binary patch') || line.startsWith('Binary files ')) isBinary = true;
      else if (line.startsWith('--- ')) oldPath = stripPrefix(unquote(line.slice(4)));
      else if (line.startsWith('+++ ')) newPath = stripPrefix(unquote(line.slice(4)));
    }
    // Binary sections have no ---/+++; fall back to the diff --git header.
    if (oldPath === '' && newPath === '') {
      const header = (body[0] as string).replace(/\n$/u, '').slice('diff --git '.length);
      const quoted = header.indexOf('" "');
      const mid = header.indexOf(' b/');
      if (quoted >= 0) {
        oldPath = stripPrefix(unquote(header.slice(0, quoted + 1)));
        newPath = stripPrefix(unquote(header.slice(quoted + 2)));
      } else if (mid > 0) {
        oldPath = stripPrefix(unquote(header.slice(0, mid)));
        newPath = stripPrefix(unquote(header.slice(mid + 1)));
      }
    }
    const relPath = newPath === '/dev/null' || newPath === '' ? oldPath : newPath;
    sections.push({
      relPath,
      oldPath: oldPath === '/dev/null' ? relPath : oldPath,
      status,
      isBinary,
      text,
      hunks,
    });
  }
  return sections;
}

/**
 * Reconstruct the NEW side of one file by applying its hunks to the base
 * text in memory. CRLF rides inside line payloads (split on \n only), so
 * mixed/CRLF content stays byte-exact; `\ No newline at end of file` after
 * a '+'/context line controls the new side's final terminator.
 */
export function applyHunks(baseText: string, hunks: readonly PatchHunk[]): string {
  const base = baseText.split('\n');
  const baseHadFinalNl = base.length > 1 && base[base.length - 1] === '';
  if (baseHadFinalNl) base.pop();
  if (base.length === 1 && base[0] === '') base.pop(); // empty file → no lines

  const out: string[] = [];
  let cursor = 0;
  let newNoFinalNl = false;
  let lastFromHunk = false;
  for (const h of hunks) {
    const start = Math.max(0, h.oldStart - 1);
    while (cursor < start && cursor < base.length) out.push(base[cursor++] as string);
    for (let i = 0; i < h.lines.length; i++) {
      const l = h.lines[i] as string;
      const tag = l[0] ?? ' ';
      if (tag === '\\') continue; // handled via lookahead below
      const body = l.slice(1);
      const marksEof = (h.lines[i + 1] ?? '').startsWith('\\');
      if (tag === ' ') {
        out.push(body);
        cursor++;
        lastFromHunk = true;
        if (marksEof) newNoFinalNl = true;
      } else if (tag === '-') {
        cursor++;
      } else if (tag === '+') {
        out.push(body);
        lastFromHunk = true;
        if (marksEof) newNoFinalNl = true;
      }
    }
  }
  const tail = base.length - cursor;
  if (tail > 0) {
    while (cursor < base.length) out.push(base[cursor++] as string);
    lastFromHunk = false;
  }
  if (out.length === 0) return '';
  const finalNl = lastFromHunk ? !newNoFinalNl : baseHadFinalNl;
  return out.join('\n') + (finalNl ? '\n' : '');
}
