import { describe, expect, it, vi } from 'vitest';
import {
  everyRepoInView,
  normalizePick,
  picksOf,
  ReposInView,
  resolveInView,
  type ReposInViewMemento,
} from '../../../src/branches/reposInView';

/**
 * POST-P14ce. The repositories picked in the Repositories panel are one pick
 * for the side bar: the Commit window lists and commits only theirs. The rules
 * the panel always had, now kept by the host for both: picking none or every
 * one shows them all; a pick of repositories since closed shows them all
 * rather than none; the pick survives a reload; the panel's own old copy is
 * adopted once.
 */

/** Windows' rule, without the disk: case and slashes do not tell two roots apart. */
const keyOf = (root: string): string => root.replace(/\\/g, '/').toLowerCase();

const A = 'D:/w/api';
const B = 'D:/w/web';
const C = 'D:/w/docs';

const memento = (initial?: unknown): ReposInViewMemento & { value: unknown; writes: number } => ({
  value: initial,
  writes: 0,
  get() {
    return this.value;
  },
  set(next: readonly string[]) {
    this.value = [...next];
    this.writes += 1;
  },
});

function store(open: string[], initial?: unknown) {
  const kept = memento(initial);
  const roots = { open };
  const view = new ReposInView(kept, () => roots.open, keyOf);
  return { kept, roots, view };
}

describe('picksOf', () => {
  it('keeps each root once, in the order given, and drops what is not a root', () => {
    expect(picksOf([A, 'd:\\w\\API', B, '', 3, null], keyOf)).toEqual([A, B]);
    expect(picksOf(undefined, keyOf)).toEqual([]);
    expect(picksOf('D:/w/api', keyOf)).toEqual([]);
  });
});

describe('resolveInView', () => {
  it('shows the open repositories picked, in the order they are open', () => {
    expect(resolveInView([A, B, C], [C, A], keyOf)).toEqual({ inView: [A, C], narrowed: true });
  });

  it('shows every repository with nothing picked, every one picked, or only closed ones picked', () => {
    expect(resolveInView([A, B], [], keyOf)).toEqual({ inView: [A, B], narrowed: false });
    expect(resolveInView([A, B], [B, A], keyOf)).toEqual({ inView: [A, B], narrowed: false });
    expect(resolveInView([A, B], ['D:/w/gone'], keyOf)).toEqual({ inView: [A, B], narrowed: false });
  });

  it('never narrows one repository: there is nothing to leave out', () => {
    expect(resolveInView([A], [A], keyOf)).toEqual({ inView: [A], narrowed: false });
  });

  it('matches a pick to a root spelled otherwise', () => {
    expect(resolveInView([A, B], ['d:\\W\\Api'], keyOf)).toEqual({ inView: [A], narrowed: true });
  });
});

describe('normalizePick', () => {
  it('keeps nothing when the pick names every open repository', () => {
    expect(normalizePick([A, B], [B, A], keyOf)).toEqual([]);
    expect(normalizePick([A, B], [A, B, 'D:/w/gone'], keyOf)).toEqual([]);
    expect(normalizePick([A, B, C], [A, B], keyOf)).toEqual([A, B]);
  });
});

