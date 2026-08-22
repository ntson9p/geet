import { describe, expect, it } from 'vitest';
import { computeLineChanges } from '../../../src/core/patch/lineDiff';
import { applyLineChanges, buildPatch, type LineChange } from '../../../src/core/patch/patchBuilder';
import { InclusionModel, signChanges } from '../../../src/commit/window/inclusion';
import {
  planPartialCommit,
  type FileDiff,
  type PartialPlanDeps,
} from '../../../src/commit/window/fileDiff';

const REPO = 'd:/repos/demo';

function changes(...spec: Array<[number, number, number, number]>): LineChange[] {
  return spec.map(([os, oe, ms, me]) => ({
    originalStartLineNumber: os,
    originalEndLineNumber: oe,
    modifiedStartLineNumber: ms,
    modifiedEndLineNumber: me,
  }));
}

describe('P11-T3 signChanges', () => {
  it('identifies a change list by every coordinate', () => {
    expect(signChanges(changes([2, 2, 2, 2], [5, 6, 5, 7]))).toBe('2,2,2,2;5,6,5,7');
    expect(signChanges([])).toBe('');
  });

  it('separates lists that differ only in where a change sits', () => {
    expect(signChanges(changes([2, 2, 2, 2]))).not.toBe(signChanges(changes([3, 3, 3, 3])));
  });

  it('treats an appended change as a different list', () => {
    const before = signChanges(changes([2, 2, 2, 2]));
    const after = signChanges(changes([2, 2, 2, 2], [9, 9, 9, 9]));
    expect(after).not.toBe(before);
  });
});

describe('P11-T3 InclusionModel', () => {
  it('has no entry until something is excluded — absent means the whole file', () => {
    const model = new InclusionModel();
    expect(model.get(REPO, 'a.txt')).toBeUndefined();
    expect(model.resolve(REPO, 'a.txt', changes([1, 1, 1, 1]))).toBeUndefined();
  });

  it('stores a partial selection and reports it back', () => {
    const model = new InclusionModel();
    const list = changes([2, 2, 2, 2], [4, 4, 4, 4], [6, 6, 6, 6]);
    model.set(REPO, 'a.txt', list, [1]);
    expect(model.get(REPO, 'a.txt')).toEqual({
      signature: signChanges(list),
      included: [1],
      total: 3,
    });
    expect(model.resolve(REPO, 'a.txt', list)).toEqual([1]);
  });

  it('normalises the index set: sorted, deduped, out-of-range dropped', () => {
    const model = new InclusionModel();
    const list = changes([2, 2, 2, 2], [4, 4, 4, 4], [6, 6, 6, 6]);
    model.set(REPO, 'a.txt', list, [2, 0, 2, 99, -1]);
    expect(model.get(REPO, 'a.txt')?.included).toEqual([0, 2]);
  });

  it('selecting everything is stored as no selection at all', () => {
    const model = new InclusionModel();
    const list = changes([2, 2, 2, 2], [4, 4, 4, 4]);
    model.set(REPO, 'a.txt', list, [0, 1]);
    // "All of it" and "the whole file" must be one state, not two — the commit
    // path would otherwise have an untested second way to say the same thing.
    expect(model.get(REPO, 'a.txt')).toBeUndefined();
  });

  it('falls back to the whole file once the change list is renumbered', () => {
    const model = new InclusionModel();
    const list = changes([2, 2, 2, 2], [4, 4, 4, 4], [6, 6, 6, 6]);
    model.set(REPO, 'a.txt', list, [1]);
    // An edit above the hunks shifts every modified line number.
    const shifted = changes([2, 2, 3, 3], [4, 4, 5, 5], [6, 6, 7, 7]);
    expect(model.isStale(REPO, 'a.txt', shifted)).toBe(true);
    expect(model.resolve(REPO, 'a.txt', shifted)).toBeUndefined();
  });

  it('does not call an untouched list stale', () => {
    const model = new InclusionModel();
    const list = changes([2, 2, 2, 2], [4, 4, 4, 4]);
    model.set(REPO, 'a.txt', list, [0]);
    expect(model.isStale(REPO, 'a.txt', changes([2, 2, 2, 2], [4, 4, 4, 4]))).toBe(false);
  });

  it('an empty selection survives — it means the file contributes nothing', () => {
    const model = new InclusionModel();
    const list = changes([2, 2, 2, 2], [4, 4, 4, 4]);
    model.set(REPO, 'a.txt', list, []);
    expect(model.resolve(REPO, 'a.txt', list)).toEqual([]);
  });

  it('keeps repositories apart', () => {
    const model = new InclusionModel();
    const list = changes([2, 2, 2, 2], [4, 4, 4, 4]);
    model.set(REPO, 'a.txt', list, [0]);
    expect(model.get('d:/repos/other', 'a.txt')).toBeUndefined();
    expect(model.count(REPO)).toBe(1);
    expect(model.count('d:/repos/other')).toBe(0);
  });

  it('prunes selections whose file is no longer pending', () => {
    const model = new InclusionModel();
    const list = changes([2, 2, 2, 2], [4, 4, 4, 4]);
    model.set(REPO, 'a.txt', list, [0]);
    model.set(REPO, 'b.txt', list, [1]);
    expect(model.prune(REPO, ['b.txt'])).toBe(true);
    expect(model.get(REPO, 'a.txt')).toBeUndefined();
    expect(model.get(REPO, 'b.txt')).toBeDefined();
    // Idempotent: a second prune over the same live set changes nothing.
    expect(model.prune(REPO, ['b.txt'])).toBe(false);
  });

  it('clearRepo drops every selection for one repo only', () => {
    const model = new InclusionModel();
    const list = changes([2, 2, 2, 2], [4, 4, 4, 4]);
    model.set(REPO, 'a.txt', list, [0]);
    model.set('d:/repos/other', 'a.txt', list, [0]);
    model.clearRepo(REPO);
    expect(model.count(REPO)).toBe(0);
    expect(model.count('d:/repos/other')).toBe(1);
  });
});

