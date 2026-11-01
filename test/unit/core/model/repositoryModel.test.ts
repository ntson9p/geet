import { describe, expect, it } from 'vitest';
import { RepositoryModel, type ModelSection } from '../../../../src/core/model/repositoryModel';
import type { StatusEntry } from '../../../../src/core/model/statusEntry';
import type { RefInfo } from '../../../../src/core/model/refs';

function entry(path: string, x = 'M', y = '.'): StatusEntry {
  return { kind: 'ordinary', path, x, y, submodule: 'N...' };
}

function ref(name: string, sha: string, isHead = false): RefInfo {
  return { name, fullName: `refs/heads/${name}`, type: 'head', sha, objectType: 'commit', isHead };
}

function collect(model: RepositoryModel): ReadonlySet<ModelSection>[] {
  const fired: ReadonlySet<ModelSection>[] = [];
  model.onDidChange((s) => fired.push(s));
  return fired;
}

describe('RepositoryModel section diffing', () => {
  it('fires only the sections that changed', () => {
    const m = new RepositoryModel('X:/repo');
    const fired = collect(m);

    const changed = m.update({ headRef: 'main', headSha: 'a'.repeat(40) });
    expect([...changed]).toEqual(['head']);
    expect(fired).toHaveLength(1);

    const c2 = m.update({ statusEntries: [entry('a.ts')] });
    expect([...c2]).toEqual(['status']);
  });

  it('does not fire when content is identical (fresh arrays, same values)', () => {
    const m = new RepositoryModel('X:/repo');
    m.update({ statusEntries: [entry('a.ts')], refs: [ref('main', '1'.repeat(40), true)] });
    const fired = collect(m);
    const changed = m.update({
      statusEntries: [entry('a.ts')],
      refs: [ref('main', '1'.repeat(40), true)],
    });
    expect(changed.size).toBe(0);
    expect(fired).toHaveLength(0);
  });

  it('reports multiple sections in one update', () => {
    const m = new RepositoryModel('X:/repo');
    m.update({ headRef: 'main', refs: [ref('main', '1'.repeat(40), true)] });
    const changed = m.update({
      headRef: 'feature',
      refs: [ref('main', '1'.repeat(40), false), ref('feature', '2'.repeat(40), true)],
      statusEntries: [entry('b.ts')],
    });
    expect([...changed].sort()).toEqual(['head', 'refs', 'status']);
  });

  it('detects status change on same path when staging state flips', () => {
    const m = new RepositoryModel('X:/repo');
    m.update({ statusEntries: [entry('a.ts', '.', 'M')] });
    const changed = m.update({ statusEntries: [entry('a.ts', 'M', '.')] });
    expect([...changed]).toEqual(['status']);
  });

  it('diffs the op section by value', () => {
    const m = new RepositoryModel('X:/repo');
    expect([...m.update({ inProgressOp: { kind: 'rebase-interactive', step: 1, total: 3 } })]).toEqual(['op']);
    expect(m.update({ inProgressOp: { kind: 'rebase-interactive', step: 1, total: 3 } }).size).toBe(0);
    expect([...m.update({ inProgressOp: { kind: 'rebase-interactive', step: 2, total: 3 } })]).toEqual(['op']);
    expect([...m.update({ inProgressOp: undefined })]).toEqual(['op']);
  });

  it('diffs stashes by selector+sha+message', () => {
    const m = new RepositoryModel('X:/repo');
    const stash = { index: 0, selector: 'stash@{0}', sha: 'a'.repeat(40), message: 'WIP', time: 1 };
    expect([...m.update({ stashes: [stash] })]).toEqual(['stashes']);
    expect(m.update({ stashes: [{ ...stash }] }).size).toBe(0);
  });

  it('keeps snapshots immutable and stable for unchanged updates', () => {
    const m = new RepositoryModel('X:/repo');
    m.update({ headRef: 'main' });
    const snap = m.snapshot;
    expect(Object.isFrozen(snap)).toBe(true);
    m.update({ headRef: 'main' }); // no change
    expect(m.snapshot).toBe(snap); // same reference — nothing replaced
    m.update({ headRef: 'dev' });
    expect(m.snapshot).not.toBe(snap);
    expect(snap.headRef).toBe('main'); // old snapshot untouched
  });

  it('workdir generation bumps and feeds the invalidation key', () => {
    const m = new RepositoryModel('X:/repo');
    m.update({ headSha: 'a'.repeat(40) });
    const k1 = m.invalidationKey;
    m.bumpWorkdirGeneration();
    expect(m.workdirGeneration).toBe(1);
    expect(m.invalidationKey).not.toBe(k1);
  });
});

describe('RepositoryModel.refsGeneration', () => {
  const sha = 'a'.repeat(40);

  it('moves when a ref or HEAD changes, though HEAD stays on the same commit', () => {
    const m = new RepositoryModel('X:/repo');
    m.update({ headRef: 'master', headSha: sha, refs: [ref('master', sha, true)] });
    const before = m.refsGeneration;
    // `git switch -c abc`: a new branch at the very same commit.
    m.update({ headRef: 'abc', refs: [ref('abc', sha, true), ref('master', sha)] });
    expect(m.refsGeneration).toBeGreaterThan(before);
    expect(m.snapshot.headSha).toBe(sha);
  });

  it('stays put for a change to the working tree alone', () => {
    const m = new RepositoryModel('X:/repo');
    m.update({ headRef: 'main', headSha: sha, refs: [ref('main', sha, true)] });
    const before = m.refsGeneration;
    m.update({ statusEntries: [entry('a.ts')] });
    expect(m.refsGeneration).toBe(before);
  });
});
