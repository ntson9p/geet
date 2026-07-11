/**
 * ChangelistService (P3-T2): the IntelliJ changelist model. Invariants:
 * exactly one default list, exactly one active list, a tracked-dirty file
 * belongs to exactly one list; new dirty files land in the ACTIVE list;
 * untracked files live in the virtual "Unversioned Files" bucket until moved
 * into a real list. Membership + checkbox state persist in workspaceState
 * and reconcile against every status refresh.
 *
 * vscode-free (storage injected) — unit-tested against a plain model.
 * Hunk-granularity moves are out of scope v1 (documented deviation).
 */
import type { RepositoryModel } from '../../core/model/repositoryModel';
import { isConflicted, isUntracked, type StatusEntry } from '../../core/model/statusEntry';
import { Emitter, type Disposable, type Event } from '../../core/util/events';

export interface ChangelistStorage {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): PromiseLike<void> | void;
}

interface PersistedList {
  id: string;
  name: string;
  comment?: string;
  isDefault: boolean;
  isActive: boolean;
  files: string[];
  unchecked: string[];
}

export interface Changelist {
  id: string;
  name: string;
  comment?: string;
  isDefault: boolean;
  isActive: boolean;
  /** Repo-relative paths, present in the current status. */
  files: string[];
  /** Subset of files currently checked for commit. */
  checked: string[];
}

export const DEFAULT_LIST_ID = 'default';
export const UNVERSIONED_ID = '__unversioned__';

export class ChangelistService implements Disposable {
  private lists: PersistedList[] = [];
  private readonly _onDidChange = new Emitter<void>();
  readonly onDidChange: Event<void> = this._onDidChange.event;
  private readonly modelSub: Disposable;

  constructor(
    private readonly model: RepositoryModel,
    private readonly storage: ChangelistStorage,
    private readonly storageKey: string,
  ) {
    this.lists = this.load();
    this.reconcile(false);
    this.modelSub = model.onDidChange((sections) => {
      if (sections.has('status')) this.reconcile(true);
    });
  }

  private load(): PersistedList[] {
    const raw = this.storage.get<PersistedList[]>(this.storageKey);
    if (Array.isArray(raw) && raw.length > 0) return raw.map((l) => ({ ...l }));
    return [
      {
        id: DEFAULT_LIST_ID,
        name: 'Changes',
        isDefault: true,
        isActive: true,
        files: [],
        unchecked: [],
      },
    ];
  }

  private persist(): void {
    void this.storage.update(this.storageKey, this.lists);
  }

  /** Tracked, dirty, non-conflicted entries — the changelist universe. */
  private trackedDirtyPaths(): Set<string> {
    const paths = new Set<string>();
    for (const e of this.model.snapshot.statusEntries) {
      if (isUntracked(e) || e.kind === 'ignored' || isConflicted(e)) continue;
      paths.add(e.path);
    }
    return paths;
  }

  /** Untracked paths not adopted into a list. */
  unversioned(): string[] {
    const adopted = new Set(this.lists.flatMap((l) => l.files));
    return this.model.snapshot.statusEntries
      .filter((e) => isUntracked(e))
      .map((e) => e.path)
      .filter((p) => !adopted.has(p));
  }

  /** Untracked paths that WERE moved into lists (need add -N at commit). */
  isUntrackedPath(relPath: string): boolean {
    return this.model.snapshot.statusEntries.some((e) => isUntracked(e) && e.path === relPath);
  }

  statusEntry(relPath: string): StatusEntry | undefined {
    return this.model.snapshot.statusEntries.find((e) => e.path === relPath);
  }

  /**
   * Reconciliation (P3-T2 step 2): drop vanished files, adopt new tracked
   * dirty files into the active list (checked by default).
   */
  reconcile(fire: boolean): void {
    const universe = this.trackedDirtyPaths();
    const untracked = new Set(
      this.model.snapshot.statusEntries.filter((e) => isUntracked(e)).map((e) => e.path),
    );
    let changed = false;
    const seen = new Set<string>();
    for (const list of this.lists) {
      const before = list.files.length;
      // A file stays if still dirty-tracked, or still untracked (adopted).
      list.files = list.files.filter((p) => {
        if (seen.has(p)) return false; // exactly-one-list invariant
        const keep = universe.has(p) || untracked.has(p);
        if (keep) seen.add(p);
        return keep;
      });
      list.unchecked = list.unchecked.filter((p) => list.files.includes(p));
      if (list.files.length !== before) changed = true;
    }
    // Adopt new tracked-dirty files into the active list.
    const active = this.activeList();
    for (const p of universe) {
      if (!seen.has(p)) {
        active.files.push(p);
        seen.add(p);
        changed = true;
      }
    }
    if (changed) {
      this.persist();
      if (fire) this._onDidChange.fire();
    }
  }

