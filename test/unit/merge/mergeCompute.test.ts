/**
 * P6-T2 acceptance — marker parser vs merge.conflictStyle variants, CRLF
 * triples, BOF/EOF conflicts, adjacent conflicts, empty-side conflicts,
 * binary/too-large classification, serializer invariants. Real git via the
 * production executor; stages seeded through update-index --index-info so
 * every triple (including missing stages) is constructed precisely.
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createGitExecutor } from '../../../src/core/git/executor';
import {
  assembleInitialResult,
  MergeComputer,
  parseDiff3,
  serializeResult,
  splitKeepEol,
  type MergeComputation,
  type MergeExec,
} from '../../../src/merge/mergeCompute';

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

function realRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'geet-mergecompute-'));
  cleanups.push(() => {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      /* tmp */
    }
  });
  execFileSync('git', ['init'], { cwd: dir, encoding: 'utf8' });
  return dir;
}

interface Triple {
  base?: string;
  ours?: string;
  theirs?: string;
}

/** Seed exact index stages for a path (omitted side = missing stage). */
function stageConflict(dir: string, rel: string, t: Triple): void {
  const hash = (content: string): string =>
    execFileSync('git', ['hash-object', '-w', '--stdin'], {
      cwd: dir,
      input: content,
      encoding: 'utf8',
    }).trim();
  const lines: string[] = [];
  if (t.base !== undefined) lines.push(`100644 ${hash(t.base)} 1\t${rel}`);
  if (t.ours !== undefined) lines.push(`100644 ${hash(t.ours)} 2\t${rel}`);
  if (t.theirs !== undefined) lines.push(`100644 ${hash(t.theirs)} 3\t${rel}`);
  execFileSync('git', ['update-index', '--index-info'], {
    cwd: dir,
    input: lines.join('\n') + '\n',
    encoding: 'utf8',
  });
}

async function makeExec(dir: string): Promise<MergeExec> {
  const git = await createGitExecutor({});
  if (!git) throw new Error('git not found');
  return (args) =>
    git.exec(dir, args, { structured: true, noOptionalLocks: true, allowNonZeroExit: true });
}

async function computeText(dir: string, rel: string, opts?: { sizeCap?: number }): Promise<MergeComputation> {
  const computer = new MergeComputer(await makeExec(dir), opts);
  const input = await computer.compute(rel);
  if (input.kind !== 'text') throw new Error(`expected text, got ${input.kind}`);
  return input.merge;
}

function resolveAll(m: MergeComputation, res: 'ours' | 'theirs'): string {
  for (const b of m.blocks) b.resolution = res;
  const text = serializeResult(m.segments);
  for (const b of m.blocks) b.resolution = undefined;
  return text;
}

const chomp = (s: string): string => (s.endsWith('\n') ? s.slice(0, -1) : s);

describe('splitKeepEol', () => {
  it('preserves terminators byte-exact', () => {
    expect(splitKeepEol('')).toEqual([]);
    expect(splitKeepEol('a')).toEqual(['a']);
    expect(splitKeepEol('a\n')).toEqual(['a\n']);
    expect(splitKeepEol('a\r\nb\nc')).toEqual(['a\r\n', 'b\n', 'c']);
    for (const s of ['x', 'x\n', 'a\r\nb', 'a\nb\r\n', '\n', '\r\n']) {
      expect(splitKeepEol(s).join('')).toBe(s);
    }
  });
});

describe('parseDiff3 (pure)', () => {
  it('throws on malformed marker sequences', () => {
    const m = '<'.repeat(32);
    expect(() => parseDiff3(`${m} ours\nx\n`)).toThrow(/\|{7}/);
    expect(() => parseDiff3(`${m}\nx\n${'|'.repeat(32)}\nb\n`)).toThrow(/={7}/);
    expect(() => parseDiff3(`${m}\nx\n${'|'.repeat(32)}\nb\n${'='.repeat(32)}\nt\n`)).toThrow(/>{7}/);
  });

  it('handles a conflict with all-empty sides between commons', () => {
    const text = `a\n${'<'.repeat(32)} ours\n${'|'.repeat(32)} base\n${'='.repeat(32)}\n${'>'.repeat(32)} theirs\nz\n`;
    const segs = parseDiff3(text);
    expect(segs).toHaveLength(3);
    const mid = segs[1]!;
    const block = mid.kind === 'conflict' ? mid.block : undefined;
    expect(block).toBeDefined();
    expect(block!.ours).toEqual([]);
    expect(block!.base).toEqual([]);
    expect(block!.theirs).toEqual([]);
  });
});

