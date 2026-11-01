/**
 * One expandable tree behind both branch surfaces (new-way-2).
 *
 * **What changed and why.** The popup used to *drill in*: picking a repository
 * or a folder replaced the whole list and added a `‹ Back` row, so every step
 * deeper threw away what you were looking at. IntelliJ never does that — its
 * levels are a tree you open in place, with `˅`/`›` on the rows that have
 * children. This module is that tree, and **both** surfaces render it: the
 * popup flattens it against its own expansion set, the sidebar view hands the
 * same rows to VS Code and lets the tree widget expand them. Neither surface
 * decides anything about content, so they cannot come to disagree.
 *
 * VS Code gives no way to float a cascading submenu beside a `QuickPick`, which
 * is what deviation D5 records. What it does allow is indentation and
 * disclosure markers in a single list, so in the popup a level opens
 * **underneath** its parent rather than on top of it. In the sidebar the tree
 * widget does it properly. The only step that still changes surface is a ref's
 * action menu, because that is a menu and not a level.
 *
 * Nothing here imports `vscode`.
 */
import type { RefInfo } from '../core/model/refs';

// ---------------------------------------------------------------------------
// Verbs — the rows above the repositories.
// ---------------------------------------------------------------------------

export interface HubVerb {
  readonly command: string;
  readonly label: string;
  readonly accelerator?: string;
  readonly icon: string;
  /** Extra words the search should match (`merge` finding Update Project). */
  readonly keywords?: string;
  /** Verbs that act on the project sit above the rule; the rest below it. */
  readonly group: 'project' | 'branch';
}

export const HUB_VERBS: readonly HubVerb[] = [
  {
    command: 'gittree.update.dialog',
    label: 'Update Project…',
    accelerator: 'Ctrl+T',
    icon: 'arrow-down',
    keywords: 'pull fetch merge rebase update',
    group: 'project',
  },
  {
    command: 'gittree.commit',
    label: 'Commit…',
    accelerator: 'Ctrl+K',
    icon: 'git-commit',
    keywords: 'commit stage',
    group: 'project',
  },
  {
    command: 'gittree.push.dialog',
    label: 'Push…',
    accelerator: 'Ctrl+Shift+K',
    icon: 'arrow-up',
    keywords: 'push upload',
    group: 'project',
  },
  {
    command: 'gittree.branch.new',
    label: 'New Branch…',
    accelerator: 'Ctrl+Alt+N',
    icon: 'add',
    keywords: 'branch create new',
    group: 'branch',
  },
  {
    command: 'gittree.branches.checkoutRevision',
    label: 'Checkout Tag or Revision…',
    icon: 'tag',
    keywords: 'checkout tag revision detach',
    group: 'branch',
  },
];

/**
 * A ref name every root carries, which is what makes it actionable across all
 * of them. IntelliJ calls these `Common Local Branches` / `Common Remote
 * Branches` / `Common Tags`.
 */