describe('ReposInView', () => {
  it('starts with every repository in view, and nothing kept', () => {
    const { view } = store([A, B, C]);
    expect(view.picked).toEqual([]);
    expect(view.snapshot().narrowed).toBe(false);
    expect(view.snapshot().roots).toEqual([A, B, C]);
    expect(view.snapshot().has(B)).toBe(true);
  });

  it('narrows to a pick, keeps it, and says who made it', () => {
    const { kept, view } = store([A, B, C]);
    const heard = vi.fn();
    view.onDidChange(heard);
    view.set([B], 'repositories');
    expect(view.picked).toEqual([B]);
    expect(kept.value).toEqual([B]);
    expect(heard).toHaveBeenCalledWith('repositories');
    const now = view.snapshot();
    expect(now).toMatchObject({ narrowed: true, roots: [B] });
    expect(now.has(B)).toBe(true);
    expect(now.has(A)).toBe(false);
    expect(now.has('d:\\w\\WEB')).toBe(true);
  });

  it('says which panel made a pick: the other one is told of it (POST-P14co)', () => {
    const { view } = store([A, B, C]);
    const heard: string[] = [];
    view.onDidChange((source) => heard.push(source));
    // The Branches panel's `@` picker, then a click in the Repositories panel.
    view.set([A, C], 'branches');
    view.set([B], 'repositories');
    view.clear('elsewhere');
    expect(heard).toEqual(['branches', 'repositories', 'elsewhere']);
  });

  it('shows every repository again on Show all, from anywhere', () => {
    const { kept, view } = store([A, B, C], [A]);
    const heard = vi.fn();
    view.onDidChange(heard);
    view.clear('elsewhere');
    expect(view.picked).toEqual([]);
    expect(kept.value).toEqual([]);
    expect(heard).toHaveBeenCalledWith('elsewhere');
    expect(view.snapshot().narrowed).toBe(false);
  });

  it('says nothing, and writes nothing, when the pick does not change', () => {
    const { kept, view } = store([A, B, C], [A]);
    const heard = vi.fn();
    view.onDidChange(heard);
    view.set([A], 'repositories');
    expect(heard).not.toHaveBeenCalled();
    expect(kept.writes).toBe(0);
  });

  it('keeps every open repository picked as none', () => {
    const { kept, view } = store([A, B]);
    view.set([A, B], 'branches');
    expect(view.picked).toEqual([]);
    expect(kept.value).toEqual([]);
  });

  it('survives a reload', () => {
    const first = store([A, B, C]);
    first.view.set([C, A], 'branches');
    const again = new ReposInView(first.kept, () => [A, B, C], keyOf);
    expect(again.picked).toEqual([C, A]);
    expect(again.snapshot().roots).toEqual([A, C]);
  });

  it("gives the pick in the open repositories' spelling, and keeps a closed one's place", () => {
    const { roots, view } = store([A, B, C], ['d:\\w\\api', 'D:/w/gone']);
    expect(view.picked).toEqual([A, 'D:/w/gone']);
    // The closed one opens again: the pick narrows to both.
    roots.open = [A, B, C, 'D:/w/gone'];
    expect(view.snapshot().roots).toEqual([A, 'D:/w/gone']);
  });

  it('shows every repository while each one picked is closed, and narrows again when one opens', () => {
    const { roots, view } = store([A, B], ['D:/w/gone']);
    expect(view.snapshot().narrowed).toBe(false);
    roots.open = [A, B, 'D:/w/gone'];
    expect(view.snapshot()).toMatchObject({ narrowed: true, roots: ['D:/w/gone'] });
  });

  it("adopts the panel's own old pick once, when nothing is kept yet", () => {
    const { kept, view } = store([A, B, C]);
    const heard = vi.fn();
    view.onDidChange(heard);
    view.adoptLegacy([B]);
    expect(view.picked).toEqual([B]);
    expect(kept.value).toEqual([B]);
    expect(heard).toHaveBeenCalledWith('elsewhere');
    // Kept now: a second old copy is not taken.
    view.adoptLegacy([C]);
    expect(view.picked).toEqual([B]);
  });

  it("does not adopt the panel's old pick over one kept, even an empty one", () => {
    const shown = store([A, B, C], []);
    shown.view.adoptLegacy([B]);
    expect(shown.view.picked).toEqual([]);
    // Show all said before the panel ever opened: kept, so no old pick comes back.
    const cleared = store([A, B, C]);
    cleared.view.clear('elsewhere');
    cleared.view.adoptLegacy([B]);
    expect(cleared.view.picked).toEqual([]);
    expect(cleared.kept.value).toEqual([]);
  });

  it('adopts nothing from an old copy that picked nothing', () => {
    const { kept, view } = store([A, B]);
    view.adoptLegacy([]);
    view.adoptLegacy(undefined);
    expect(kept.writes).toBe(0);
    expect(view.picked).toEqual([]);
  });

  it('asks the disk for a root once', () => {
    const asked = vi.fn(keyOf);
    const view = new ReposInView(memento([A]), () => [A, B, C], asked);
    expect(view.snapshot().has(B)).toBe(false);
    expect(view.snapshot().roots).toEqual([A]);
    expect(view.picked).toEqual([A]);
    expect(asked.mock.calls.map(([root]) => root).sort()).toEqual([A, B, C].sort());
  });
});

describe('everyRepoInView', () => {
  it('never narrows, whatever is asked of it', () => {
    const open = [A, B];
    const view = everyRepoInView(() => open);
    view.clear('elsewhere');
    expect(view.snapshot()).toMatchObject({ narrowed: false, roots: [A, B] });
    expect(view.snapshot().has('anything')).toBe(true);
  });
});
