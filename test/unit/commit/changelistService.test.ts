import { describe, expect, it } from 'vitest';
import {
  ChangelistService,
  DEFAULT_LIST_ID,
  UNVERSIONED_ID,
  type ChangelistStorage,
} from '../../../src/commit/changelists/changelistService';
import { RepositoryModel } from '../../../src/core/model/repositoryModel';
import type { StatusEntry } from '../../../src/core/model/statusEntry';

function entry(path: string, x: string, y: string, kind: StatusEntry['kind'] = 'ordinary'): StatusEntry {
  return { kind, path, x, y, submodule: 'N...' };
}
const modified = (p: string): StatusEntry => entry(p, '.', 'M');
const untracked = (p: string): StatusEntry => ({ kind: 'untracked', path: p, x: '.', y: '?', submodule: 'N...' });
const conflicted = (p: string): StatusEntry => ({ kind: 'unmerged', path: p, x: 'U', y: 'U', submodule: 'N...' });

function rig(initial: StatusEntry[] = []): {
  model: RepositoryModel;
  service: ChangelistService;
  stored: (key?: string) => unknown;
} {
  const backing = new Map<string, unknown>();
  const storage: ChangelistStorage = {
    get: <T,>(k: string) => backing.get(k) as T | undefined,
    update: (k, v) => {
      backing.set(k, JSON.parse(JSON.stringify(v)));
    },
  };
  const model = new RepositoryModel('X:/repo');
  model.update({ statusEntries: initial });
  const service = new ChangelistService(model, storage, 'test-key');
  return { model, service, stored: (key = 'test-key') => backing.get(key) };
}

describe('ChangelistService invariants', () => {
  it('starts with exactly one default+active list', () => {
    const { service } = rig();
    const lists = service.getLists();
    expect(lists).toHaveLength(1);
    expect(lists[0]).toMatchObject({ id: DEFAULT_LIST_ID, isDefault: true, isActive: true });
  });

  it('adopts new tracked-dirty files into the ACTIVE list, checked by default', () => {
    const { model, service } = rig([modified('a.ts')]);
    expect(service.getLists()[0]?.files).toEqual(['a.ts']);
    expect(service.getLists()[0]?.checked).toEqual(['a.ts']);

    const work = service.create('Feature work', undefined, true);
    model.update({ statusEntries: [modified('a.ts'), modified('b.ts')] });
    expect(service.getList(work.id)?.files).toEqual(['b.ts']); // active adopted
    expect(service.getList(DEFAULT_LIST_ID)?.files).toEqual(['a.ts']); // untouched
  });

  it('keeps a file in exactly one list across moves', () => {
    const { model, service } = rig([modified('a.ts'), modified('b.ts')]);
    void model;
    const other = service.create('Other');
    service.moveFiles(['a.ts'], other.id);
    expect(service.getList(DEFAULT_LIST_ID)?.files).toEqual(['b.ts']);
    expect(service.getList(other.id)?.files).toEqual(['a.ts']);
    service.moveFiles(['a.ts'], DEFAULT_LIST_ID);
    expect(service.getList(other.id)?.files).toEqual([]);
    expect(new Set(service.getList(DEFAULT_LIST_ID)?.files)).toEqual(new Set(['a.ts', 'b.ts']));
  });

  it('enforces exactly one active list', () => {
    const { service } = rig();
    const l2 = service.create('Two', undefined, true);
    expect(service.getLists().filter((l) => l.isActive)).toHaveLength(1);
    expect(service.getList(l2.id)?.isActive).toBe(true);
    service.setActive(DEFAULT_LIST_ID);
    expect(service.getList(l2.id)?.isActive).toBe(false);
    expect(service.getList(DEFAULT_LIST_ID)?.isActive).toBe(true);
  });

  it('remove() moves files and reassigns active to the default list', () => {
    const { model, service } = rig([modified('a.ts')]);
    void model;
    const l2 = service.create('Two', 'comment', true);
    service.moveFiles(['a.ts'], l2.id);
    service.remove(l2.id);
    expect(service.getLists()).toHaveLength(1);
    expect(service.getList(DEFAULT_LIST_ID)?.files).toEqual(['a.ts']);
    expect(service.getList(DEFAULT_LIST_ID)?.isActive).toBe(true);
  });

  it('cannot remove the default list', () => {
    const { service } = rig();
    service.remove(DEFAULT_LIST_ID);
    expect(service.getLists()).toHaveLength(1);
  });
});