  private activeList(): PersistedList {
    return this.lists.find((l) => l.isActive) ?? (this.lists[0] as PersistedList);
  }

  getLists(): Changelist[] {
    return this.lists.map((l) => ({
      id: l.id,
      name: l.name,
      ...(l.comment !== undefined ? { comment: l.comment } : {}),
      isDefault: l.isDefault,
      isActive: l.isActive,
      files: [...l.files],
      checked: l.files.filter((f) => !l.unchecked.includes(f)),
    }));
  }

  getList(id: string): Changelist | undefined {
    return this.getLists().find((l) => l.id === id);
  }

  create(name: string, comment?: string, makeActive = false): Changelist {
    const id = `cl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    const list: PersistedList = {
      id,
      name,
      ...(comment !== undefined ? { comment } : {}),
      isDefault: false,
      isActive: false,
      files: [],
      unchecked: [],
    };
    this.lists.push(list);
    if (makeActive) this.setActiveInternal(id);
    this.persist();
    this._onDidChange.fire();
    return this.getList(id) as Changelist;
  }

  rename(id: string, name: string, comment?: string): void {
    const list = this.lists.find((l) => l.id === id);
    if (!list) return;
    list.name = name;
    if (comment !== undefined) list.comment = comment;
    this.persist();
    this._onDidChange.fire();
  }

  /** Removes a list; its files move to `moveFilesTo` (default list if omitted). */
  remove(id: string, moveFilesTo?: string): void {
    const list = this.lists.find((l) => l.id === id);
    if (!list || list.isDefault) return;
    const target =
      this.lists.find((l) => l.id === moveFilesTo && l.id !== id) ??
      this.lists.find((l) => l.isDefault);
    if (target) {
      target.files.push(...list.files);
      target.unchecked.push(...list.unchecked);
    }
    const wasActive = list.isActive;
    this.lists = this.lists.filter((l) => l.id !== id);
    if (wasActive) this.setActiveInternal((this.lists.find((l) => l.isDefault) as PersistedList).id);
    this.persist();
    this._onDidChange.fire();
  }

  setActive(id: string): void {
    this.setActiveInternal(id);
    this.persist();
    this._onDidChange.fire();
  }

  private setActiveInternal(id: string): void {
    for (const l of this.lists) l.isActive = l.id === id;
    if (!this.lists.some((l) => l.isActive)) {
      (this.lists.find((l) => l.isDefault) as PersistedList).isActive = true;
    }
  }

  /** Moves files (tracked or untracked) into a list, enforcing exactly-one-list. */
  moveFiles(relPaths: readonly string[], targetId: string): void {
    const target = this.lists.find((l) => l.id === targetId);
    if (!target) return;
    for (const list of this.lists) {
      if (list.id === targetId) continue;
      list.files = list.files.filter((p) => !relPaths.includes(p));
      list.unchecked = list.unchecked.filter((p) => !relPaths.includes(p));
    }
    for (const p of relPaths) {
      if (!target.files.includes(p)) target.files.push(p);
    }
    this.persist();
    this._onDidChange.fire();
  }

  setChecked(relPaths: readonly string[], checked: boolean): void {
    let changed = false;
    for (const list of this.lists) {
      for (const p of relPaths) {
        if (!list.files.includes(p)) continue;
        const idx = list.unchecked.indexOf(p);
        if (checked && idx !== -1) {
          list.unchecked.splice(idx, 1);
          changed = true;
        } else if (!checked && idx === -1) {
          list.unchecked.push(p);
          changed = true;
        }
      }
    }
    if (changed) {
      this.persist();
      this._onDidChange.fire();
    }
  }

  setListChecked(id: string, checked: boolean): void {
    const list = this.lists.find((l) => l.id === id);
    if (!list) return;
    list.unchecked = checked ? [] : [...list.files];
    this.persist();
    this._onDidChange.fire();
  }

  listOf(relPath: string): Changelist | undefined {
    const owner = this.lists.find((l) => l.files.includes(relPath));
    return owner ? this.getList(owner.id) : undefined;
  }

  dispose(): void {
    this.modelSub.dispose();
    this._onDidChange.dispose();
  }
}
