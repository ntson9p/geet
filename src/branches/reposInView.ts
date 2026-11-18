/**
 * The repositories in view (POST-P14ce): the ones picked in the Repositories
 * panel. The Commit window lists only their changes and commits only them, so
 * the pick is one for the whole side bar, kept for the workspace.
 *
 * **A filter a commit may follow, because it is on screen where commits are
 * made.** POST-P14u (`repoScope.ts`) kept a side-bar pick from changing what a
 * command does, since nothing on screen would have said so. This pick is said
 * where it matters: a bar over the Commit window's list names the repositories
 * it shows, counts what it leaves out and has Show all, and the Commit button
 * names what it commits. The commands that commit "what is ticked" (Commit,
 * Commit and Push, Ctrl+K) commit what that list shows; every other command
 * keeps finding its repository as before.
 *
 * Vscode-free: roots in, roots out, the memento behind an interface, so every
 * rule is unit-tested.
 */
import { canonicalKey } from '../core/repoDiscovery';
import { Emitter, type Event } from '../core/util/events';

/** Where the pick survives a reload: `workspaceState`, in the extension. */
export interface ReposInViewMemento {
  get(): unknown;
  set(value: readonly string[]): void;
}

/**
 * Who changed the pick: one of the side bar's two panels (POST-P14co: the
 * Repositories panel's click, the Branches panel's `@` picker and pill), or
 * anywhere else (the Commit window). A panel already shows a pick it made
 * itself; one made anywhere else it is told of.
 */
export type ReposInViewSource = 'repositories' | 'branches' | 'elsewhere';

/** What the repositories in view are at one moment. */
export interface InViewSnapshot {
  /** Some open repositories are left out. Never with one repository: there is nothing to leave out. */
  readonly narrowed: boolean;
  /** The open repositories in view, in the order the open ones were given; every one when not narrowed. */
  readonly roots: readonly string[];
  /** Whether a repository is in view: every one is when not narrowed. */
  has(root: string): boolean;
}

/** What the Commit window reads of the pick, and its one way to change it. */
export interface ReposInViewReader {
  readonly onDidChange: Event<ReposInViewSource>;
  snapshot(): InViewSnapshot;
  clear(source: ReposInViewSource): void;
}

type KeyOf = (root: string) => string;

/** A pick as stored: each repository's root once, in the order given; anything else is no pick. */
export function picksOf(raw: unknown, keyOf: KeyOf = canonicalKey): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const root of raw) {
    if (typeof root !== 'string' || root.length === 0) continue;
    const key = keyOf(root);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(root);
  }
  return out;
}

/**
 * The open repositories in view, in the order given: the ones picked, while
 * any of them is open; every one otherwise. A pick of repositories since closed
 * shows them all rather than none, as the Repositories panel always has
 * (`scopeReposOf`). Picking every open one is showing them all.
 */
export function resolveInView(
  open: readonly string[],
  picks: readonly string[],
  keyOf: KeyOf = canonicalKey,
): { readonly inView: string[]; readonly narrowed: boolean } {
  const wanted = new Set(picks.map(keyOf));
  const kept = open.filter((root) => wanted.has(keyOf(root)));
  if (kept.length === 0 || kept.length >= open.length) return { inView: [...open], narrowed: false };
  return { inView: kept, narrowed: true };
}

/**
 * What to keep of a pick: each repository once, and nothing when it names every
 * open repository. Picking them all is showing them all, and must not stay a
 * pick that narrows the list the day another repository opens; the panel's
 * Ctrl+click makes the same rule.
 */
export function normalizePick(open: readonly string[], roots: readonly unknown[], keyOf: KeyOf = canonicalKey): string[] {
  const picks = picksOf(roots, keyOf);
  const keys = new Set(picks.map(keyOf));
  return open.length > 0 && open.every((root) => keys.has(keyOf(root))) ? [] : picks;
}

export class ReposInView implements ReposInViewReader {
  private readonly _onDidChange = new Emitter<ReposInViewSource>();
  readonly onDidChange: Event<ReposInViewSource> = this._onDidChange.event;

  private picks: string[];
  /** A pick was kept here, even an empty one: from then on the panel's own old copy is not adopted. */
  private kept: boolean;
  /** Roots' keys: `canonicalKey` asks the disk, and the state pushes ask for every repository. */
  private readonly keys = new Map<string, string>();

  constructor(
    private readonly memento: ReposInViewMemento,
    private readonly openRoots: () => readonly string[],
    private readonly keyOf: KeyOf = canonicalKey,
  ) {
    const raw = memento.get();
    this.kept = raw !== undefined;
    this.picks = picksOf(raw, (root) => this.key(root));
  }

  private key(root: string): string {
    let key = this.keys.get(root);
    if (key === undefined) {
      key = this.keyOf(root);
      this.keys.set(root, key);
    }
    return key;
  }

  /**
   * The pick as the Repositories panel draws it: each root as the open
   * repository spells it, so the panel's own comparisons hold; none for every
   * repository. A picked repository that is closed keeps its place, as before.
   */
  get picked(): string[] {
    const byKey = new Map(this.openRoots().map((root) => [this.key(root), root]));
    return this.picks.map((root) => byKey.get(this.key(root)) ?? root);
  }

  snapshot(): InViewSnapshot {
    const { inView, narrowed } = resolveInView(this.openRoots(), this.picks, (root) => this.key(root));
    const keys = new Set(inView.map((root) => this.key(root)));
    return {
      narrowed,
      roots: inView,
      has: (root) => !narrowed || keys.has(this.key(root)),
    };
  }

  /** Picks these repositories; none, or every one, shows them all. */
  set(roots: readonly unknown[], source: ReposInViewSource): void {
    const next = normalizePick(this.openRoots(), roots, (root) => this.key(root));
    const same = next.length === this.picks.length && next.every((root, i) => root === this.picks[i]);
    if (same && this.kept) return;
    this.picks = next;
    this.kept = true;
    this.memento.set([...next]);
    if (!same) this._onDidChange.fire(source);
  }

  /** Every repository in view again: the Commit window's Show all, and the panel's. */
  clear(source: ReposInViewSource): void {
    this.set([], source);
  }

  /**
   * Before POST-P14ce the Repositories panel kept its pick in its own webview
   * state. The first time it opens since, that pick is adopted, once; from then
   * on it is kept here, and the panel's copy goes.
   */
  adoptLegacy(raw: unknown): void {
    if (this.kept) return;
    const picks = picksOf(raw, (root) => this.key(root));
    if (picks.length > 0) this.set(picks, 'elsewhere');
  }

  dispose(): void {
    this._onDidChange.dispose();
  }
}

/** A pick that is never made: every repository in view. For a window built without the Repositories panel. */
export function everyRepoInView(openRoots: () => readonly string[]): ReposInViewReader {
  return {
    onDidChange: () => ({ dispose: () => undefined }),
    snapshot: () => ({ narrowed: false, roots: [...openRoots()], has: () => true }),
    clear: () => undefined,
  };
}