describe('ChangelistService reconciliation', () => {
  it('drops files that became clean (modified → reverted)', () => {
    const { model, service } = rig([modified('a.ts'), modified('b.ts')]);
    expect(service.getList(DEFAULT_LIST_ID)?.files).toHaveLength(2);
    model.update({ statusEntries: [modified('b.ts')] }); // a.ts reverted
    expect(service.getList(DEFAULT_LIST_ID)?.files).toEqual(['b.ts']);
  });

  it('unversioned files stay virtual until moved into a list', () => {
    const { model, service } = rig([untracked('new.txt'), modified('a.ts')]);
    expect(service.unversioned()).toEqual(['new.txt']);
    expect(service.getList(DEFAULT_LIST_ID)?.files).toEqual(['a.ts']);

    service.moveFiles(['new.txt'], DEFAULT_LIST_ID);
    expect(service.unversioned()).toEqual([]);
    expect(new Set(service.getList(DEFAULT_LIST_ID)?.files)).toEqual(new Set(['a.ts', 'new.txt']));

    // untracked → added (staged): leaves Unversioned semantics entirely, stays in list.
    model.update({ statusEntries: [entry('new.txt', 'A', '.'), modified('a.ts')] });
    expect(service.unversioned()).toEqual([]);
    expect(service.getList(DEFAULT_LIST_ID)?.files).toContain('new.txt');
  });

  it('conflicted files never join changelists', () => {
    const { service } = rig([conflicted('war.ts'), modified('a.ts')]);
    expect(service.getList(DEFAULT_LIST_ID)?.files).toEqual(['a.ts']);
  });

  it('checkbox state persists and prunes with membership', () => {
    const { model, service, stored } = rig([modified('a.ts'), modified('b.ts')]);
    service.setChecked(['a.ts'], false);
    expect(service.getList(DEFAULT_LIST_ID)?.checked).toEqual(['b.ts']);
    // persisted shape contains the unchecked entry
    expect(JSON.stringify(stored())).toContain('a.ts');
    model.update({ statusEntries: [modified('b.ts')] }); // a.ts gone
    expect(service.getList(DEFAULT_LIST_ID)?.checked).toEqual(['b.ts']);
    // list-level check-all round trip
    service.setListChecked(DEFAULT_LIST_ID, false);
    expect(service.getList(DEFAULT_LIST_ID)?.checked).toEqual([]);
    service.setListChecked(DEFAULT_LIST_ID, true);
    expect(service.getList(DEFAULT_LIST_ID)?.checked).toEqual(['b.ts']);
  });

  it('P11-T3: unversioned files are tickable and start unticked', () => {
    const { service } = rig([untracked('new.txt'), untracked('other.txt'), modified('a.ts')]);
    // IntelliJ's default — an untracked file joins a commit only when you say so.
    expect(service.unversionedCheckedPaths()).toEqual([]);
    expect(service.isChecked('new.txt')).toBe(false);
    expect(service.isChecked('a.ts')).toBe(true);

    service.setChecked(['new.txt'], true);
    expect(service.unversionedCheckedPaths()).toEqual(['new.txt']);
    expect(service.isChecked('new.txt')).toBe(true);
    // Ticking one untracked file must not drag the rest in.
    expect(service.isChecked('other.txt')).toBe(false);

    service.setChecked(['new.txt'], false);
    expect(service.unversionedCheckedPaths()).toEqual([]);
  });

  it('P11-T3: the Unversioned group checkbox ticks and unticks every member', () => {
    const { service } = rig([untracked('one.txt'), untracked('two.txt')]);
    service.setListChecked(UNVERSIONED_ID, true);
    expect(service.unversionedCheckedPaths()).toEqual(['one.txt', 'two.txt']);
    service.setListChecked(UNVERSIONED_ID, false);
    expect(service.unversionedCheckedPaths()).toEqual([]);
  });

  it('P11-T3: unversioned ticks persist and prune when the file stops being untracked', () => {
    const { model, service, stored } = rig([untracked('new.txt')]);
    service.setChecked(['new.txt'], true);
    expect(JSON.stringify(stored('test-key.unversionedChecked'))).toContain('new.txt');

    // Committed: no longer untracked, so the tick has nothing left to describe.
    model.update({ statusEntries: [] });
    expect(service.unversionedCheckedPaths()).toEqual([]);
    expect(service.isChecked('new.txt')).toBe(false);
  });

  it('P11-T3: adopting an unversioned file hands its tick to the list', () => {
    const { service } = rig([untracked('new.txt')]);
    service.setChecked(['new.txt'], true);
    service.moveFiles(['new.txt'], DEFAULT_LIST_ID);
    // One owner for the checkbox, not two disagreeing ones.
    expect(service.unversionedCheckedPaths()).toEqual([]);
    expect(service.getList(DEFAULT_LIST_ID)?.checked).toEqual(['new.txt']);
    expect(service.isChecked('new.txt')).toBe(true);
  });

  it('POST-QA: a file keeps its tick when it moves to another list', () => {
    const { service } = rig([modified('a.ts'), modified('b.ts'), untracked('new.txt')]);
    const other = service.create('Other');
    service.setChecked(['a.ts'], false);
    service.moveFiles(['a.ts', 'b.ts'], other.id);
    // Left out of the commit before the move, left out after it.
    expect(service.isChecked('a.ts')).toBe(false);
    expect(service.isChecked('b.ts')).toBe(true);
    expect(service.getList(other.id)?.checked).toEqual(['b.ts']);
    // An unticked new file moved out of Unversioned Files stays unticked too.
    service.moveFiles(['new.txt'], other.id);
    expect(service.isChecked('new.txt')).toBe(false);
    // And back again, still as the user left it.
    service.moveFiles(['a.ts'], DEFAULT_LIST_ID);
    expect(service.isChecked('a.ts')).toBe(false);
  });

  it('rehydrates from persisted storage', () => {
    const backing = new Map<string, unknown>();
    const storage: ChangelistStorage = {
      get: <T,>(k: string) => backing.get(k) as T | undefined,
      update: (k, v) => {
        backing.set(k, JSON.parse(JSON.stringify(v)));
      },
    };
    const model = new RepositoryModel('X:/repo');
    model.update({ statusEntries: [modified('a.ts')] });
    const s1 = new ChangelistService(model, storage, 'k');
    const l2 = s1.create('Persisted', 'hello', true);
    s1.moveFiles(['a.ts'], l2.id);
    s1.setChecked(['a.ts'], false);
    s1.dispose();

    const s2 = new ChangelistService(model, storage, 'k');
    const restored = s2.getList(l2.id);
    expect(restored?.name).toBe('Persisted');
    expect(restored?.comment).toBe('hello');
    expect(restored?.isActive).toBe(true);
    expect(restored?.files).toEqual(['a.ts']);
    expect(restored?.checked).toEqual([]);
  });

  it('listOf finds the owning list', () => {
    const { service } = rig([modified('a.ts')]);
    expect(service.listOf('a.ts')?.id).toBe(DEFAULT_LIST_ID);
    expect(service.listOf('nope.ts')).toBeUndefined();
  });
});
