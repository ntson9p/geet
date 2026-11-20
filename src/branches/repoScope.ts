/**
 * Which repository the Geet sidebar's Repositories and Branches sections
 * are showing (POST-P14u).
 *
 * **This is a view filter, not a mode.** It scopes those two sections and
 * nothing else: `Ctrl+K`, `Ctrl+T`, Push and every other command keep resolving
 * their own repository from the active editor exactly as before. Both
 * references work this way — VS Code's SCM selection filters its view while the
 * status-bar branch follows the active editor, and IntelliJ's log has a root
 * filter while its branch widget follows the editor. The alternative is worse
 * than either: wiring focus into *some* commands would let the sidebar name one
 * repository while `Ctrl+K` committed another, with nothing on screen to say
 * so. D27 already refuses to infer scope for branch operations; this refuses to
 * infer it for anything beyond the two sections that draw it.
 *
 * Deliberately free of `vscode` and of `Core`: it holds root strings, so the
 * resolution rules below are unit-testable without a window.
 */
import { canonicalKey } from '../core/repoDiscovery';
import { Emitter, type Event } from '../core/util/events';
import { repoLabels, sortRootsByLabel } from '../core/util/repoLabels';

/** Where the choice survives a reload. `workspaceState`, in the extension. */
export interface ScopeMemento {
  get(): string | undefined;
  set(value: string): void;
}

export class RepoScope {
  private readonly _onDidChange = new Emitter<void>();
  readonly onDidChange: Event<void> = this._onDidChange.event;

  /** Sorted by label — the order the sections render, and what `current` falls back through. */
  private roots: readonly string[] = [];
  private labels = new Map<string, string>();
  /** The user's pick, as a canonical key. Never cleared: there is no "no repository". */
  private explicit: string | undefined;
  private last: string | undefined;

  constructor(private readonly memento: ScopeMemento) {
    const stored = memento.get();
    this.explicit = stored !== undefined && stored.length > 0 ? stored : undefined;
  }

  /** Every root, in the order the user reads them. */
  get all(): readonly string[] {
    return this.roots;
  }

  label(root: string): string {
    return this.labels.get(root) ?? root;
  }

  /**
   * The focused root. An explicit pick wins while that repository is still
   * open; otherwise the first row, which is what the owner specified and what
   * a user can predict. It is never `undefined` while any repository is open —
   * "unfocus everything" would leave the Branches section with nothing to show
   * and no row to click to bring it back.
   */
  get current(): string | undefined {
    if (this.explicit !== undefined) {
      const found = this.roots.find((r) => canonicalKey(r) === this.explicit);
      if (found !== undefined) return found;
    }
    return this.roots[0];
  }

  isFocused(root: string): boolean {
    const current = this.current;
    return current !== undefined && canonicalKey(current) === canonicalKey(root);
  }

  /** Called as repositories join and leave; re-sorts and re-labels. */
  setRoots(roots: readonly string[]): void {
    this.roots = sortRootsByLabel(roots);
    this.labels = repoLabels(this.roots);
    this.settle();
  }

  focus(root: string): void {
    const found = this.roots.find((r) => canonicalKey(r) === canonicalKey(root));
    if (found === undefined) return;
    this.explicit = canonicalKey(found);
    this.memento.set(this.explicit);
    this.settle();
  }

  /**
   * Fire only when the *resolved* root moved. A repository joining below the
   * focused one changes the list without changing the answer, and the sections
   * that redraw on this event have no reason to.
   */
  private settle(): void {
    const now = this.current;
    const key = now === undefined ? undefined : canonicalKey(now);
    if (key === this.last) return;
    this.last = key;
    this._onDidChange.fire();
  }

  dispose(): void {
    this._onDidChange.dispose();
  }
}
