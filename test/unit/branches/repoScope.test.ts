import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RepoScope, type ScopeMemento } from '../../../src/branches/repoScope';

/**
 * POST-P14u. The owner's rules for the Repositories section, stated as tests:
 * one repository is focused, the first by default, the choice survives a
 * reload, and **there is no way to focus nothing** — an empty Branches section
 * with no row to click would be a dead end.
 */
const memento = (initial?: string): ScopeMemento & { value: string | undefined } => ({
  value: initial,
  get() {
    return this.value;
  },
  set(next: string) {
    this.value = next;
  },
});

const A = '/w/alpha';
const B = '/w/bravo';
const C = '/w/charlie';

describe('RepoScope', () => {
  let store: ReturnType<typeof memento>;
  let scope: RepoScope;

  beforeEach(() => {
    store = memento();
    scope = new RepoScope(store);
  });

  it('has nothing to show before any repository is open', () => {
    expect(scope.current).toBeUndefined();
  });

  it('defaults to the first row, and rows are ordered by name not by arrival', () => {
    scope.setRoots([C, A, B]);
    expect(scope.all).toEqual([A, B, C]);
    expect(scope.current).toBe(A);
    expect(scope.isFocused(A)).toBe(true);
    expect(scope.isFocused(C)).toBe(false);
  });

  it('keeps an explicit pick, and remembers it for the next window', () => {
    scope.setRoots([A, B, C]);
    scope.focus(C);
    expect(scope.current).toBe(C);
    expect(store.value).toBeDefined();

    const reopened = new RepoScope(store);
    reopened.setRoots([A, B, C]);
    expect(reopened.current).toBe(C);
  });

  it('ignores a pick for a repository that is not open', () => {
    scope.setRoots([A, B]);
    scope.focus('/w/not-open');
    expect(scope.current).toBe(A);
  });

  it('falls back to the first row when the focused repository leaves', () => {
    scope.setRoots([A, B, C]);
    scope.focus(C);
    scope.setRoots([A, B]);
    expect(scope.current).toBe(A);
    // …and returns to the pick if that repository comes back, because the
    // choice was never withdrawn — only the repository was.
    scope.setRoots([A, B, C]);
    expect(scope.current).toBe(C);
  });

  it('never leaves every repository unfocused', () => {
    scope.setRoots([A, B]);
    scope.focus(B);
    scope.focus(B);
    expect(scope.current).toBe(B);
    // There is deliberately no `clear()`; the only way to have no focus is to
    // have no repositories.
    scope.setRoots([]);
    expect(scope.current).toBeUndefined();
    scope.setRoots([A]);
    expect(scope.current).toBe(A);
  });

  it('fires only when the answer moved, not whenever the list did', () => {
    const listener = vi.fn();
    scope.setRoots([A, B]);
    scope.onDidChange(listener);
    listener.mockClear();

    // A repository joining below the focused one changes the list without
    // changing what the sections draw — redrawing them would be wasted work.
    scope.setRoots([A, B, C]);
    expect(listener).not.toHaveBeenCalled();

    scope.focus(C);
    expect(listener).toHaveBeenCalledTimes(1);

    // Re-focusing the same repository is not a change either.
    scope.focus(C);
    expect(listener).toHaveBeenCalledTimes(1);

    // Losing it is.
    scope.setRoots([A, B]);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('labels collide-free, from the same rule every other root list uses', () => {
    scope.setRoots(['/w/web/api', '/w/mobile/api']);
    expect(scope.label('/w/web/api')).toBe('web/api');
    scope.setRoots([A, B]);
    expect(scope.label(A)).toBe('alpha');
  });
});