describe('P11-T3 planPartialCommit', () => {
  const HEAD = 'a\nb\nc\nd\ne\n';
  const WORK = 'a\nB2\nc\nD2\ne\n';

  const diffOf = (relPath: string, original = HEAD, modified = WORK): FileDiff => ({
    relPath,
    originalText: original,
    modifiedText: modified,
    changes: computeLineChanges(original, modified),
    wholeFileOnly: false,
  });

  const plan = (
    relPaths: string[],
    over: Partial<PartialPlanDeps> = {},
  ): Promise<Awaited<ReturnType<typeof planPartialCommit>>> =>
    planPartialCommit(relPaths, {
      readDiff: (relPath) => Promise.resolve(diffOf(relPath)),
      resolveIncluded: () => undefined,
      hasSelection: () => false,
      ...over,
    });

  it('routes files with no selection straight to the whole-file list', async () => {
    const result = await plan(['a.txt', 'b.txt']);
    expect(result).toEqual({ wholePaths: ['a.txt', 'b.txt'], partials: [], skipped: [], stale: [] });
  });

  it('builds a patch holding only the selected change', async () => {
    const result = await plan(['a.txt'], {
      hasSelection: () => true,
      resolveIncluded: () => [0],
    });
    expect(result.wholePaths).toEqual([]);
    expect(result.stale).toEqual([]);
    expect(result.partials).toHaveLength(1);
    const patch = result.partials[0]!.patch;
    expect(patch).toContain('+B2');
    expect(patch).not.toContain('+D2');
  });

  it('a selection covering every change is committed as a whole file', async () => {
    const result = await plan(['a.txt'], {
      hasSelection: () => true,
      resolveIncluded: () => [0, 1],
    });
    expect(result.wholePaths).toEqual(['a.txt']);
    expect(result.partials).toEqual([]);
  });

  it('a stale selection commits the whole file and says so', async () => {
    const result = await plan(['a.txt'], {
      hasSelection: () => true,
      // `resolve` answers undefined for a renumbered list.
      resolveIncluded: () => undefined,
    });
    expect(result.wholePaths).toEqual(['a.txt']);
    // Silently committing more than was ticked is the outcome to avoid; the
    // caller warns from this list.
    expect(result.stale).toEqual(['a.txt']);
  });

  it('a binary or one-sided file commits whole without a stale warning', async () => {
    const result = await plan(['bin.png'], {
      hasSelection: () => true,
      readDiff: (relPath) =>
        Promise.resolve({
          relPath,
          originalText: '',
          modifiedText: '',
          changes: [],
          wholeFileOnly: true,
        }),
    });
    expect(result.wholePaths).toEqual(['bin.png']);
    // It never had per-change inclusion to lose, so there is nothing to warn about.
    expect(result.stale).toEqual([]);
  });

  it('a file with every change excluded contributes nothing at all', async () => {
    const result = await plan(['a.txt'], {
      hasSelection: () => true,
      resolveIncluded: () => [],
    });
    expect(result.skipped).toEqual(['a.txt']);
    expect(result.wholePaths).toEqual([]);
    expect(result.partials).toEqual([]);
  });

  it('mixes whole, partial and skipped files in one plan', async () => {
    const selections: Record<string, number[] | undefined> = { 'p.txt': [1], 'z.txt': [] };
    const result = await plan(['w.txt', 'p.txt', 'z.txt'], {
      hasSelection: (relPath) => relPath in selections,
      resolveIncluded: (relPath) => selections[relPath],
    });
    expect(result.wholePaths).toEqual(['w.txt']);
    expect(result.partials.map((p) => p.relPath)).toEqual(['p.txt']);
    expect(result.skipped).toEqual(['z.txt']);
  });

  it('the patch it would build applies exactly the ticked change', () => {
    // The plan's git call is `git apply --cached` over buildPatch output, and
    // applyLineChanges is the same walk — so this pins what the commit gets.
    const list = computeLineChanges(HEAD, WORK);
    expect(list).toHaveLength(2);
    const onlyFirst = applyLineChanges(HEAD, WORK, [list[0] as LineChange]);
    expect(onlyFirst).toBe('a\nB2\nc\nd\ne\n');
    const patch = buildPatch({
      relPath: 'a.txt',
      originalText: HEAD,
      modifiedText: WORK,
      changes: [list[0] as LineChange],
    });
    expect(patch).toContain('-b');
    expect(patch).toContain('+B2');
    expect(patch).not.toContain('+D2');
  });

  it('a CRLF file keeps its line endings through the patch', () => {
    const head = 'l1\r\nl2\r\nl3\r\n';
    const work = 'l1\r\nL2\r\nl3\r\n';
    const list = computeLineChanges(head, work);
    const patch = buildPatch({ relPath: 'c.txt', originalText: head, modifiedText: work, changes: list });
    // CR stays attached to the content line, so git writes the bytes back.
    expect(patch).toContain('-l2\r');
    expect(patch).toContain('+L2\r');
  });
});
