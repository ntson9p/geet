/**
 * POST-QA F1: a patch of *some* of a file's changes must land where those
 * changes are, whatever was left out above them. Checked against real
 * `git apply --cached --unidiff-zero`, the command every caller runs.
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { computeLineChanges } from '../../../../src/core/patch/lineDiff';
import {
  applyLineChanges,
  buildPatch,
  complementChanges,
  correspondingChanges,
  invertChanges,
  type LineChange,
} from '../../../../src/core/patch/patchBuilder';
import { FixtureRepo } from '../../../fixtures/fixtureRepo';

const change = (
  originalStartLineNumber: number,
  originalEndLineNumber: number,
  modifiedStartLineNumber: number,
  modifiedEndLineNumber: number,
): LineChange => ({
  originalStartLineNumber,
  originalEndLineNumber,
  modifiedStartLineNumber,
  modifiedEndLineNumber,
});

let repo: FixtureRepo;
beforeAll(() => {
  repo = FixtureRepo.create({ prefix: 'gittree-subset-' });
  repo.commit('base', { 'file.txt': 'seed\n' });
});
afterAll(() => repo.dispose());

const git = (args: string[], input?: string): string =>
  execFileSync('git', args, { cwd: repo.root, ...(input !== undefined ? { input } : {}) }).toString('utf8');

/** Puts `indexText` in the index, applies `patch` with git, returns the index text. */
function applyToIndex(indexText: string, patch: string): string {
  fs.writeFileSync(path.join(repo.root, 'file.txt'), indexText);
  git(['add', 'file.txt']);
  git(['apply', '--cached', '--unidiff-zero', '-'], patch);
  return git(['show', ':0:file.txt']);
}

/**
 * Stages `subset` of original → modified the way the callers do. An empty
 * subset is never sent to git (the callers stop first; git calls a patch with
 * no hunks garbage), so it stands for "nothing changes".
 */
function stage(original: string, modified: string, subset: LineChange[]): string {
  if (subset.length === 0) return original;
  return applyToIndex(original, buildPatch({ relPath: 'file.txt', originalText: original, modifiedText: modified, changes: subset }));
}

/** Takes `subset` back out of an index holding `modified`. */
function unstage(original: string, modified: string, subset: LineChange[]): string {
  if (subset.length === 0) return modified;
  return applyToIndex(
    modified,
    buildPatch({ relPath: 'file.txt', originalText: modified, modifiedText: original, changes: invertChanges(subset) }),
  );
}

describe('buildPatch — a subset lands where its changes are', () => {
  it('stages a later insertion after an earlier insertion was left out (the QA repro)', () => {
    const original = 'a\nb\nc\nd\ne\n';
    const modified = 'a\nNEW1\nNEW2\nNEW3\nb\nc\nd\nINS\ne\n';
    const changes = computeLineChanges(original, modified);
    expect(changes).toHaveLength(2);
    // Left out: the three lines at the top. Wanted: INS between d and e.
    expect(stage(original, modified, [changes[1]!])).toBe('a\nb\nc\nd\nINS\ne\n');
  });

  it('puts a line typed above a closing brace above it, not after it', () => {
    const original = 'function f() {\n  return 1;\n}\n';
    const modified = '// header\nfunction f() {\n  return 1;\n  // two\n}\n';
    const [top, bottom] = computeLineChanges(original, modified);
    expect(stage(original, modified, [bottom!])).toBe('function f() {\n  return 1;\n  // two\n}\n');
    expect(stage(original, modified, [top!])).toBe('// header\nfunction f() {\n  return 1;\n}\n');
  });

  it('stages a later change after an earlier deletion was left out', () => {
    const original = 'a\nx\ny\nb\nc\nd\n';
    const modified = 'a\nb\nc\nINS\nd\n';
    const [del, ins] = computeLineChanges(original, modified);
    expect(stage(original, modified, [ins!])).toBe('a\nx\ny\nb\nc\nINS\nd\n');
    expect(stage(original, modified, [del!])).toBe('a\nb\nc\nd\n');
  });

  it('deletes the chosen one of several identical lines', () => {
    // `}` everywhere: git searches for a deletion's lines starting at the hint,
    // so a wrong hint deletes the wrong brace.
    const original = '{\n}\n{\n}\n{\n}\n';
    const modified = 'X\nY\nZ\n{\n}\n{\n}\n{\n';
    const changes = computeLineChanges(original, modified);
    for (let i = 0; i < changes.length; i++) {
      expect(stage(original, modified, [changes[i]!]), `change ${i}`).toBe(
        applyLineChanges(original, modified, [changes[i]!]),
      );
    }
  });

  it('keeps the numbering right for every subset of four changes', { timeout: 60_000 }, () => {
    const original = 'l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nl9\n';
    const modified = 'top\nl1\nL2\nl3\nl5\nl6\nmid1\nmid2\nl7\nl8\n';
    const changes = computeLineChanges(original, modified);
    expect(changes.length).toBeGreaterThanOrEqual(4);
    for (let mask = 0; mask < 1 << changes.length; mask++) {
      const subset = changes.filter((_, i) => (mask & (1 << i)) !== 0);
      expect(stage(original, modified, subset), `mask ${mask}`).toBe(applyLineChanges(original, modified, subset));
    }
  });
});