export interface CommonRef {
  readonly name: string;
  readonly kind: 'local' | 'remote' | 'tag';
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

export interface RepoRefs {
  readonly root: string;
  /** Folder name, disambiguated — what the row says. */
  readonly name: string;
  readonly currentBranch?: string;
  readonly detached?: boolean;
  readonly headSha?: string;
  readonly ahead?: number;
  readonly behind?: number;
  readonly locals: readonly RefInfo[];
  readonly remotes: readonly RefInfo[];
  readonly tags: readonly RefInfo[];
  readonly favorites: ReadonlySet<string>;
}

export interface TreeContext {
  readonly repos: readonly RepoRefs[];
  readonly commonLocals: readonly string[];
  readonly commonRemotes: readonly string[];
  readonly commonTags: readonly string[];
  readonly showInOut: boolean;
}

/**
 * IntelliJ's **Show Tags** turned off (`gittree.branches.showTags`): the context
 * every branch surface builds from loses its tags, and with them the `Tags` and
 * `Common Tags` nodes, which are only drawn when non-empty, and the tag hits in
 * a search. Cutting them here, once, keeps the popup and both sidebar trees from
 * disagreeing about what the setting means.
 */
export function applyShowTags(ctx: TreeContext, showTags: boolean): TreeContext {
  if (showTags) return ctx;
  return {
    ...ctx,
    repos: ctx.repos.map((repo) => ({ ...repo, tags: [] })),
    commonTags: [],
  };
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

/**
 * `info` is a line of text — the "no matches" row — and does nothing when
 * picked. `search` is the sidebar's per-repository search box: IntelliJ gives
 * an opened repository its own panel with its own field, and the sidebar draws
 * that field inline under the repository row, because a webview can hold an
 * `<input>` where a `QuickPick` and a `TreeView` cannot.
 */
export type RowKind = 'verb' | 'group' | 'repo' | 'ref' | 'common' | 'info' | 'search';
export type SectionKey = 'local' | 'remote' | 'tag';

export interface TreeRow {
  /** Stable identity. The popup keys expansion by it; the tree uses it as `TreeItem.id`. */
  readonly id: string;
  readonly kind: RowKind;
  /** Depth is only meaningful in the flattened popup list. */
  readonly depth: number;
  /** Codicon name, without the `$(…)`. */
  readonly icon: string;
  readonly label: string;
  readonly description?: string;
  readonly expandable: boolean;
  /** Shows the `›` affordance and opens the ref's action menu. */
  readonly actions: boolean;
  readonly searchText: string;
  /** A separator rendered immediately above this row (popup only). */
  readonly separator?: string;
  readonly verb?: HubVerb;
  readonly repoRoot?: string;
  readonly ref?: RefInfo;
  readonly favorite?: boolean;
  readonly common?: CommonRef;
  /** Set on group rows, so children can be recomputed from the row alone. */
  readonly section?: SectionKey;
  readonly prefix?: string;
  readonly commonKind?: CommonRef['kind'];
  /**
   * A repository row whose Fetch, started from the Branches section's menu, is
   * still running: the view spins its icon. Never set by the builders here.
   */
  readonly busy?: boolean;
}

// ---------------------------------------------------------------------------
// Node ids
// ---------------------------------------------------------------------------

export const nodeIds = {
  /** A verb at the project level, or the same verb scoped to one repository. */
  verb: (command: string, root?: string): string =>
    root === undefined ? `verb:${command}` : `verb:${command}|${root}`,
  repo: (root: string): string => `repo:${root}`,
  section: (root: string, section: SectionKey): string => `repo:${root}|${section}`,
  folder: (root: string, section: SectionKey, prefix: string): string =>
    `repo:${root}|${section}|${prefix}`,
  common: (kind: CommonRef['kind']): string => `common:${kind}`,
  /** Convenience for callers that want a repository's local-branch list open. */
  locals: (root: string): string => `repo:${root}|local`,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Everything before the next `/` under `prefix`, or `undefined` if none. */
export function segmentOf(name: string, prefix: string): string | undefined {
  if (!name.startsWith(prefix)) return undefined;
  const rest = name.slice(prefix.length);
  const slash = rest.indexOf('/');
  return slash === -1 ? undefined : rest.slice(0, slash);
}

export interface FolderBucket {
  readonly prefix: string;
  readonly name: string;
  readonly count: number;
}

/** The folders directly under `prefix`, then the refs that sit in it. */
export function splitLevel(
  refs: readonly RefInfo[],
  prefix: string,
): { folders: FolderBucket[]; refs: RefInfo[] } {
  const scoped = refs.filter((r) => r.name.startsWith(prefix));
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

function cap(n: number | undefined): string {
  const value = n ?? 0;
  return value > 99 ? '99+' : String(value);
}

/** `↓99+ ↑99+  origin/develop` — the dim half of a ref row. */
export function refDescription(ref: RefInfo, showInOut: boolean): string {
  const parts: string[] = [];
  if (showInOut) {
    if ((ref.behind ?? 0) > 0) parts.push(`↓${cap(ref.behind)}`);
    if ((ref.ahead ?? 0) > 0) parts.push(`↑${cap(ref.ahead)}`);
  }
  if (ref.upstreamGone === true) parts.push('upstream gone');
  else if (ref.upstream !== undefined) parts.push(ref.upstream);
  return parts.join('  ');
}

/**
 * The glyph a ref row leads with. Current wins over favourite wins over type.
 * Remote branches take the branch glyph, as IntelliJ draws them: they sit under
 * `Remote Branches` and an `origin` folder, and in a flat search their label
 * keeps its `origin/` prefix, so a cloud would only repeat what is written.
 */
export function refIcon(ref: RefInfo, favorite: boolean): string {
  if (ref.isHead === true) return 'check';
  if (favorite) return 'star-full';
  if (ref.type === 'tag') return 'tag';
  return 'git-branch';
}

/** Favourites first, then the rest, each alphabetical. IntelliJ's order. */
export function orderRefs(refs: readonly RefInfo[], favorites: ReadonlySet<string>): RefInfo[] {
  return [...refs].sort((a, b) => {
    const fa = favorites.has(a.name) ? 0 : 1;
    const fb = favorites.has(b.name) ? 0 : 1;
    return fa - fb || a.name.localeCompare(b.name);
  });
}

/** `develop  ↓238` — the dim half of a repository row. */
export function repoDescription(repo: RepoRefs, showInOut: boolean): string {
  const parts: string[] = [];
  if (repo.detached === true) parts.push(`detached at ${(repo.headSha ?? '').slice(0, 7)}`);
  else parts.push(repo.currentBranch ?? 'no branch');
  if (showInOut) {
    if ((repo.behind ?? 0) > 0) parts.push(`↓${cap(repo.behind)}`);
    if ((repo.ahead ?? 0) > 0) parts.push(`↑${cap(repo.ahead)}`);
  }
  return parts.join('  ');
}

/**
 * Names carried by every one of `perRepo`, sorted. An empty workspace, or one
 * root with no refs of that kind, yields nothing — "common to all" of an empty
 * set would otherwise be "everything the others have".
 */
export function commonRefNames(perRepo: readonly (readonly string[])[]): string[] {
  const [first, ...rest] = perRepo;
  if (first === undefined || perRepo.length === 0) return [];
  const shared = new Set(first);
  for (const names of rest) {
    const here = new Set(names);
    for (const name of [...shared]) if (!here.has(name)) shared.delete(name);
  }
  return [...shared].sort((a, b) => a.localeCompare(b));
}

const SECTION_LABELS: Record<SectionKey, string> = {
  local: 'Local Branches',
  remote: 'Remote Branches',
  tag: 'Tags',
};

function refsOf(repo: RepoRefs, section: SectionKey): readonly RefInfo[] {
  if (section === 'local') return orderRefs(repo.locals, repo.favorites);
  if (section === 'remote') return orderRefs(repo.remotes, repo.favorites);
  return repo.tags;
}

function repoOf(ctx: TreeContext, root: string | undefined): RepoRefs | undefined {
  return root === undefined ? undefined : ctx.repos.find((r) => r.root === root);
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

/**
 * A verb row. With `repoRoot` it is that repository's copy of the verb — the
 * `New Branch…` / `Checkout Tag or Revision…` pair IntelliJ puts at the top of
 * a repository's own level — and it runs against that repository, never
 * against whichever one the editor happens to be in.
 */
function verbRow(verb: HubVerb, separator: boolean, repoRoot?: string, depth = 0): TreeRow {
  return {
    id: nodeIds.verb(verb.command, repoRoot),
    kind: 'verb',
    depth,
    icon: verb.icon,
    label: verb.label,
    ...(verb.accelerator !== undefined ? { description: verb.accelerator } : {}),
    expandable: false,
    actions: false,
    searchText: `${verb.label} ${verb.keywords ?? ''}`,
    ...(separator ? { separator: '' } : {}),
    verb,
    ...(repoRoot !== undefined ? { repoRoot } : {}),
  };
}

/** The verbs that make sense inside one repository. */
const REPO_VERBS = HUB_VERBS.filter((v) => v.group === 'branch');

function repoRow(ctx: TreeContext, repo: RepoRefs, separator: boolean): TreeRow {
  return {
    id: nodeIds.repo(repo.root),
    kind: 'repo',
    depth: 0,
    icon: 'repo',
    label: repo.name,
    description: repoDescription(repo, ctx.showInOut),
    expandable: true,
    actions: true,
    searchText: `${repo.name} ${repo.currentBranch ?? ''}`,
    ...(separator ? { separator: 'Repositories' } : {}),
    repoRoot: repo.root,
  };
}

function sectionRow(
  repo: RepoRefs,
  section: SectionKey,
  count: number,
  depth: number,
  named: boolean,
): TreeRow {
  return {
    id: nodeIds.section(repo.root, section),
    kind: 'group',
    depth,
    icon: 'folder',
    label: named ? `${SECTION_LABELS[section]} in ${repo.name}` : SECTION_LABELS[section],
    description: String(count),
    expandable: true,
    actions: false,
    searchText: SECTION_LABELS[section],
    repoRoot: repo.root,
    section,
    prefix: '',
  };
}

function folderRow(
  repo: RepoRefs,
  section: SectionKey,
  bucket: FolderBucket,
  depth: number,
): TreeRow {
  return {
    id: nodeIds.folder(repo.root, section, bucket.prefix),
    kind: 'group',
    depth,
    icon: 'folder',
    label: bucket.name,
    description: String(bucket.count),
    expandable: true,
    actions: false,
    searchText: bucket.prefix,
    repoRoot: repo.root,
    section,
    prefix: bucket.prefix,
  };
}

function refRow(
  repo: RepoRefs,
  ref: RefInfo,
  prefix: string,
  depth: number,
  showInOut: boolean,
): TreeRow {
  const favorite = repo.favorites.has(ref.name);
  const description = refDescription(ref, showInOut);
  return {
    id: `ref:${repo.root}|${ref.type}|${ref.name}`,
    kind: 'ref',
    depth,
    icon: refIcon(ref, favorite),
    label: ref.name.slice(prefix.length),
    ...(description.length > 0 ? { description } : {}),
    expandable: false,
    actions: true,
    searchText: ref.name,
    ref,
    favorite,
    repoRoot: repo.root,
  };
}

function commonGroupRow(
  kind: CommonRef['kind'],
  label: string,
  count: number,
  separator: boolean,
): TreeRow {
  return {
    id: nodeIds.common(kind),
    kind: 'group',
    depth: 0,
    icon: 'folder',
    label,
    description: String(count),
    expandable: true,
    actions: false,
    searchText: label,
    ...(separator ? { separator: '' } : {}),
    commonKind: kind,
  };
}

function commonRefRow(
  kind: CommonRef['kind'],
  name: string,
  repoCount: number,
  depth: number,
): TreeRow {
  return {
    id: `${nodeIds.common(kind)}|${name}`,
    kind: 'common',
    depth,
    icon: kind === 'tag' ? 'tag' : kind === 'remote' ? 'cloud' : 'git-branch',
    label: name,
    description: `in all ${repoCount} repositories`,
    expandable: false,
    actions: true,
    searchText: name,
    common: { name, kind },
  };
}

// ---------------------------------------------------------------------------
// The tree
// ---------------------------------------------------------------------------

/** The top level: verbs, then repositories (or one root's sections), then common refs. */
export function rootRows(ctx: TreeContext): TreeRow[] {
  const rows: TreeRow[] = [];
  let lastGroup: string | undefined;
  for (const verb of HUB_VERBS) {
    rows.push(verbRow(verb, lastGroup !== undefined && lastGroup !== verb.group));
    lastGroup = verb.group;
  }

  if (ctx.repos.length > 1) {
    let first = true;
    for (const repo of ctx.repos) {
      rows.push(repoRow(ctx, repo, first));
      first = false;
    }
    const common: Array<[CommonRef['kind'], string, readonly string[]]> = [
      ['local', 'Common Local Branches', ctx.commonLocals],
      ['remote', 'Common Remote Branches', ctx.commonRemotes],
      ['tag', 'Common Tags', ctx.commonTags],
    ];
    let firstCommon = true;
    for (const [kind, label, names] of common) {
      if (names.length === 0) continue;
      rows.push(commonGroupRow(kind, label, names.length, firstCommon));
      firstCommon = false;
    }
    return rows;
  }

  const only = ctx.repos[0];
  if (only) rows.push(...repoSectionRows(only, 0, false, true));
  return rows;
}

/** A repository's three sections, in IntelliJ's order, skipping the empty ones. */
function repoSectionRows(
  repo: RepoRefs,
  depth: number,
  named: boolean,
  separateFirst = false,
): TreeRow[] {
  const rows: TreeRow[] = [];
  const sections: SectionKey[] = ['local', 'remote', 'tag'];
  let first = true;
  for (const section of sections) {
    const count = refsOf(repo, section).length;
    if (count === 0) continue;
    const row = sectionRow(repo, section, count, depth, named);
    rows.push(first && separateFirst ? { ...row, separator: '' } : row);
    first = false;
  }
  return rows;
}

/** What opens underneath `row`. Recomputed from live data every time. */
export function childRows(ctx: TreeContext, row: TreeRow): TreeRow[] {
  const depth = row.depth + 1;
  if (row.kind === 'repo') {
    const repo = repoOf(ctx, row.repoRoot);
    if (!repo) return [];
    return [
      ...REPO_VERBS.map((verb) => verbRow(verb, false, repo.root, depth)),
      ...repoSectionRows(repo, depth, true),
    ];
  }
  if (row.kind === 'group' && row.commonKind !== undefined) {
    const names =
      row.commonKind === 'local'
        ? ctx.commonLocals
        : row.commonKind === 'remote'
          ? ctx.commonRemotes
          : ctx.commonTags;
    return names.map((name) => commonRefRow(row.commonKind!, name, ctx.repos.length, depth));
  }
  if (row.kind === 'group' && row.section !== undefined) {
    const repo = repoOf(ctx, row.repoRoot);
    if (!repo) return [];
    const prefix = row.prefix ?? '';
    const refs = refsOf(repo, row.section);
    const { folders, refs: direct } = splitLevel(refs, prefix);
    return [
      ...folders.map((bucket) => folderRow(repo, row.section!, bucket, depth)),
      ...direct.map((ref) => refRow(repo, ref, prefix, depth, ctx.showInOut)),
    ];
  }
  return [];
}

/**
 * Every whitespace-separated term must appear, in any order, case-insensitive.
 * `jack son3` finds `#235568-dev-jackfruit-son3`; `origin/#235` finds every
 * `origin/#235…` branch, because remote refs are matched by their full name —
 * which is how the owner's reference search reads.
 */
export function matchesQuery(text: string, query: string): boolean {
  const hay = text.toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/u)
    .filter((term) => term.length > 0)
    .every((term) => hay.includes(term));
}

/** A flattened tree, and which of its expandable rows are showing their children. */
export interface FlatTree {
  readonly rows: TreeRow[];
  readonly open: ReadonlySet<string>;
}

export interface FlattenOptions {
  /**
   * The repository a search is confined to — the one the user last opened.
   * Without it, a search in a multi-root workspace covers every repository.
   */
  readonly scope?: string;
  /**
   * Nodes the user closed *inside the current search results*. A search opens
   * every path that leads to a match; this is how one of them is shut again
   * without disturbing what the unfiltered tree remembers.
   */
  readonly searchCollapsed?: ReadonlySet<string>;
}

/**
 * The list the popup renders. Unfiltered, it walks the tree against the
 * popup's expansion set, so a closed repository with 400 refs costs one row.
 * Filtered, it is either one repository's matches **as a tree**, or — with no
 * repository chosen in a multi-root workspace — every match everywhere.
 */
export function flattenTree(
  ctx: TreeContext,
  expanded: ReadonlySet<string>,
  filter = '',
  options: FlattenOptions = {},
): FlatTree {
  const query = filter.trim();
  if (query.length > 0) {
    const scoped =
      (options.scope !== undefined ? repoOf(ctx, options.scope) : undefined) ??
      (ctx.repos.length === 1 ? ctx.repos[0] : undefined);
    if (scoped) {
      return scopedSearch(ctx, scoped, query, options.searchCollapsed ?? new Set(), ctx.repos.length === 1);
    }
    return { rows: flatSearch(ctx, query), open: new Set() };
  }

  const out: TreeRow[] = [];
  const open = new Set<string>();
  const walk = (rows: readonly TreeRow[]): void => {
    for (const row of rows) {
      out.push(row);
      if (row.expandable && expanded.has(row.id)) {
        open.add(row.id);
        walk(childRows(ctx, row));
      }
    }
  };
  walk(rootRows(ctx));
  return { rows: out, open };
}

/**
 * One repository's search, **keeping the tree** — the shape of the owner's
 * reference: `Remote Branches in X` → `origin` → the matching leaves, each shown
 * by its own segment rather than by the path it is already under. Every path
 * that leads to a match opens by itself; folders and sections with no match
 * vanish, and a folder's count is the number of *matches* under it, which is
 * the number that is useful while searching.
 *
 * The repository's own verbs are searched too, so typing `new` still finds
 * `New Branch…` — scoped to this repository, as that row always is.
 */
function scopedSearch(
  ctx: TreeContext,
  repo: RepoRefs,
  query: string,
  collapsed: ReadonlySet<string>,
  soloRoot: boolean,
  baseDepth = 0,
): FlatTree {
  const rows: TreeRow[] = [];
  const open = new Set<string>();
  const verbs = soloRoot ? HUB_VERBS : REPO_VERBS;
  for (const verb of verbs) {
    if (matchesQuery(`${verb.label} ${verb.keywords ?? ''}`, query)) {
      rows.push(verbRow(verb, false, soloRoot ? undefined : repo.root, baseDepth));
    }
  }

  const walk = (section: SectionKey, refs: readonly RefInfo[], prefix: string, depth: number): void => {
    const { folders, refs: direct } = splitLevel(refs, prefix);
    for (const bucket of folders) {
      const row = folderRow(repo, section, bucket, depth);
      rows.push(row);
      if (collapsed.has(row.id)) continue;
      open.add(row.id);
      walk(section, refs, bucket.prefix, depth + 1);
    }
    for (const ref of direct) rows.push(refRow(repo, ref, prefix, depth, ctx.showInOut));
  };

  // A rule between the matching verbs and the first section, as in the
  // unfiltered level; none between the sections themselves.
  const verbsMatched = rows.length > 0;
  let firstSection = true;
  const sections: SectionKey[] = ['local', 'remote', 'tag'];
  for (const section of sections) {
    const hits = refsOf(repo, section).filter((ref) => matchesQuery(ref.name, query));
    if (hits.length === 0) continue;
    const row = sectionRow(repo, section, hits.length, baseDepth, !soloRoot);
    rows.push(firstSection && verbsMatched ? { ...row, separator: '' } : row);
    firstSection = false;
    if (collapsed.has(row.id)) continue;
    open.add(row.id);
    walk(section, hits, '', baseDepth + 1);
  }

  if (rows.length === 0) {
    rows.push({
      id: `info:no-match:${repo.root}`,
      kind: 'info',
      depth: baseDepth,
      icon: 'info',
      label: soloRoot
        ? `No branches match "${query}"`
        : `No branches in ${repo.name} match "${query}"`,
      expandable: false,
      actions: false,
      searchText: '',
    });
  }
  return { rows, open };
}

/**
 * With no repository chosen, typing searches everything at once — every
 * repository, every folder depth, every ref kind, plus the verbs — as one flat
 * list, each ref naming the repository it lives in.
 */
function flatSearch(ctx: TreeContext, query: string): TreeRow[] {
  const rows: TreeRow[] = [];
  const hit = (text: string): boolean => matchesQuery(text, query);

  for (const verb of HUB_VERBS) {
    if (hit(`${verb.label} ${verb.keywords ?? ''}`)) rows.push(verbRow(verb, false));
  }

  const multiRoot = ctx.repos.length > 1;
  for (const repo of ctx.repos) {
    if (multiRoot && hit(repo.name)) rows.push(repoRow(ctx, repo, false));
    const all = [
      ...orderRefs(repo.locals, repo.favorites),
      ...orderRefs(repo.remotes, repo.favorites),
      ...repo.tags,
    ];
    for (const ref of all) {
      if (!hit(ref.name)) continue;
      const row = refRow(repo, ref, '', 0, ctx.showInOut);
      rows.push(
        multiRoot
          ? {
              ...row,
              description: [repo.name, row.description].filter(Boolean).join('  ·  '),
            }
          : row,
      );
    }
  }
  return rows;
}

// ---------------------------------------------------------------------------
// The sidebar's webview tree
// ---------------------------------------------------------------------------

/**
 * What the sidebar view is showing. It lives on the host, not in the webview:
 * one owner of the shape means the rows can never disagree with the tree the
 * popup builds from the same functions.
 */
export interface SidebarState {
  readonly expanded: ReadonlySet<string>;
  /** The field at the top. IntelliJ's first panel searches what is *in* it. */
  readonly topQuery: string;
  /** One field per opened repository, keyed by root — IntelliJ's second panel. */
  readonly repoQueries: ReadonlyMap<string, string>;
  /** Nodes shut inside search results; thrown away when a query changes. */
  readonly searchCollapsed: ReadonlySet<string>;
}

/** The inline `<input>` an opened repository carries. */
function searchRow(repo: RepoRefs, depth: number): TreeRow {
  return {
    id: `search:${repo.root}`,
    kind: 'search',
    depth,
    icon: 'search',
    label: '',
    expandable: false,
    actions: false,
    searchText: '',
    repoRoot: repo.root,
  };
}

/**
 * The sidebar's rows. Two searches are live at once, which is the whole reason
 * this surface is a webview:
 *
 *   - the **top field** filters what the top level holds, which is what
 *     IntelliJ's first panel does: the verbs, the repository rows and the
 *     common refs. It does not reach inside a repository — that is the other
 *     field's job — so a repository's 400 branches never flood a search for a
 *     repository's *name*.
 *   - an **opened repository's own field** filters that repository, keeping the
 *     tree: sections and folders with no match vanish, every path to a match
 *     opens itself, and each leaf shows its own segment.
 *
 * With a single root there is no first panel in IntelliJ either — the popup
 * *is* the repository — so the top field searches that repository directly.
 */
export function buildSidebarRows(ctx: TreeContext, state: SidebarState): FlatTree {
  const rows: TreeRow[] = [];
  const open = new Set<string>();
  const top = state.topQuery.trim();
  const solo = ctx.repos.length === 1 ? ctx.repos[0] : undefined;

  if (solo) {
    if (top.length > 0) return scopedSearch(ctx, solo, top, state.searchCollapsed, true);
    const walkSolo = (list: readonly TreeRow[]): void => {
      for (const row of list) {
        rows.push(row);
        if (row.expandable && state.expanded.has(row.id)) {
          open.add(row.id);
          walkSolo(childRows(ctx, row));
        }
      }
    };
    walkSolo(rootRows(ctx));
    return { rows, open };
  }

  const filtering = top.length > 0;
  for (const row of rootRows(ctx)) {
    if (row.kind === 'verb') {
      if (!filtering || matchesQuery(row.searchText, top)) rows.push(row);
      continue;
    }

    if (row.kind === 'repo') {
      if (filtering) {
        // Filtering the first panel lists the repositories it matches, closed:
        // what is inside one of them is the other field's question.
        if (matchesQuery(row.searchText, top)) rows.push(row);
        continue;
      }
      rows.push(row);
      if (!state.expanded.has(row.id)) continue;
      open.add(row.id);
      const repo = repoOf(ctx, row.repoRoot);
      if (!repo) continue;
      rows.push(searchRow(repo, row.depth + 1));
      const query = (state.repoQueries.get(repo.root) ?? '').trim();
      if (query.length > 0) {
        const found = scopedSearch(ctx, repo, query, state.searchCollapsed, false, row.depth + 1);
        rows.push(...found.rows);
        for (const id of found.open) open.add(id);
        continue;
      }
      const walk = (list: readonly TreeRow[]): void => {
        for (const child of list) {
          rows.push(child);
          if (child.expandable && state.expanded.has(child.id)) {
            open.add(child.id);
            walk(childRows(ctx, child));
          }
        }
      };
      walk(childRows(ctx, row));
      continue;
    }

    // A common section: keep it when something under it matches, and open it,
    // because a closed group tells a search nothing.
    if (row.commonKind !== undefined) {
      const names = childRows(ctx, row).filter(
        (child) => !filtering || matchesQuery(child.searchText, top),
      );
      if (filtering && names.length === 0) continue;
      rows.push(row);
      if (!filtering && !state.expanded.has(row.id)) continue;
      open.add(row.id);
      rows.push(...names);
      continue;
    }

    rows.push(row);
  }

  if (rows.every((row) => row.kind === 'verb') && filtering) {
    rows.push({
      id: 'info:no-match:top',
      kind: 'info',
      depth: 0,
      icon: 'info',
      label: `Nothing matches "${top}"`,
      expandable: false,
      actions: false,
      searchText: '',
    });
  }
  return { rows, open };
}
