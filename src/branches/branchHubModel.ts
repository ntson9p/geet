/**
 * Shape of the Branches view (POST-P14u), with no `vscode` in sight so the
 * ordering rules can be tested without a window.
 *
 * The sections, their order and their membership are **the branches popup's**,
 * lifted out of `buildPopupItems` so the two surfaces answer the same question
 * the same way: Current, Favorites, Recent, Local, one section per remote, Tags.
 * Favorites and Recent stay flat — they are short curated lists where a folder
 * row would hide the very branch someone pinned.
 *
 * The one deliberate difference is nesting. The popup fakes `feature/` with
 * drill-in because a `QuickPick` cannot render a collapsible tree, which is
 * **deviation D5**; a tree can, so here `feature/` is a real expandable node and
 * D5 does not apply to this surface.
 */
import type { RefInfo } from '../core/model/refs';

export type HubSectionKind = 'current' | 'favorites' | 'recent' | 'local' | 'remote' | 'tags';

export interface HubSection {
  /** Stable node identity, also the expansion-memory key. */
  readonly id: string;
  readonly kind: HubSectionKind;
  /** Set on `kind: 'remote'`. */
  readonly remote?: string;
  readonly refs: readonly RefInfo[];
  /** Curated lists never folderize. */
  readonly flat: boolean;
}

export interface HubInput {
  readonly current: RefInfo | undefined;
  readonly locals: readonly RefInfo[];
  readonly remotes: readonly RefInfo[];
  readonly tags: readonly RefInfo[];
  /** Reflog-derived recent branch names, best first. */
  readonly recent: readonly string[];
  readonly favorites: ReadonlySet<string>;
}

export function hubSections(input: HubInput): HubSection[] {
  const sections: HubSection[] = [];
  const push = (
    id: string,
    kind: HubSectionKind,
    refs: readonly RefInfo[],
    flat: boolean,
    remote?: string,
  ): void => {
    if (refs.length === 0) return;
    sections.push({ id, kind, refs, flat, ...(remote !== undefined ? { remote } : {}) });
  };

  if (input.current) push('@current', 'current', [input.current], true);

  const favorites = input.locals.filter((b) => input.favorites.has(b.name) && b.isHead !== true);
  push('@favorites', 'favorites', favorites, true);

  const recent = input.recent
    .map((name) => input.locals.find((b) => b.name === name))
    .filter((b): b is RefInfo => b !== undefined && b.isHead !== true && !input.favorites.has(b.name));
  push('@recent', 'recent', recent, true);

  push(
    '@local',
    'local',
    input.locals.filter((b) => b.isHead !== true),
    false,
  );

  const byRemote = new Map<string, RefInfo[]>();
  for (const ref of input.remotes) {
    const key = ref.remote ?? '';
    const list = byRemote.get(key);
    if (list) list.push(ref);
    else byRemote.set(key, [ref]);
  }
  for (const [remote, refs] of [...byRemote.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    push(`@remote:${remote}`, 'remote', refs, false, remote);
  }

  push('@tags', 'tags', input.tags, false);
  return sections;
}

export interface HubFolder {
  /** The prefix this folder stands for, with its trailing slash (`feature/`). */
  readonly prefix: string;
  /** The segment shown as the row's label. */
  readonly name: string;
  readonly count: number;
}

export interface HubLevel {
  readonly folders: readonly HubFolder[];
  readonly refs: readonly RefInfo[];
}

/** Everything before the next `/` under `prefix`, or `undefined` if none. */
export function segmentOf(name: string, prefix: string): string | undefined {
  if (!name.startsWith(prefix)) return undefined;
  const rest = name.slice(prefix.length);
  const slash = rest.indexOf('/');
  return slash === -1 ? undefined : rest.slice(0, slash);
}

/**
 * One level of a section: the folders directly under `prefix`, then the refs
 * that sit in it. A ref not under `prefix` at all belongs to no level and is
 * dropped — `prefix` is always one this section produced, so that only happens
 * when the refs moved under a node that is still expanded.
 */
export function hubLevel(refs: readonly RefInfo[], prefix: string, flat: boolean): HubLevel {
  const scoped = refs.filter((r) => r.name.startsWith(prefix));
  if (flat) return { folders: [], refs: scoped };
  const counts = new Map<string, number>();
  const direct: RefInfo[] = [];
  for (const ref of scoped) {
    const segment = segmentOf(ref.name, prefix);
    if (segment === undefined) direct.push(ref);
    else counts.set(segment, (counts.get(segment) ?? 0) + 1);
  }
  const folders = [...counts.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([name, count]) => ({ prefix: `${prefix}${name}/`, name, count }));
  return { folders, refs: direct };
}