describe('invertChanges — unstaging applies the inverse forwards', () => {
  it('swaps the sides and keeps the order', () => {
    expect(invertChanges([change(0, 0, 1, 2), change(4, 5, 5, 0), change(7, 7, 6, 6)])).toEqual([
      change(1, 2, 0, 0),
      change(5, 0, 4, 5),
      change(6, 6, 7, 7),
    ]);
  });

  it('takes one staged change out of the index and leaves the rest staged', () => {
    const head = 'a\nb\nc\nd\ne\n';
    const index = 'a\nNEW1\nNEW2\nb\nc\nd\nINS\ne\n';
    const [top, bottom] = computeLineChanges(head, index);
    expect(unstage(head, index, [bottom!])).toBe('a\nNEW1\nNEW2\nb\nc\nd\ne\n');
    expect(unstage(head, index, [top!])).toBe('a\nb\nc\nd\nINS\ne\n');
  });
});

describe('random subsets agree with applyLineChanges', () => {
  // Deterministic LCG so a failure reproduces.
  let seed = 0x5eed1f1;
  const rand = (): number => {
    seed = (seed * 48271) % 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const randomLines = (n: number): string[] =>
    Array.from({ length: n }, () => String.fromCharCode(97 + Math.floor(rand() * 4)).repeat(1 + Math.floor(rand() * 2)));
  const mutate = (lines: string[]): string[] => {
    const out = [...lines];
    const ops = 2 + Math.floor(rand() * 5);
    for (let i = 0; i < ops; i++) {
      const pos = Math.floor(rand() * (out.length + 1));
      const r = rand();
      if (r < 0.4) out.splice(pos, 0, ...randomLines(1 + Math.floor(rand() * 3)).map((l) => `+${l}`));
      else if (r < 0.7 && out.length > 0) out.splice(Math.min(pos, out.length - 1), 1 + Math.floor(rand() * 2));
      else if (out.length > 0) out[Math.min(pos, out.length - 1)] = `~${randomLines(1)[0]}`;
    }
    return out;
  };
  const text = (lines: string[]): string => (lines.length > 0 ? `${lines.join('\n')}\n` : '');

  // Six git calls a case, so it needs more than the default 5 s.
  it('stages and unstages 30 random subsets exactly', { timeout: 120_000 }, () => {
    for (let i = 0; i < 30; i++) {
      const base = randomLines(4 + Math.floor(rand() * 16));
      const original = text(base);
      const modified = text(mutate(base));
      const changes = computeLineChanges(original, modified);
      const subset = changes.filter(() => rand() < 0.5);
      const label = `case ${i}\nO=${JSON.stringify(original)}\nM=${JSON.stringify(modified)}\nsubset=${JSON.stringify(subset)}`;
      expect(stage(original, modified, subset), label).toBe(applyLineChanges(original, modified, subset));
      const kept = complementChanges(
        changes,
        subset.map((c) => changes.indexOf(c)),
      );
      expect(unstage(original, modified, subset), label).toBe(applyLineChanges(original, modified, kept));
    }
  });
});

describe('correspondingChanges — the clicked change on a fresh diff', () => {
  it('returns the identical change when there is one', () => {
    const fresh = [change(1, 1, 1, 1), change(5, 0, 6, 7)];
    expect(correspondingChanges(fresh, change(5, 0, 6, 7))).toEqual([fresh[1]]);
  });

  it('matches on the working-tree lines when the bars were measured against HEAD', () => {
    // HEAD → worktree: lines 4-6 replaced two lines; index → worktree: the
    // index already has part of it, so the fresh change replaces one line.
    const fresh = [change(1, 1, 1, 1), change(4, 4, 4, 6), change(9, 9, 11, 11)];
    expect(correspondingChanges(fresh, change(4, 5, 4, 6))).toEqual([fresh[1]]);
  });

  it('takes every fresh change on the picked lines, and nothing next to them', () => {
    const fresh = [change(1, 1, 2, 2), change(3, 3, 4, 4), change(5, 6, 5, 0), change(8, 8, 8, 8)];
    // Picked: lines 2..6 of the working tree. The deletion's gap sits after
    // line 5, inside the range; line 8 is outside it.
    expect(correspondingChanges(fresh, change(2, 4, 2, 6))).toEqual([fresh[0], fresh[1], fresh[2]]);
  });

  it('matches a picked deletion only to a deletion at the same gap', () => {
    const fresh = [change(2, 2, 1, 0), change(4, 4, 3, 0)];
    expect(correspondingChanges(fresh, change(4, 5, 3, 0))).toEqual([fresh[1]]);
    expect(correspondingChanges(fresh, change(7, 7, 5, 0))).toEqual([]);
  });

  it('finds nothing when those lines are already staged', () => {
    expect(correspondingChanges([change(9, 9, 9, 9)], change(2, 2, 2, 3))).toEqual([]);
  });
});
