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

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

export type RowKind = 'verb' | 'group' | 'repo' | 'ref' | 'common';
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
}

// ---------------------------------------------------------------------------
// Node ids
// ---------------------------------------------------------------------------

export const nodeIds = {
  verb: (command: string): string => `verb:${command}`,
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

/** The glyph a ref row leads with. Current wins over favourite wins over type. */
export function refIcon(ref: RefInfo, favorite: boolean): string {
  if (ref.isHead === true) return 'check';
  if (favorite) return 'star-full';
  if (ref.type === 'tag') return 'tag';
  if (ref.type === 'remote') return 'cloud';
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

function verbRow(verb: HubVerb, separator: boolean): TreeRow {
  return {
    id: nodeIds.verb(verb.command),
    kind: 'verb',
    depth: 0,
    icon: verb.icon,
    label: verb.label,
    ...(verb.accelerator !== undefined ? { description: verb.accelerator } : {}),
    expandable: false,
    actions: false,
    searchText: `${verb.label} ${verb.keywords ?? ''}`,
    ...(separator ? { separator: '' } : {}),
    verb,
  };
}

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
    return repo ? repoSectionRows(repo, depth, true) : [];
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
 * The flattened list the popup renders, against its own expansion set. A closed
 * node contributes nothing below it, so a repository with 400 refs costs one row
 * until it is opened.
 */
export function flattenTree(
  ctx: TreeContext,
  expanded: ReadonlySet<string>,
  filter = '',
): TreeRow[] {
  const query = filter.trim().toLowerCase();
  if (query.length > 0) return flatSearch(ctx, query);

  const out: TreeRow[] = [];
  const walk = (rows: readonly TreeRow[]): void => {
    for (const row of rows) {
      out.push(row);
      if (row.expandable && expanded.has(row.id)) walk(childRows(ctx, row));
    }
  };
  walk(rootRows(ctx));
  return out;
}

/**
 * Typing searches everything at once — every repository, every folder depth,
 * every ref kind, plus the verbs — as one flat list. Opening a level can
 * therefore never hide a match, which is the one property of the old drill-in
 * popup worth keeping.
 */
function flatSearch(ctx: TreeContext, query: string): TreeRow[] {
  const rows: TreeRow[] = [];
  const hit = (text: string): boolean => text.toLowerCase().includes(query);

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
