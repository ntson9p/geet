/**
 * P6-T5 acceptance — golden fixture suite (≥ 25 triples): the wand cascade
 * runs against conflict blocks parsed from real `git merge-file --diff3`
 * output per fixture; adversarial near-misses stay `manual`, auto outcomes
 * serialize byte-exact (CRLF fixtures included), and a second wand run
 * resolves 0 (idempotence). Plus direct rule-order/edge cases.
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  parseDiff3,
  serializeResult,
  type ConflictBlock,
  type MergeSegment,
} from '../../../../src/merge/mergeCompute';
import { resolveAllBlocks, resolveBlock } from '../../../../src/merge/resolver/autoResolver';
import { baseAnchoredEdits, weaveDisjoint } from '../../../../src/merge/resolver/lineDiff3';

const FIXTURES = path.join(process.cwd(), 'test/fixtures/merge');

interface FixtureMeta {
  description: string;
  expect: 'auto' | 'manual' | 'clean';
  options?: { whitespace?: boolean };
}

interface Fixture {
  name: string;
  meta: FixtureMeta;
  expected: string;
  merged: string;
  conflicts: number;
}

/** Same canonical re-merge the MergeComputer runs (T2's merge-file seam). */
function mergeFixture(dir: string): { merged: string; conflicts: number } {
  const args = [
    'merge-file',
    '-p',
    '--diff3',
    '--marker-size=32',
    '-L',
    'ours',
    '-L',
    'base',
    '-L',
    'theirs',
    path.join(dir, 'ours'),
    path.join(dir, 'base'),
    path.join(dir, 'theirs'),
  ];
  try {
    return { merged: execFileSync('git', args, { encoding: 'utf8' }), conflicts: 0 };
  } catch (err) {
    const e = err as { status?: number | null; stdout?: string };
    if (typeof e.status === 'number' && e.status > 0 && e.status <= 127) {
      return { merged: e.stdout ?? '', conflicts: e.status };
    }
    throw err;
  }
}

function loadFixture(name: string): Fixture {
  const dir = path.join(FIXTURES, name);
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8')) as FixtureMeta;
  const expected = fs.readFileSync(path.join(dir, 'expected'), 'utf8');
  return { name, meta, expected, ...mergeFixture(dir) };
}

const wand = (blocks: readonly ConflictBlock[], opts: { whitespace: boolean }): number =>
  resolveAllBlocks(blocks, opts, (block, lines) => {
    block.resolution = 'auto';
    block.resolvedLines = lines;
  });

const conflictBlocks = (segments: MergeSegment[]): ConflictBlock[] =>
  segments.flatMap((s) => (s.kind === 'conflict' ? [s.block] : []));

describe('P6-T5 golden fixture suite', () => {
  const names = fs.readdirSync(FIXTURES).sort();

  it('spans ≥ 25 triples across auto and manual outcomes', () => {
    const byExpect = { auto: 0, manual: 0, clean: 0 };
    for (const name of names) byExpect[loadFixture(name).meta.expect]++;
    expect(names.length).toBeGreaterThanOrEqual(25);
    expect(byExpect.auto).toBeGreaterThanOrEqual(10);
    expect(byExpect.manual).toBeGreaterThanOrEqual(10);
  });

  for (const name of names) {
    it(`fixture: ${name}`, () => {
      const f = loadFixture(name);
      const opts = { whitespace: f.meta.options?.whitespace ?? true };

      if (f.meta.expect === 'clean') {
        expect(f.conflicts).toBe(0);
        expect(f.merged).toBe(f.expected);
        return;
      }

      expect(f.conflicts).toBeGreaterThan(0);
      const segments = parseDiff3(f.merged);
      const blocks = conflictBlocks(segments);
      expect(blocks.length).toBeGreaterThan(0);

      const applied = wand(blocks, opts);
      if (f.meta.expect === 'auto') {
        expect(applied).toBe(blocks.length);
        for (const b of blocks) {
          expect(b.resolution).toBe('auto');
          expect(b.resolvedLines).toBeDefined();
        }
      } else {
        expect(applied).toBe(0);
        for (const b of blocks) expect(b.resolution).toBeUndefined();
      }
      // Byte-exact (CRLF fixtures ride on this): auto = woven result,
      // manual = initial result (base inside conflict regions), verbatim.
      expect(serializeResult(segments)).toBe(f.expected);

      // Idempotence: a second wand pass resolves 0.
      expect(wand(blocks, opts)).toBe(0);
    });
  }
});

