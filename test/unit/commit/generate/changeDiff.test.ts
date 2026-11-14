/**
 * POST-P14cj, Generate Commit Message: `git diff`'s output read into the
 * per-file changes a language model is shown, each kept within its limits.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DIFF_LIMITS,
  DiffReader,
  looksBinary,
  readNewFile,
  type ChangeDiff,
  type DiffLimits,
} from '../../../../src/commit/generate/changeDiff';

function read(lines: readonly string[], limits?: DiffLimits): ChangeDiff[] {
  const reader = new DiffReader(limits);
  for (const line of lines) reader.push(line);
  return reader.finish();
}

const MODIFIED = [
  'diff --git a/src/a.ts b/src/a.ts',
  'index 30a44a5..939d887 100644',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1,4 +1,5 @@',
  ' one',
  '-two',
  '+TWO',
  '+two and a half',
  ' three',
];

describe('DiffReader, a file at a time', () => {
  it('reads a modified file: its path, its counts and its diff as git wrote it', () => {
    expect(read(MODIFIED)).toEqual([
      {
        path: 'src/a.ts',
        status: 'modified',
        added: 2,
        deleted: 1,
        binary: false,
        diff: MODIFIED.join('\n'),
        cutLines: 0,
      },
    ]);
  });

  it('tells an added, a deleted, a renamed and a copied file apart by git’s own header lines', () => {
    const changes = read([
      'diff --git a/new.txt b/new.txt',
      'new file mode 100644',
      'index 0000000..ce01362',
      '--- /dev/null',
      '+++ b/new.txt',
      '@@ -0,0 +1 @@',
      '+hello',
      'diff --git a/gone.txt b/gone.txt',
      'deleted file mode 100644',
      'index b023018..0000000',
      '--- a/gone.txt',
      '+++ /dev/null',
      '@@ -1 +0,0 @@',
      '-bye',
      'diff --git a/old name.txt b/new name.txt',
      'similarity index 100%',
      'rename from old name.txt',
      'rename to new name.txt',
      'diff --git a/a.txt b/b.txt',
      'similarity index 90%',
      'copy from a.txt',
      'copy to b.txt',
    ]);
    expect(changes.map((c) => [c.status, c.path, c.origPath, c.added, c.deleted])).toEqual([
      ['added', 'new.txt', undefined, 1, 0],
      ['deleted', 'gone.txt', undefined, 0, 1],
      ['renamed', 'new name.txt', 'old name.txt', 0, 0],
      ['copied', 'b.txt', 'a.txt', 0, 0],
    ]);
  });

  it('names a binary file and keeps none of its lines', () => {
    const [change] = read([
      'diff --git a/logo.png b/logo.png',
      'index 1111111..2222222 100644',
      'Binary files a/logo.png and b/logo.png differ',
    ]);
    expect(change).toMatchObject({ path: 'logo.png', binary: true, diff: '', added: 0, deleted: 0, cutLines: 0 });
  });

  it('counts a deleted `-- comment` and an added `++ x` as lines, not as file headers', () => {
    // In a hunk, `--- a comment` is the line `-- a comment` deleted.
    const [change] = read([
      'diff --git a/q.sql b/q.sql',
      '--- a/q.sql',
      '+++ b/q.sql',
      '@@ -1,2 +1,2 @@',
      '--- a comment',
      '+++ another',
      ' select 1;',
    ]);
    expect(change).toMatchObject({ path: 'q.sql', added: 1, deleted: 1 });
  });

  it('reads a path with ` b/` in it, which the header line alone cannot say', () => {
    const [change] = read(['diff --git a/x b/y b/x b/y', '--- a/x b/y', '+++ b/x b/y', '@@ -1 +1 @@', '-a', '+b']);
    expect(change).toMatchObject({ path: 'x b/y', status: 'modified' });
    expect(change?.origPath).toBeUndefined();
  });

  it('drops the carriage return of a CRLF file’s lines', () => {
    const [change] = read(['diff --git a/c.txt b/c.txt', '--- a/c.txt', '+++ b/c.txt', '@@ -1 +1 @@', '-old\r', '+new\r']);
    expect(change?.diff.endsWith('-old\n+new')).toBe(true);
  });

  it('ignores what comes before the first file, and reads on after finish()', () => {
    const reader = new DiffReader();
    reader.push('warning: something git said first');
    for (const line of MODIFIED) reader.push(line);
    expect(reader.finish()).toHaveLength(1);
    for (const line of ['diff --git a/z b/z', '--- a/z', '+++ b/z', '@@ -1 +1 @@', '+z']) reader.push(line);
    expect(reader.finish().map((c) => c.path)).toEqual(['src/a.ts', 'z']);
  });

  it('marks the files read after mark(), and no others', () => {
    const reader = new DiffReader();
    for (const line of MODIFIED) reader.push(line);
    reader.mark({ partial: true });
    for (const line of ['diff --git a/p b/p', '--- a/p', '+++ b/p', '@@ -1 +1 @@', '+p']) reader.push(line);
    reader.mark({ amended: true });
    for (const line of ['diff --git a/q b/q', '--- a/q', '+++ b/q', '@@ -1 +1 @@', '+q']) reader.push(line);
    reader.mark({});
    for (const line of ['diff --git a/r b/r', '--- a/r', '+++ b/r', '@@ -1 +1 @@', '+r']) reader.push(line);
    expect(reader.finish().map((c) => [c.path, c.partial, c.amended])).toEqual([
      ['src/a.ts', undefined, undefined],
      ['p', true, undefined],
      ['q', undefined, true],
      ['r', undefined, undefined],
    ]);
  });
});

describe('DiffReader, within its limits', () => {
  const body = (n: number): string[] => [
    'diff --git a/big.json b/big.json',
    '--- a/big.json',
    '+++ b/big.json',
    `@@ -1,${n} +1,${n} @@`,
    ...Array.from({ length: n }, (_, i) => `+line ${i}`),
  ];

  it('keeps a file’s first lines and counts the rest, the added lines still counted in full', () => {
    const [change] = read(body(1000), { ...DEFAULT_DIFF_LIMITS, maxFileLines: 10 });
    expect(change?.diff.split('\n')).toHaveLength(10);
    expect(change?.cutLines).toBe(994);
    expect(change?.added).toBe(1000);
  });

  it('stops at the character limit too, and never keeps a later line once one was cut', () => {
    const [change] = read(body(100), { ...DEFAULT_DIFF_LIMITS, maxFileChars: 80 });
    expect(change!.diff.length).toBeLessThanOrEqual(80);
    expect(change!.cutLines).toBeGreaterThan(90);
    expect(change!.diff.split('\n').length + change!.cutLines).toBe(104);
  });

  it('shortens one very long line instead of dropping it', () => {
    const [change] = read(
      ['diff --git a/min.js b/min.js', '--- a/min.js', '+++ b/min.js', '@@ -1 +1 @@', `+${'x'.repeat(5000)}`],
      { ...DEFAULT_DIFF_LIMITS, maxLineChars: 20 },
    );
    expect(change?.diff.split('\n').at(-1)).toBe(`+${'x'.repeat(19)}…`);
    expect(change?.cutLines).toBe(0);
  });

  it('gives a later file its counts alone once all the files together reach the total', () => {
    const lines = [...body(5), ...body(5).map((l) => l.replaceAll('big.json', 'second.json'))];
    const changes = read(lines, { ...DEFAULT_DIFF_LIMITS, maxTotalChars: 120 });
    expect(changes[0]?.cutLines).toBe(0);
    expect(changes[1]).toMatchObject({ path: 'second.json', added: 5 });
    expect(changes[1]!.cutLines).toBeGreaterThan(0);
  });

  it('has defaults that keep a source file whole and a lock file short', () => {
    expect(DEFAULT_DIFF_LIMITS.maxFileLines).toBeGreaterThanOrEqual(300);
    expect(DEFAULT_DIFF_LIMITS.maxFileChars).toBeLessThanOrEqual(50_000);
    expect(DEFAULT_DIFF_LIMITS.maxTotalChars).toBeGreaterThan(DEFAULT_DIFF_LIMITS.maxFileChars);
  });
});

describe('a file git does not track yet', () => {
  const added = (relPath: string, content: string | undefined): ChangeDiff | undefined => {
    const reader = new DiffReader();
    readNewFile(reader, relPath, content);
    return reader.finish()[0];
  };

  it('is the diff that adds it, as git would write it', () => {
    expect(added('src\\new file.ts', 'hello\nworld\n')).toEqual({
      path: 'src/new file.ts',
      status: 'added',
      added: 2,
      deleted: 0,
      binary: false,
      diff: [
        'diff --git a/src/new file.ts b/src/new file.ts',
        'new file mode 100644',
        '--- /dev/null',
        '+++ b/src/new file.ts',
        '@@ -0,0 +1,2 @@',
        '+hello',
        '+world',
      ].join('\n'),
      cutLines: 0,
    });
  });

  it('says when the file does not end in a line break', () => {
    expect(added('a.txt', 'one')?.diff.endsWith('+one\n\\ No newline at end of file')).toBe(true);
  });

  it('is named with no lines when empty, binary, or not read (too large)', () => {
    expect(added('empty.txt', '')).toMatchObject({ status: 'added', added: 0, binary: false });
    expect(added('bin.dat', 'a\0b')).toMatchObject({ status: 'added', binary: true, diff: '' });
    expect(added('huge.csv', undefined)).toMatchObject({ status: 'added', binary: true, diff: '' });
  });

  it('takes a NUL near the start for binary, as git does', () => {
    expect(looksBinary('plain text')).toBe(false);
    expect(looksBinary('PK\0\0')).toBe(true);
    // Only the first stretch is looked at.
    expect(looksBinary(`${'a'.repeat(9000)}\0`)).toBe(false);
  });
});