describe('MergeComputer against real git', () => {
  it('classic both-modified: segment structure, base-rendered initial text, ranges', async () => {
    const dir = realRepo();
    stageConflict(dir, 'f.txt', {
      base: 'a\nb\nc\n',
      ours: 'a\nB-ours\nc\n',
      theirs: 'a\nB-theirs\nc\n',
    });
    const m = await computeText(dir, 'f.txt');
    expect(m.blocks).toHaveLength(1);
    expect(m.blocks[0]!.base).toEqual(['b\n']);
    expect(m.blocks[0]!.ours).toEqual(['B-ours\n']);
    expect(m.blocks[0]!.theirs).toEqual(['B-theirs\n']);
    expect(m.initialText).toBe('a\nb\nc\n');
    expect(m.initialRanges).toEqual([{ blockId: m.blocks[0]!.id, startLine: 1, endLine: 2 }]);
  });

  it('output is independent of merge.conflictStyle (merge / diff3 / zdiff3)', async () => {
    const dir = realRepo();
    stageConflict(dir, 'style.txt', {
      base: 'one\ntwo\nthree\nfour\n',
      ours: 'one\nTWO\nthree\nfour\n',
      theirs: 'one\ntwo-x\nthree\nFOUR\n',
    });
    // Styles this git build can parse (zdiff3 needs git >= 2.35 — an unknown
    // value dies during config validation, breaking every merge command).
    const styles = ['merge', 'diff3'];
    try {
      const probe = path.join(dir, 'probe.txt');
      fs.writeFileSync(probe, 'x\n');
      execFileSync('git', ['-c', 'merge.conflictstyle=zdiff3', 'merge-file', '-p', probe, probe, probe], {
        cwd: dir,
        encoding: 'utf8',
      });
      styles.push('zdiff3');
    } catch {
      // git < 2.35
    }
    const variants: MergeComputation[] = [];
    for (const style of styles) {
      execFileSync('git', ['config', 'merge.conflictstyle', style], { cwd: dir });
      variants.push(await computeText(dir, 'style.txt'));
    }
    expect(styles.length).toBeGreaterThanOrEqual(2);
    for (const v of variants.slice(1)) {
      expect(v.segments).toEqual(variants[0]!.segments);
    }
  });

  it('CRLF triple round-trips byte-exact; resolve-all-ours equals stage 2 exactly', async () => {
    const dir = realRepo();
    const base = 'a\r\nb\r\nc\r\n';
    const ours = 'a\r\nB!\r\nc\r\n';
    const theirs = 'a\r\nb??\r\nc\r\n';
    stageConflict(dir, 'crlf.txt', { base, ours, theirs });
    const m = await computeText(dir, 'crlf.txt');
    expect(m.initialText).toBe(base);
    expect(resolveAll(m, 'ours')).toBe(ours);
    expect(resolveAll(m, 'theirs')).toBe(theirs);
  });

  it('conflicts at BOF and EOF parse and reconstruct', async () => {
    const dir = realRepo();
    stageConflict(dir, 'bofeof.txt', {
      base: 'first\nmid\nlast\n',
      ours: 'FIRST-o\nmid\nLAST-o\n',
      theirs: 'FIRST-t\nmid\nLAST-t\n',
    });
    const m = await computeText(dir, 'bofeof.txt');
    expect(m.blocks).toHaveLength(2);
    expect(m.initialRanges[0]!.startLine).toBe(0);
    expect(resolveAll(m, 'ours')).toBe('FIRST-o\nmid\nLAST-o\n');
    expect(resolveAll(m, 'theirs')).toBe('FIRST-t\nmid\nLAST-t\n');
  });

  it('adjacent conflicts separated by one common line stay distinct blocks', async () => {
    const dir = realRepo();
    stageConflict(dir, 'adj.txt', {
      base: 'a\nb\nc\nd\ne\n',
      ours: 'a\nB1\nc\nD1\ne\n',
      theirs: 'a\nB2\nc\nD2\ne\n',
    });
    const m = await computeText(dir, 'adj.txt');
    expect(m.blocks).toHaveLength(2);
    expect(resolveAll(m, 'ours')).toBe('a\nB1\nc\nD1\ne\n');
    expect(resolveAll(m, 'theirs')).toBe('a\nB2\nc\nD2\ne\n');
  });

  it('empty-side conflicts: our deletion vs their edit', async () => {
    const dir = realRepo();
    stageConflict(dir, 'del.txt', {
      base: 'a\nb\nc\n',
      ours: 'a\nc\n',
      theirs: 'a\nB!\nc\n',
    });
    const m = await computeText(dir, 'del.txt');
    expect(m.blocks).toHaveLength(1);
    expect(m.blocks[0]!.ours).toEqual([]);
    expect(resolveAll(m, 'ours')).toBe('a\nc\n');
    expect(resolveAll(m, 'theirs')).toBe('a\nB!\nc\n');
  });

  it('added-by-both (no base stage): empty base side, both reconstructions hold', async () => {
    const dir = realRepo();
    stageConflict(dir, 'added.txt', { ours: 'mine\n', theirs: 'yours\n' });
    const m = await computeText(dir, 'added.txt');
    expect(m.blocks).toHaveLength(1);
    expect(m.blocks[0]!.base).toEqual([]);
    expect(m.stages.base).toBe('');
    expect(resolveAll(m, 'ours')).toBe('mine\n');
    expect(resolveAll(m, 'theirs')).toBe('yours\n');
  });

  it('missing trailing newline reconstructs modulo the final EOL', async () => {
    const dir = realRepo();
    const ours = 'a\nOURS-no-eol';
    stageConflict(dir, 'noeol.txt', { base: 'a\nz\n', ours, theirs: 'a\nTHEIRS\n' });
    const m = await computeText(dir, 'noeol.txt');
    expect(chomp(resolveAll(m, 'ours'))).toBe(chomp(ours));
    expect(chomp(resolveAll(m, 'theirs'))).toBe(chomp('a\nTHEIRS\n'));
  });

  it('content containing 7-char conflict markers does not confuse the parser', async () => {
    const dir = realRepo();
    const marker = '<<<<<<< not a real marker\n======= nor this\n>>>>>>> nope\n';
    stageConflict(dir, 'markers.txt', {
      base: `start\n${marker}end\n`,
      ours: `start!\n${marker}end\n`,
      theirs: `start?\n${marker}end\n`,
    });
    const m = await computeText(dir, 'markers.txt');
    expect(m.blocks).toHaveLength(1);
    expect(resolveAll(m, 'ours')).toBe(`start!\n${marker}end\n`);
    expect(resolveAll(m, 'theirs')).toBe(`start?\n${marker}end\n`);
  });

  it('clean re-merge (non-overlapping edits) yields zero blocks and the woven text', async () => {
    const dir = realRepo();
    stageConflict(dir, 'clean.txt', {
      base: 'a\nb\nc\nd\n',
      ours: 'A!\nb\nc\nd\n',
      theirs: 'a\nb\nc\nD!\n',
    });
    const m = await computeText(dir, 'clean.txt');
    expect(m.blocks).toHaveLength(0);
    expect(m.initialText).toBe('A!\nb\nc\nD!\n');
    expect(serializeResult(m.segments)).toBe(m.initialText);
  });

  it("serializer: 'both' is ours-then-theirs; auto/manual take resolvedLines; unresolved renders base", async () => {
    const dir = realRepo();
    stageConflict(dir, 'ser.txt', {
      base: 'a\nb\nc\n',
      ours: 'a\nO\nc\n',
      theirs: 'a\nT\nc\n',
    });
    const m = await computeText(dir, 'ser.txt');
    const block = m.blocks[0]!;
    expect(serializeResult(m.segments)).toBe('a\nb\nc\n'); // unresolved → base
    block.resolution = 'both';
    expect(serializeResult(m.segments)).toBe('a\nO\nT\nc\n');
    block.resolution = 'manual';
    block.resolvedLines = ['hand-written\n'];
    expect(serializeResult(m.segments)).toBe('a\nhand-written\nc\n');
    block.resolvedLines = undefined;
    expect(() => serializeResult(m.segments)).toThrow(/resolvedLines/);
  });

  it('binary stages classify as binary, never as a text merge', async () => {
    const dir = realRepo();
    stageConflict(dir, 'bin.dat', {
      base: 'plain\n',
      ours: 'bin\0ary-ours\n',
      theirs: 'plain too\n',
    });
    const computer = new MergeComputer(await makeExec(dir));
    expect(await computer.compute('bin.dat')).toEqual({ kind: 'binary' });
  });

  it('stages over the size cap classify as too-large with the byte count', async () => {
    const dir = realRepo();
    stageConflict(dir, 'big.txt', {
      base: 'small\n',
      ours: '0123456789012345\n',
      theirs: 'small!\n',
    });
    const computer = new MergeComputer(await makeExec(dir), { sizeCap: 8 });
    expect(await computer.compute('big.txt')).toEqual({ kind: 'too-large', bytes: 17 });
  });

  it('non-conflicted path throws instead of fabricating a merge', async () => {
    const dir = realRepo();
    const computer = new MergeComputer(await makeExec(dir));
    await expect(computer.compute('missing.txt')).rejects.toThrow(/no index stages/);
  });

  it('property: assembled segments reproduce every side exactly across fixtures', async () => {
    const dir = realRepo();
    const fixtures: Array<[string, Triple]> = [
      ['p1.txt', { base: 'x\ny\nz\n', ours: 'x\nY1\nz\n', theirs: 'x\nY2\nz\n' }],
      ['p2.txt', { base: '1\n2\n3\n4\n5\n', ours: 'one\n2\n3\n4\ncinq\n', theirs: 'uno\n2\n3\n4\nfive\n' }],
      ['p3.txt', { base: 'only\n', ours: '', theirs: 'changed\n' }],
      ['p4.txt', { base: 'a\r\nb\r\n', ours: 'a\r\nB\r\n', theirs: 'a\r\nb2\r\n' }],
      ['p5.txt', { ours: 'left\n', theirs: 'right\n' }],
    ];
    for (const [rel, triple] of fixtures) {
      stageConflict(dir, rel, triple);
      const m = await computeText(dir, rel);
      expect(chomp(resolveAll(m, 'ours')), rel).toBe(chomp(triple.ours ?? ''));
      expect(chomp(resolveAll(m, 'theirs')), rel).toBe(chomp(triple.theirs ?? ''));
      const { text, ranges } = assembleInitialResult(m.segments);
      expect(text, rel).toBe(m.initialText);
      expect(ranges, rel).toEqual(m.initialRanges);
    }
  });
});