describe('resolveBlock rule order and edges', () => {
  const block = (base: string[], ours: string[], theirs: string[]): ConflictBlock => ({
    id: 0,
    base,
    ours,
    theirs,
  });

  it('rule 1 (identical) outranks whitespace classification', () => {
    // ours == theirs but both are ws-only vs base: identical wins, keeps ours.
    const out = resolveBlock(block(['b\n'], ['  b\n'], ['  b\n']), { whitespace: true });
    expect(out).toEqual({ resolved: true, lines: ['  b\n'], rule: 'identical' });
  });

  it('rule 2 fires per side (git adjacency grouping shape)', () => {
    const oursIsBase = resolveBlock(block(['b\n'], ['b\n'], ['B!\n']), { whitespace: false });
    expect(oursIsBase).toEqual({ resolved: true, lines: ['B!\n'], rule: 'ours-is-base' });
    const theirsIsBase = resolveBlock(block(['b\n'], ['B!\n'], ['b\n']), { whitespace: false });
    expect(theirsIsBase).toEqual({ resolved: true, lines: ['B!\n'], rule: 'theirs-is-base' });
  });

  it('whitespace rule never fires when disabled', () => {
    const out = resolveBlock(block(['b\n'], ['  b\n'], ['B!\n']), { whitespace: false });
    expect(out).toEqual({ resolved: false });
  });

  it('resolveAllBlocks skips blocks that already carry a resolution', () => {
    const resolved: ConflictBlock = { ...block(['b\n'], ['b\n'], ['B!\n']), resolution: 'ours' };
    const count = resolveAllBlocks([resolved], { whitespace: true }, () => {
      throw new Error('must not apply to an already-resolved block');
    });
    expect(count).toBe(0);
    expect(resolved.resolution).toBe('ours');
  });
});

describe('weaveDisjoint ambiguity guards', () => {
  it('refuses two inserts at the same base point', () => {
    const base = ['a\n', 'b\n'];
    const ours = baseAnchoredEdits(base, ['a\n', 'X\n', 'b\n']);
    const theirs = baseAnchoredEdits(base, ['a\n', 'Y\n', 'b\n']);
    expect(weaveDisjoint(base, ours, theirs)).toBeUndefined();
  });

  it('refuses an insert anchored where the other side edits (ownership ambiguous)', () => {
    const base = ['a\n', 'b\n'];
    const ours = baseAnchoredEdits(base, ['a\n', 'X\n', 'b\n']); // insert before b
    const theirs = baseAnchoredEdits(base, ['a\n', 'B!\n']); // edit b
    expect(weaveDisjoint(base, ours, theirs)).toBeUndefined();
  });

  it('refuses an insert strictly inside the other side of a rewrite', () => {
    const base = ['a\n', 'b\n', 'c\n'];
    const ours = baseAnchoredEdits(base, ['a\n', 'b\n', 'X\n', 'c\n']); // insert between b/c
    const theirs = baseAnchoredEdits(base, ['a\n', 'R\n']); // rewrite b..c
    expect(weaveDisjoint(base, ours, theirs)).toBeUndefined();
  });

  it('weaves disjoint edits in base order', () => {
    const base = ['a\n', 'b\n', 'c\n', 'd\n'];
    const ours = baseAnchoredEdits(base, ['a\n', 'B!\n', 'c\n', 'd\n']);
    const theirs = baseAnchoredEdits(base, ['a\n', 'b\n', 'c\n', 'D!\n']);
    expect(weaveDisjoint(base, ours, theirs)).toEqual(['a\n', 'B!\n', 'c\n', 'D!\n']);
  });
});
