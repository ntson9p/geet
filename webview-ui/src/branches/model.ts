/**
 * The Repositories panel's rows (once the Branches panel), from the host's
 * state and the panel's own view state (new-way-4). Pure: no React, no DOM, so
 * every rule is unit-tested.
 *
 * **Two lists, with several repositories** (new-way-6): the repositories' rows
 * and the branches' rows, each the list of a pane of its own (`paneLayout.ts`), so
 * twenty repositories no longer push the branches out of sight. With one
 * repository there is nothing to split: its current branch heads the one list.
 *
 * **One list for every repository.** A branch name is one row however many
 * repositories have it; the row says which of the repositories in view those
 * are (`whereOf`: `in api, web`, `in all 20`), or with Repository Dots on, a
 * dot per repository says it, and whatever the row does, it does in the
 * repositories it stands for. Narrowing the view to some repositories (the
 * scope) narrows both the rows and what they act on.
 *
 * **Where you are, then where you can go**: the repositories and what each has
 * checked out, then the branches, one kind at a time under tabs: Recent (the
 * starred and the recently used), Local, Remote and Tags. The four overlap —
 * every recent branch is a local one, most local ones have a remote twin — so
 * the panel shows one of them, never all four stacked.
 *
 * **Searching looks everywhere.** With text in the filter the tabs give way:
 * every kind holds its matches, as one flat list of whole names under a
 * heading, matched letters marked, and Recent steps aside so as not to list a
 * match twice.
 */
import type {
  BranchPanelDetailsDto,
  BranchPanelRefDto,
  BranchPanelRefKind,
  BranchPanelRepoDetailsDto,
  BranchPanelRepoDto,
  BranchPanelStateDto,
  BranchPanelTargetDto,
} from '../../../src/shared/protocol';

// ---------------------------------------------------------------------------
// Metrics — every row's height is decided here, so the list can window them.
// ---------------------------------------------------------------------------

export const ROW = 22;
export const SECTION = 26;
export const REPO = 24;
export const OPERATION = 26;
export const HINT = 44;
/** One line of a branch card. */
export const CARD_LINE = 20;
/** The card's row of buttons. */
export const CARD_BUTTONS = 30;
export const CARD_PAD = 12;
/** The tabs over the branch list. */
export const TABS = 30;

/** A heading over a kind's matches, while the filter searches every kind. */
export type SectionId = 'recent' | 'local' | 'remote' | 'tags';

/** The kinds of branch the list shows, one at a time. */
export type BranchTab = 'recent' | 'local' | 'remote' | 'tags';

/** The tabs row's id: the one row the list keeps at its top once scrolled past. */
export const TABS_ID = 'tabs';

/** Recent branches listed, starred ones aside. */
const RECENT_MAX = 8;

// ---------------------------------------------------------------------------
// Branch entries: one per name, across the repositories in view.
// ---------------------------------------------------------------------------

export interface Presence {
  readonly repo: BranchPanelRepoDto;
  readonly ref: BranchPanelRefDto;
}

export interface BranchEntry {
  /** `local:feature/x`, `remote:origin/main`, `tag:v1.0`. */
  readonly key: string;
  readonly kind: BranchPanelRefKind;
  readonly name: string;
  /** The repositories in view that have it, in the panel's repository order. */
  readonly presence: readonly Presence[];
  /** Roots where it is the checked-out branch. */
  readonly currentIn: readonly string[];
  readonly favorite: boolean;
  /** Merged into the main branch in every repository that has it. */
  readonly merged: boolean;
  /** Its upstream is gone in some repository. */
  readonly gone: boolean;
  /** Published nowhere: a local branch with no upstream in any repository. */
  readonly unpublished: boolean;
  /** The remote branch it tracks under another name, in the first repository where it does. */
  readonly tracksElsewhere?: string;
  readonly ahead: number;
  readonly behind: number;
  /** The newest tip's date, unix seconds. */
  readonly date?: number;
  readonly subject?: string;
}

export function entryKey(kind: BranchPanelRefKind, name: string): string {
  return `${kind}:${name}`;
}

/** True when the branch is checked out everywhere it exists. */
export function isCurrentEverywhere(entry: BranchEntry): boolean {
  return entry.currentIn.length > 0 && entry.currentIn.length === entry.presence.length;
}

export function targetOf(entry: BranchEntry): BranchPanelTargetDto {
  return { kind: entry.kind, name: entry.name, roots: entry.presence.map((p) => p.repo.root) };
}

function refsOf(repo: BranchPanelRepoDto, kind: BranchPanelRefKind): readonly BranchPanelRefDto[] {
  return kind === 'local' ? repo.locals : kind === 'remote' ? repo.remotes : repo.tags;
}

/** Every distinct name of `kind` across `repos`, merged into entries. */
export function buildEntries(
  repos: readonly BranchPanelRepoDto[],
  kind: BranchPanelRefKind,
): BranchEntry[] {
  const byName = new Map<string, Presence[]>();
  for (const repo of repos) {
    for (const ref of refsOf(repo, kind)) {
      const list = byName.get(ref.name);
      if (list) list.push({ repo, ref });
      else byName.set(ref.name, [{ repo, ref }]);
    }
  }
  const out: BranchEntry[] = [];
  for (const [name, presence] of byName) out.push(toEntry(kind, name, presence));
  return out;
}

/**
 * The remote branch a local branch tracks under another name: `mine` tracking
 * `origin/develop`. A push goes there rather than to a branch of its own, which
 * is worth saying wherever the branch is shown. Undefined when it tracks its own
 * name, nothing, or something the remote has deleted.
 */
export function upstreamElsewhere(
  repo: BranchPanelRepoDto,
  name: string,
  upstream: string | undefined,
  gone: boolean | undefined,
): string | undefined {
  if (upstream === undefined || gone === true) return undefined;
  const remote = repo.remotes.find((r) => r.name === upstream)?.remote;
  const cut = remote !== undefined ? remote.length + 1 : upstream.indexOf('/') + 1;
  return upstream.slice(cut) === name ? undefined : upstream;
}

/** The remote branch of a local branch's own name, whether or not it tracks it. */
export function remoteTwin(repo: BranchPanelRepoDto, name: string): string | undefined {
  return repo.remotes.find((r) => r.remote !== undefined && r.name === `${r.remote}/${name}`)?.name;
}

function toEntry(kind: BranchPanelRefKind, name: string, presence: readonly Presence[]): BranchEntry {
  let newest: BranchPanelRefDto | undefined;
  let ahead = 0;
  let behind = 0;
  for (const { ref } of presence) {
    ahead += ref.ahead ?? 0;
    behind += ref.behind ?? 0;
    if (ref.date !== undefined && (newest?.date === undefined || ref.date > newest.date)) newest = ref;
  }
  newest ??= presence[0]?.ref;
  const local = kind === 'local';
  const elsewhere = local
    ? presence
        .map((p) => upstreamElsewhere(p.repo, name, p.ref.upstream, p.ref.gone))
        .find((upstream) => upstream !== undefined)
    : undefined;
  return {
    key: entryKey(kind, name),
    kind,
    name,
    presence,
    currentIn: presence.filter((p) => p.ref.current === true).map((p) => p.repo.root),
    favorite: local && presence.some((p) => p.repo.favorites.includes(name)),
    merged: local && presence.length > 0 && presence.every((p) => p.repo.merged.includes(name)),
    gone: local && presence.some((p) => p.ref.gone === true),
    unpublished: local && presence.every((p) => p.ref.upstream === undefined),
    ...(elsewhere !== undefined ? { tracksElsewhere: elsewhere } : {}),
    ahead,
    behind,
    ...(newest?.date !== undefined ? { date: newest.date } : {}),
    ...(newest?.subject !== undefined ? { subject: newest.subject } : {}),
  };
}

/** Starred first, then by name: IntelliJ's order inside a level. */
export function compareEntries(a: BranchEntry, b: BranchEntry): number {
  return (a.favorite ? 0 : 1) - (b.favorite ? 0 : 1) || a.name.localeCompare(b.name);
}

/** Tags read newest first: `v1.10` is the release you want, whatever the alphabet says. */
export function compareTags(a: BranchEntry, b: BranchEntry): number {
  return (b.date ?? 0) - (a.date ?? 0) || b.name.localeCompare(a.name);
}

/**
 * Recent and starred branches, merged across repositories: the starred ones,
 * then each repository's recent list taken a rank at a time, so the branch one
 * repository used last sits beside the one another used last. Branches already
 * checked out wherever they exist are the first rows of the panel; they are
 * not repeated here.
 */
export function recentEntries(
  repos: readonly BranchPanelRepoDto[],
  locals: ReadonlyMap<string, BranchEntry>,
): BranchEntry[] {
  const out: BranchEntry[] = [];
  const seen = new Set<string>();
  const add = (name: string): boolean => {
    if (seen.has(name)) return false;
    const entry = locals.get(entryKey('local', name));
    if (!entry || isCurrentEverywhere(entry)) return false;
    seen.add(name);
    out.push(entry);
    return true;
  };
  // Every starred branch, however many: starring one is asking for it here.
  const starred = [...new Set(repos.flatMap((r) => r.favorites))].sort((a, b) => a.localeCompare(b));
  for (const name of starred) add(name);
  // Then the recent ones, a rank at a time, up to RECENT_MAX of them.
  let recent = 0;
  const depth = Math.max(0, ...repos.map((r) => r.recent.length));
  for (let rank = 0; rank < depth && recent < RECENT_MAX; rank++) {
    for (const repo of repos) {
      const name = repo.recent[rank];
      if (name !== undefined && recent < RECENT_MAX && add(name)) recent++;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Searching
// ---------------------------------------------------------------------------

/** Lower-cased words; a name matches when it holds every one of them. */
export function queryTokens(query: string): string[] {
  return query
    .toLowerCase()
    .split(/\s+/u)
    .filter((t) => t.length > 0);
}

/** `[start, end)` ranges of `text` to mark, merged, or `undefined` when it does not match. */
export function matchRanges(text: string, tokens: readonly string[]): Array<[number, number]> | undefined {
  if (tokens.length === 0) return [];
  const lower = text.toLowerCase();
  const ranges: Array<[number, number]> = [];
  for (const token of tokens) {
    const at = lower.indexOf(token);
    if (at === -1) return undefined;
    ranges.push([at, at + token.length]);
  }
  ranges.sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const range of ranges) {
    const last = merged[merged.length - 1];
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else merged.push([range[0], range[1]]);
  }
  return merged;
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

export type PanelRow =
  | {
      readonly kind: 'section';
      readonly id: string;
      readonly section: SectionId;
      readonly label: string;
      readonly count: number;
      readonly open: boolean;
      readonly height: number;
    }
  | {
      /** A repository, in a workspace with several. */
      readonly kind: 'repo';
      readonly id: string;
      readonly repo: BranchPanelRepoDto;
      /** In the scope: its branches are listed and acted on. */
      readonly inScope: boolean;
      /** The user narrowed the scope (some repositories are out of it). */
      readonly narrowed: boolean;
      /**
       * Narrowed to this repository alone: a click shows every repository again.
       * Picked among several, a click shows it alone (POST-P14bw).
       */
      readonly only: boolean;
      readonly height: number;
    }
  | {
      /** The checked-out branch of the only repository, with its card. */
      readonly kind: 'head';
      readonly id: string;
      readonly repo: BranchPanelRepoDto;
      /** The current branch's entry, when HEAD is on a branch. */
      readonly entry?: BranchEntry;
      readonly card: boolean;
      /** What its open card says, line by line: what its height was sized from. */
      readonly cardLines?: readonly CardLine[];
      readonly height: number;
    }
  | {
      /** Git is in the middle of a merge, rebase, cherry-pick or revert here. */
      readonly kind: 'operation';
      readonly id: string;
      readonly repo: BranchPanelRepoDto;
      readonly height: number;
    }
  | {
      readonly kind: 'remote';
      readonly id: string;
      readonly remote: string;
      readonly count: number;
      readonly open: boolean;
      readonly depth: number;
      readonly height: number;
    }
  | {
      readonly kind: 'folder';
      readonly id: string;
      readonly label: string;
      readonly count: number;
      readonly open: boolean;
      readonly depth: number;
      readonly height: number;
    }
  | {
      readonly kind: 'branch';
      readonly id: string;
      readonly entry: BranchEntry;
      readonly section: SectionId;
      readonly depth: number;
      /** Dimmed lead of the shown name (`feature/`), when the whole name is shown. */
      readonly prefix: string;
      /** The rest of the shown name. */
      readonly label: string;
      /** Marked ranges over `prefix + label`. */
      readonly highlights: ReadonlyArray<readonly [number, number]>;
      /** Its card is open beneath it. */
      readonly card: boolean;
      /** What its open card says, line by line: what its height was sized from. */
      readonly cardLines?: readonly CardLine[];
      /** Which repositories in view have it: set while several are in view. */
      readonly where?: RowWhere;
      readonly height: number;
    }
  | {
      readonly kind: 'hint';
      readonly id: string;
      readonly text: string;
      /** A name the search offers to create. */
      readonly create?: string;
      readonly height: number;
    }
  | {
      /** Which kind of branch the list below shows. Not while searching. */
      readonly kind: 'tabs';
      readonly id: string;
      readonly tabs: readonly TabCount[];
      readonly active: BranchTab;
      readonly height: number;
    };

export interface TabCount {
  readonly id: BranchTab;
  readonly label: string;
  /** Branches of that kind in view; the recent ones for Recent. */
  readonly count: number;
}

export interface PanelUiState {
  readonly query: string;
  /** Roots the panel is narrowed to; empty means every repository. */
  readonly scope: readonly string[];
  /** Ids whose open state differs from their default. */
  readonly toggled: ReadonlySet<string>;
  /** The row whose card is open. */
  readonly openCard?: string;
  /**
   * A card's facts, once the host has sent them: they say how far each
   * repository's branch is from what that repository has checked out, which
   * decides how its repositories group, and so how tall the card is.
   */
  readonly detailsOf?: (entry: BranchEntry) => BranchPanelDetailsDto | undefined;
  /** The open card's groups opened to list their repositories, by `CardGroup.key`. */
  readonly openGroups?: ReadonlySet<string>;
  /** The tab picked. None: Recent, unless nothing is recent. */
  readonly tab?: BranchTab;
}

export interface PanelModel {
  /**
   * Where you are: with several repositories, a row for each (and a banner
   * under one mid-operation), the REPOSITORIES pane's list; with one, its
   * current branch, the first rows of the one list.
   */
  readonly repoRows: readonly PanelRow[];
  /** Where you can go: the tabs and the branches under them, or a search's matches. */
  readonly branchRows: readonly PanelRow[];
  /** Both, in order: the one list of a single repository, and what a lookup by id searches. */
  readonly rows: readonly PanelRow[];
  /** Repositories whose branches are listed and acted on. */
  readonly scopeRepos: readonly BranchPanelRepoDto[];
  /** More than one repository in the workspace. */
  readonly multi: boolean;
  /** More than one repository in view: rows carry repository markers. */
  readonly markers: boolean;
  /** Matches across every section, while searching. */
  readonly matches: number;
  /** The tab whose branches are listed, or would be once the search is cleared. */
  readonly tab: BranchTab;
}

const SECTION_LABEL: Record<SectionId, string> = {
  recent: 'Recent',
  local: 'Local',
  remote: 'Remote',
  tags: 'Tags',
};

function isOpen(id: string, byDefault: boolean, ui: PanelUiState): boolean {
  return ui.toggled.has(id) ? !byDefault : byDefault;
}

/**
 * Collapse All: every folder and remote in view shut, whatever it was by
 * default. A folder opened by hand is open because it is toggled, so shutting
 * it drops the toggle; one open by default (it holds the current branch) gains
 * one. What is out of view (another tab, a shut folder) stays as it was.
 */
export function collapsedAll(rows: readonly PanelRow[], toggled: ReadonlySet<string>): ReadonlySet<string> {
  const next = new Set(toggled);
  for (const row of rows) {
    if ((row.kind !== 'folder' && row.kind !== 'remote') || !row.open) continue;
    if (next.has(row.id)) next.delete(row.id);
    else next.add(row.id);
  }
  return next;
}

/** What a screen reader hears on the tabs row: the tab shown, where it sits, and how to move. */
export function tabsLabel(row: Extract<PanelRow, { kind: 'tabs' }>): string {
  const at = row.tabs.findIndex((t) => t.id === row.active);
  return `${row.tabs[at]?.label ?? ''} tab, ${at + 1} of ${row.tabs.length}. Left and Right switch.`;
}

/** A tab's hover, which still counts its branches when the strip is too narrow to. */
export function tabTitle(tab: TabCount): string {
  const noun =
    tab.id === 'tags' ? (tab.count === 1 ? 'tag' : 'tags') : `${tab.id} ${tab.count === 1 ? 'branch' : 'branches'}`;
  return `${tab.count} ${noun}`;
}

/**
 * The tab whose branches are listed: the one picked, else Recent while anything
 * is recent, else Local. Tags is no choice while tags are hidden.
 */
export function shownTab(picked: BranchTab | undefined, recentCount: number, showTags: boolean): BranchTab {
  if (picked === 'tags' && !showTags) return 'local';
  if (picked !== undefined) return picked;
  return recentCount > 0 ? 'recent' : 'local';
}

/** Repositories in view: the scope, or every one when the scope names none that are open. */
export function scopeReposOf(
  repos: readonly BranchPanelRepoDto[],
  scope: readonly string[],
): BranchPanelRepoDto[] {
  if (scope.length === 0) return [...repos];
  const wanted = new Set(scope);
  const kept = repos.filter((r) => wanted.has(r.root));
  return kept.length > 0 ? kept : [...repos];
}

// ---------------------------------------------------------------------------
// A branch's card: what it says, line by line
// ---------------------------------------------------------------------------

/**
 * Repositories in view that say the same about a branch: one line of its
 * card, however many there are. Twenty repositories in step are one line, not
 * twenty; the ones that differ get a line each. `missing` is the repositories
 * in view that lack the branch.
 */
export interface CardGroup {
  /** Tells the group from the card's others: what its repositories share, or `missing`. */
  readonly key: string;
  readonly missing: boolean;
  /** In the panel's order. */
  readonly repos: readonly BranchPanelRepoDto[];
  /** The branch is checked out in each of them. */
  readonly current: boolean;
  /** They track a remote branch of another name, `origin/x`: a push goes there. */
  readonly elsewhere?: string;
  /** Where the branch stands against what it tracks: `up to date`, `↑2`, `not published`. */
  readonly tracking: string;
  /** Against each repository's checked-out branch, once the card's facts arrive. */
  readonly relation?: string;
}

/** A card's line. Every kind is one `CARD_LINE` tall: the model sizes the card by counting them. */
export type CardLine =
  /** HEAD is detached: there is no branch to describe. */
  | { readonly kind: 'detached' }
  | { readonly kind: 'detachedHint' }
  /** The branch's last commit. */
  | { readonly kind: 'commit' }
  /** Where it stands against what it tracks, in full: one repository has it. */
  | { readonly kind: 'tracking' }
  /** Where it stands against what is checked out, in full. */
  | { readonly kind: 'relation' }
  /** A group of repositories, one line. */
  | {
      readonly kind: 'group';
      readonly group: CardGroup;
      /** `All 20`, `api, web`, `13 repositories`, `not in 4 repositories`. */
      readonly label: string;
      /** Large enough to list its repositories on demand. */
      readonly expandable: boolean;
      readonly open: boolean;
    }
  /** One repository of a group opened to list them. */
  | { readonly kind: 'member'; readonly group: CardGroup; readonly repo: BranchPanelRepoDto };

/** What a card's lines depend on besides its branch. */
export interface CardContext {
  /** More than one repository in view: the card speaks of repositories. */
  readonly markers: boolean;
  /** The repositories in view, the ones that lack the branch included. */
  readonly scopeRepos: readonly BranchPanelRepoDto[];
  readonly details?: BranchPanelDetailsDto;
  /** Groups opened to list their repositories, by key. */
  readonly open?: ReadonlySet<string>;
}

/** A group names up to this many repositories; past it, it counts them and lists them on demand. */
export const NAMED_REPOS = 3;

function names(repos: readonly BranchPanelRepoDto[]): string {
  return repos.map((r) => r.label).join(', ');
}

/**
 * The branch's repositories grouped by what they say about it, largest group
 * first (the panel's order among equals), then the repositories in view that
 * lack it. A repository's facts that have not arrived yet group it by what
 * the panel already knows; they can split a group when they come.
 */
export function cardGroups(
  entry: BranchEntry,
  scopeRepos: readonly BranchPanelRepoDto[],
  details: BranchPanelDetailsDto | undefined,
): CardGroup[] {
  const groups: CardGroup[] = [];
  const byKey = new Map<string, { group: CardGroup; repos: BranchPanelRepoDto[] }>();
  for (const p of entry.presence) {
    const d = details?.repos.find((r) => r.root === p.repo.root);
    const current = p.ref.current === true;
    const elsewhere = upstreamElsewhere(p.repo, entry.name, p.ref.upstream, p.ref.gone);
    const twin = entry.kind === 'local' ? remoteTwin(p.repo, entry.name) : undefined;
    const tracking = trackingShort(p.ref, entry.kind, d?.trackedBy, twin);
    const relation = current ? undefined : relationShort(d);
    const key = JSON.stringify([current, elsewhere ?? '', tracking, relation ?? '']);
    const known = byKey.get(key);
    if (known) {
      known.repos.push(p.repo);
      continue;
    }
    const repos: BranchPanelRepoDto[] = [p.repo];
    const group: CardGroup = {
      key,
      missing: false,
      repos,
      current,
      ...(elsewhere !== undefined ? { elsewhere } : {}),
      tracking,
      ...(relation !== undefined ? { relation } : {}),
    };
    byKey.set(key, { group, repos });
    groups.push(group);
  }
  // Largest first: the state most repositories share, then the exceptions.
  const ordered = groups
    .map((group, i) => ({ group, i }))
    .sort((a, b) => b.group.repos.length - a.group.repos.length || a.i - b.i)
    .map(({ group }) => group);
  const has = new Set(entry.presence.map((p) => p.repo.root));
  const lacking = scopeRepos.filter((r) => !has.has(r.root));
  if (scopeRepos.length > 1 && lacking.length > 0) {
    ordered.push({ key: 'missing', missing: true, repos: lacking, current: false, tracking: '' });
  }
  return ordered;
}

/** A group's label: its repositories named while few, else counted. */
export function groupLabel(group: CardGroup, all: boolean): string {
  const n = group.repos.length;
  if (group.missing) return n <= NAMED_REPOS ? `not in ${names(group.repos)}` : `not in ${n} repositories`;
  if (n <= NAMED_REPOS) return names(group.repos);
  return all ? `All ${n}` : `${n} repositories`;
}

/**
 * Everything a card says, a line each: its commit; then, with one repository
 * in view (or the branch in one only), where it stands in full; with several,
 * a line per group of repositories that say the same; then the repositories
 * that lack it. A group too large to name lists its repositories, a line
 * each, once opened.
 */
export function cardLines(entry: BranchEntry | undefined, ctx: CardContext): CardLine[] {
  if (entry === undefined) return [{ kind: 'detached' }, { kind: 'detachedHint' }];
  const lines: CardLine[] = [{ kind: 'commit' }];
  const groups = ctx.markers ? cardGroups(entry, ctx.scopeRepos, ctx.details) : [];
  const pushGroup = (group: CardGroup, all: boolean): void => {
    const expandable = !all && group.repos.length > NAMED_REPOS;
    const open = expandable && ctx.open?.has(group.key) === true;
    lines.push({ kind: 'group', group, label: groupLabel(group, all), expandable, open });
    if (open) for (const repo of group.repos) lines.push({ kind: 'member', group, repo });
  };
  if (ctx.markers && entry.presence.length > 1) {
    const found = groups.filter((g) => !g.missing);
    const all = found.length === 1 && groups.length === 1;
    for (const group of found) pushGroup(group, all);
  } else {
    lines.push({ kind: 'tracking' });
    if (!isCurrentEverywhere(entry)) lines.push({ kind: 'relation' });
  }
  const missing = groups.find((g) => g.missing);
  if (missing !== undefined) pushGroup(missing, false);
  return lines;
}

/** A card's height, from its lines: the frame, a `CARD_LINE` each, and the row of buttons. */
export function cardHeight(lines: readonly CardLine[]): number {
  return CARD_PAD + lines.length * CARD_LINE + CARD_BUTTONS;
}

/**
 * What a click on a repository's row does, as its hover says it (POST-P14bw). A click
 * shows only that repository's branches, or every repository's again on the one the panel
 * shows alone. A Ctrl+click adds a repository or leaves one out; with every repository
 * shown, it shows only that one, as a click does, so the hover says nothing of it there.
 */
export function repoHint(row: Pick<Extract<PanelRow, { kind: 'repo' }>, 'inScope' | 'narrowed' | 'only'>): string {
  if (!row.narrowed) return 'Click to show only its branches';
  if (row.only) return 'Click to show every repository again';
  return row.inScope
    ? 'Click to show only its branches · Ctrl+click to leave it out'
    : 'Click to show only its branches · Ctrl+click to add it';
}

/** What the panel's `⋯` menu's Update, Commit and Push act on, and what each is called (`viewActions`). */
export interface ViewActions {
  /** The repositories they act on; none for the project. */
  readonly roots: readonly string[];
  /** The project's, which `Ctrl+T`, `Ctrl+K` and `Ctrl+Shift+K` run, so the items may name those keys. */
  readonly project: boolean;
  /** `Update Project…`, `Update Repository…`, `Update 2 Repositories…`. */
  readonly update: string;
  /** The same, `… Without Fetching…`. */
  readonly updateWithoutFetch: string;
  /** `Commit…`, `Commit Repository…`, `Commit 2 Repositories…`. */
  readonly commit: string;
  /** `Push…`, `Push Repository…`, `Push 2 Repositories…`. */
  readonly push: string;
}

/**
 * The `⋯` menu's Update (POST-P14bx), Commit and Push (POST-P14by) act on what is
 * in view. Every repository in view, the workspace's only one included, is the
 * project, as `Ctrl+T`, `Ctrl+K` and `Ctrl+Shift+K` are: `Update Project…`,
 * `Commit…`, `Push…`. Some picked are those, and the items say so: `… Repository…`
 * for one, `… 2 Repositories…` for two. Commit acts at once, so its words must say
 * where; Push's dialog lists every repository, with those checked. Before, one
 * picked was that one under the project's words, and two of four were all four.
 */
export function viewActions(
  repos: readonly BranchPanelRepoDto[],
  scopeRepos: readonly BranchPanelRepoDto[],
): ViewActions {
  if (scopeRepos.length === 0 || scopeRepos.length >= repos.length) {
    return {
      roots: [],
      project: true,
      update: 'Update Project…',
      updateWithoutFetch: 'Update Project Without Fetching…',
      commit: 'Commit…',
      push: 'Push…',
    };
  }
  const what = scopeRepos.length === 1 ? 'Repository' : `${scopeRepos.length} Repositories`;
  return {
    roots: scopeRepos.map((r) => r.root),
    project: false,
    update: `Update ${what}…`,
    updateWithoutFetch: `Update ${what} Without Fetching…`,
    commit: `Commit ${what}…`,
    push: `Push ${what}…`,
  };
}

// ---------------------------------------------------------------------------
// Where a branch is: its row's words, with several repositories in view
// ---------------------------------------------------------------------------

/**
 * Which repositories in view have a branch, said on its row (POST-P14bt). A name is one
 * row however many repositories have it, so without these words a search's matches said
 * nothing of where they were, unless the Repository Dots were on.
 */
export interface RowWhere {
  /** What the row says: `in api, web`, `in both`, `in all 20`, `in 13 of 20`. */
  readonly text: string;
  /** What a narrow sidebar's row says: `text` while that is short, else a count, `in 2`. */
  readonly short: string;
  /** The row's hover: every repository it is in, those it is not when few, where it is checked out. */
  readonly title: string;
  /** What a screen reader hears after the name: `in api and web`, `in 13 of 20 repositories`. */
  readonly spoken: string;
}

/** A narrow sidebar's row keeps `text` up to this many characters, and counts instead past it. */
export const SHORT_WHERE = 10;

/** `api`, `api and web`, `api, shared and web`. */
function inWords(labels: readonly string[]): string {
  if (labels.length <= 1) return labels.join('');
  return `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;
}

/**
 * What a branch's row says about where it is, or nothing while one repository is in view
 * (the scope pill, or the workspace, names it then). The repositories in view that have it
 * are named while they are few (up to `NAMED_REPOS`, as a card's lines name them) and
 * counted past that. Every one of them reads `in all 20` (`in both` of two), not a row left
 * blank: a blank cannot be told from a row that says nothing.
 */
export function whereOf(
  entry: BranchEntry,
  scopeRepos: readonly BranchPanelRepoDto[],
): RowWhere | undefined {
  const total = scopeRepos.length;
  if (total < 2) return undefined;
  const has = new Set(entry.presence.map((p) => p.repo.root));
  // In the panel's order, as the REPOSITORIES pane lists them.
  const named = scopeRepos.filter((r) => has.has(r.root)).map((r) => r.label);
  const lacking = scopeRepos.filter((r) => !has.has(r.root)).map((r) => r.label);
  const n = named.length;
  if (n === 0) return undefined;
  const everywhere = lacking.length === 0;
  const few = n <= NAMED_REPOS;

  const text = everywhere
    ? total === 2
      ? 'in both'
      : `in all ${total}`
    : few
      ? `in ${named.join(', ')}`
      : `in ${n} of ${total}`;
  const spoken = everywhere
    ? total === 2
      ? 'in both repositories'
      : `in all ${total} repositories`
    : few
      ? `in ${inWords(named)}`
      : `in ${n} of ${total} repositories`;

  const title: string[] = [];
  if (everywhere) {
    title.push(
      few
        ? `In ${total === 2 ? 'both' : `all ${total}`} repositories: ${inWords(named)}`
        : `In all ${total} repositories`,
    );
  } else {
    title.push(few ? `In ${inWords(named)}` : `In ${n} of ${total} repositories: ${named.join(', ')}`);
    // The few without it, when they are few: in 17 of 20, the three are the news.
    if (lacking.length <= NAMED_REPOS) title.push(`Not in ${inWords(lacking)}`);
  }
  const current = scopeRepos
    .filter((r) => entry.currentIn.includes(r.root))
    .map((r) => r.label);
  // Checked out everywhere it is, the row's check says it all; in some, the check is dim.
  if (current.length > 0 && current.length < n) title.push(`Checked out in ${inWords(current)}`);

  return {
    text,
    short: text.length <= SHORT_WHERE ? text : `in ${n}`,
    title: title.join('\n'),
    spoken,
  };
}

interface Level {
  readonly folders: Array<{ readonly name: string; readonly prefix: string; readonly count: number }>;
  readonly entries: BranchEntry[];
}

/** One folder level: the folders directly under `prefix` (of `relative` names), then its entries. */
function splitLevel(
  entries: readonly BranchEntry[],
  prefix: string,
  relative: (e: BranchEntry) => string,
): Level {
  const counts = new Map<string, number>();
  const direct: BranchEntry[] = [];
  for (const entry of entries) {
    const name = relative(entry);
    if (!name.startsWith(prefix)) continue;
    const rest = name.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash === -1) direct.push(entry);
    else {
      const folder = rest.slice(0, slash);
      counts.set(folder, (counts.get(folder) ?? 0) + 1);
    }
  }
  return {
    folders: [...counts.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([name, count]) => ({ name, prefix: `${prefix}${name}/`, count })),
    entries: direct,
  };
}

export function buildPanel(state: BranchPanelStateDto, ui: PanelUiState): PanelModel {
  const multi = state.repos.length > 1;
  const scopeRepos = scopeReposOf(state.repos, ui.scope);
  const markers = scopeRepos.length > 1;
  const narrowed = multi && scopeRepos.length < state.repos.length;
  const tokens = queryTokens(ui.query);
  const searching = tokens.length > 0;
  const repoRows: PanelRow[] = [];
  const branchRows: PanelRow[] = [];

  const locals = buildEntries(scopeRepos, 'local');
  const localByKey = new Map(locals.map((e) => [e.key, e]));

  const branchRow = (
    entry: BranchEntry,
    section: SectionId,
    depth: number,
    whole: boolean,
    shownName: string,
  ): PanelRow => {
    const id = `br:${section}:${entry.key}`;
    const card = ui.openCard === id;
    const lines = card
      ? cardLines(entry, { markers, scopeRepos, details: ui.detailsOf?.(entry), open: ui.openGroups })
      : undefined;
    const cut = whole ? shownName.lastIndexOf('/') + 1 : 0;
    const prefix = whole ? shownName.slice(0, cut) : '';
    const label = whole ? shownName.slice(cut) : shownName;
    const highlights = searching ? (matchRanges(prefix + label, tokens) ?? []) : [];
    // Several repositories in view: the row says which have it, in a search and in the tabs alike.
    const where = markers ? whereOf(entry, scopeRepos) : undefined;
    return {
      kind: 'branch',
      id,
      entry,
      section,
      depth,
      prefix,
      label,
      highlights,
      card,
      ...(lines !== undefined ? { cardLines: lines } : {}),
      ...(where !== undefined ? { where } : {}),
      height: ROW + (lines !== undefined ? cardHeight(lines) : 0),
    };
  };

  // ---- Repositories, or the one repository's current branch ---------------
  // Every repository's row, whether or not its pane is folded: the pane's
  // header counts them and folds them; the rows are the list it shows.
  if (multi) {
    for (const repo of state.repos) {
      repoRows.push({
        kind: 'repo',
        id: `repo:${repo.root}`,
        repo,
        inScope: scopeRepos.includes(repo),
        narrowed,
        only: narrowed && scopeRepos.length === 1 && scopeRepos[0] === repo,
        height: REPO,
      });
      if (repo.operation !== undefined) {
        repoRows.push({ kind: 'operation', id: `op:${repo.root}`, repo, height: OPERATION });
      }
    }
  } else {
    const repo = state.repos[0];
    if (repo !== undefined) {
      const entry = repo.head !== undefined ? localByKey.get(entryKey('local', repo.head)) : undefined;
      const id = `head:${repo.root}`;
      const card = ui.openCard === id;
      const lines = card
        ? cardLines(entry, {
            markers: false,
            scopeRepos,
            ...(entry !== undefined ? { details: ui.detailsOf?.(entry) } : {}),
            open: ui.openGroups,
          })
        : undefined;
      repoRows.push({
        kind: 'head',
        id,
        repo,
        ...(entry !== undefined ? { entry } : {}),
        card,
        ...(lines !== undefined ? { cardLines: lines } : {}),
        height: REPO + (lines !== undefined ? cardHeight(lines) : 0),
      });
      if (repo.operation !== undefined) {
        repoRows.push({ kind: 'operation', id: `op:${repo.root}`, repo, height: OPERATION });
      }
    }
  }

  let matches = 0;

  /**
   * A section of branch entries. Searching lists the matches flat, by whole
   * name; otherwise names fold into folders on `/` (when the setting says so).
   */
  const pushSection = (
    section: SectionId,
    entries: readonly BranchEntry[],
    order: (a: BranchEntry, b: BranchEntry) => number,
    fold: boolean,
    relative: (e: BranchEntry) => string = (e) => e.name,
    depth = 0,
    idPrefix: string = section,
  ): void => {
    if (searching) {
      const hits = entries.filter((e) => matchRanges(e.name, tokens) !== undefined).sort(order);
      if (hits.length === 0) return;
      matches += hits.length;
      const id = `sec:${section}`;
      branchRows.push({
        kind: 'section',
        id,
        section,
        label: SECTION_LABEL[section],
        count: hits.length,
        open: true,
        height: SECTION,
      });
      for (const entry of hits) branchRows.push(branchRow(entry, section, 0, true, entry.name));
      return;
    }
    if (!fold) {
      for (const entry of [...entries].sort(order)) {
        branchRows.push(branchRow(entry, section, depth, true, relative(entry)));
      }
      return;
    }
    const walk = (prefix: string, level: number): void => {
      const { folders, entries: direct } = splitLevel(entries, prefix, relative);
      for (const folder of folders) {
        const id = `dir:${idPrefix}:${folder.prefix}`;
        const holdsCurrent = entries.some(
          (e) => e.currentIn.length > 0 && relative(e).startsWith(folder.prefix),
        );
        const open = isOpen(id, holdsCurrent, ui);
        branchRows.push({
          kind: 'folder',
          id,
          label: folder.name,
          count: folder.count,
          open,
          depth: level,
          height: ROW,
        });
        if (open) walk(folder.prefix, level + 1);
      }
      for (const entry of direct.sort(order)) {
        branchRows.push(branchRow(entry, section, level, false, relative(entry).slice(prefix.length)));
      }
    };
    walk('', depth);
  };

  const recent = recentEntries(scopeRepos, localByKey);
  const remotes = buildEntries(scopeRepos, 'remote');
  const tags = state.showTags ? buildEntries(scopeRepos, 'tag') : [];
  const tab = shownTab(ui.tab, recent.length, state.showTags);

  /** What the model hands back: the two lists, and both in order. */
  const done = (): PanelModel => ({
    repoRows,
    branchRows,
    rows: [...repoRows, ...branchRows],
    scopeRepos,
    multi,
    markers,
    matches,
    tab,
  });

  // ---- Searching: every kind at once, each under its heading --------------
  if (searching) {
    pushSection('local', locals, compareEntries, false);
    pushSection('remote', remotes, compareEntries, false);
    if (state.showTags) pushSection('tags', tags, compareTags, false);
    if (matches === 0) {
      const name = ui.query.trim();
      branchRows.push({
        kind: 'hint',
        id: 'hint:nomatch',
        text: `No branch matches “${name}”.`,
        ...(isPlausibleBranchName(name) ? { create: name } : {}),
        height: HINT,
      });
    }
    return done();
  }

  // ---- The tabs, then the one kind they show ------------------------------
  const counts: TabCount[] = [
    { id: 'recent', label: SECTION_LABEL.recent, count: recent.length },
    { id: 'local', label: SECTION_LABEL.local, count: locals.length },
    { id: 'remote', label: SECTION_LABEL.remote, count: remotes.length },
    ...(state.showTags ? [{ id: 'tags' as const, label: SECTION_LABEL.tags, count: tags.length }] : []),
  ];
  branchRows.push({ kind: 'tabs', id: TABS_ID, tabs: counts, active: tab, height: TABS });
  const hint = (id: string, text: string): void => {
    branchRows.push({ kind: 'hint', id: `hint:${id}`, text, height: HINT });
  };

  switch (tab) {
    case 'recent':
      if (recent.length === 0) hint('recent', 'No recent branches yet. The ones you check out or star appear here.');
      for (const entry of recent) branchRows.push(branchRow(entry, 'recent', 0, true, entry.name));
      break;
    case 'local':
      if (locals.length === 0) {
        hint(
          'local',
          scopeRepos.every((r) => r.unborn) ? 'No branches yet: the first commit creates one.' : 'No local branches.',
        );
      }
      pushSection('local', locals, compareEntries, state.groupByFolder);
      break;
    case 'remote': {
      // One group per remote, each folded the way Local is.
      if (remotes.length === 0) hint('remote', 'No remote branches.');
      const names = [...new Set(remotes.map((e) => remoteOf(e)))].sort((a, b) => a.localeCompare(b));
      for (const remote of names) {
        const mine = remotes.filter((e) => remoteOf(e) === remote);
        const id = `rem:${remote}`;
        const open = isOpen(id, true, ui);
        branchRows.push({ kind: 'remote', id, remote, count: mine.length, open, depth: 0, height: ROW });
        if (!open) continue;
        pushSection(
          'remote',
          mine,
          compareEntries,
          state.groupByFolder,
          (e) => e.name.slice(remote.length + 1),
          1,
          `remote:${remote}`,
        );
      }
      break;
    }
    case 'tags':
      if (tags.length === 0) hint('tags', 'No tags.');
      pushSection('tags', tags, compareTags, false);
      break;
  }

  return done();
}

/** The remote a remote-branch entry belongs to: `origin` of `origin/x`. */
export function remoteOf(entry: BranchEntry): string {
  const declared = entry.presence.find((p) => p.ref.remote !== undefined)?.ref.remote;
  if (declared !== undefined) return declared;
  const slash = entry.name.indexOf('/');
  return slash === -1 ? entry.name : entry.name.slice(0, slash);
}

/** Cheap pre-check before offering "Create branch 'x'": no spaces, no git-forbidden characters. */
export function isPlausibleBranchName(name: string): boolean {
  return (
    name.length > 0 &&
    !/[\s~^:?*[\\]/u.test(name) &&
    !name.startsWith('-') &&
    !name.startsWith('/') &&
    !name.endsWith('/') &&
    !name.endsWith('.') &&
    !name.includes('..')
  );
}

// ---------------------------------------------------------------------------
// The row's own buttons (shown on hover) and the card's text
// ---------------------------------------------------------------------------

export type QuickAction = 'checkout' | 'update' | 'push' | 'star' | 'menu';

/**
 * The buttons a branch row shows under the pointer, decided without asking the
 * host so they appear the moment the pointer arrives. The card's buttons and
 * the menu come from the host, which knows every rule; these are the obvious
 * cases only.
 */
export function quickActions(entry: BranchEntry): QuickAction[] {
  const out: QuickAction[] = [];
  const everywhere = isCurrentEverywhere(entry);
  if (entry.kind === 'remote') out.push('checkout');
  if (entry.kind === 'local') {
    if (!everywhere) out.push('checkout');
    else {
      const tracked = entry.presence.some((p) => p.ref.upstream !== undefined && p.ref.gone !== true);
      if (tracked) out.push('update');
      out.push('push');
    }
    out.push('star');
  }
  out.push('menu');
  return out;
}

/** `5m`, `3h`, `2d`, `3w`, `4mo`, `2y` — a row's age column. */
export function shortAge(now: number, then: number | undefined): string {
  if (then === undefined) return '';
  const s = Math.max(0, now - then);
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)}d`;
  if (s < 86400 * 30) return `${Math.floor(s / (86400 * 7))}w`;
  if (s < 86400 * 365) return `${Math.floor(s / (86400 * 30))}mo`;
  return `${Math.floor(s / (86400 * 365))}y`;
}

/** `5 minutes ago`, `yesterday`, `3 weeks ago` — a card's age. */
export function longAge(now: number, then: number | undefined): string {
  if (then === undefined) return '';
  const s = Math.max(0, now - then);
  const plural = (n: number, unit: string): string => `${n} ${unit}${n === 1 ? '' : 's'} ago`;
  if (s < 60) return 'just now';
  if (s < 3600) return plural(Math.floor(s / 60), 'minute');
  if (s < 86400) return plural(Math.floor(s / 3600), 'hour');
  const days = Math.floor(s / 86400);
  if (days === 1) return 'yesterday';
  if (days < 7) return plural(days, 'day');
  if (days < 30) return plural(Math.floor(days / 7), 'week');
  if (days < 365) return plural(Math.floor(days / 30), 'month');
  return plural(Math.floor(days / 365), 'year');
}

function commits(n: number): string {
  return `${n} commit${n === 1 ? '' : 's'}`;
}

/**
 * Where a ref stands against what it tracks, in a few words: `↑2 to push`,
 * `↓3 to pull`, `Up to date with origin/main`, `Not published`,
 * `origin/x was deleted`. `twin` is the remote branch of a local branch's own
 * name: a branch with no upstream is not unpublished while one exists.
 */
export function trackingText(
  ref: BranchPanelRefDto,
  kind: BranchPanelRefKind,
  trackedBy?: string,
  twin?: string,
): string {
  if (kind === 'tag') return 'Tag';
  if (kind === 'remote') {
    return trackedBy !== undefined ? `Checked out locally as ${trackedBy}` : 'Not checked out locally';
  }
  if (ref.upstream === undefined) return twin !== undefined ? `Not tracking ${twin}` : 'Not published';
  if (ref.gone === true) return `${ref.upstream} was deleted on the remote`;
  const parts: string[] = [];
  if ((ref.ahead ?? 0) > 0) parts.push(`${ref.ahead} to push`);
  if ((ref.behind ?? 0) > 0) parts.push(`${ref.behind} to pull`);
  return parts.length > 0 ? `${parts.join(', ')} · ${ref.upstream}` : `Up to date with ${ref.upstream}`;
}

/** How a ref relates to what is checked out: `3 commits ahead of main`, `Already in main`. */
export function relationText(details: BranchPanelRepoDetailsDto | undefined): string | undefined {
  const vs = details?.vsHead;
  if (vs === undefined) return undefined;
  if (vs.ahead === 0 && vs.behind === 0) return `Same commit as ${vs.head}`;
  if (vs.ahead === 0) return `Already in ${vs.head}`;
  if (vs.behind === 0) return `${commits(vs.ahead)} ahead of ${vs.head}`;
  return `${commits(vs.ahead)} ahead of ${vs.head}, ${vs.behind} behind`;
}

/**
 * The few words a repository's line in a multi-repository card has room for:
 * `↑2 ↓4`, `up to date`, `not published`, `upstream gone`; for a remote
 * branch, the local branch that tracks it.
 */
export function trackingShort(
  ref: BranchPanelRefDto,
  kind: BranchPanelRefKind,
  trackedBy?: string,
  twin?: string,
): string {
  if (kind === 'tag') return 'tag';
  if (kind === 'remote') return trackedBy !== undefined ? `local ${trackedBy}` : 'not checked out';
  if (ref.upstream === undefined) return twin !== undefined ? 'not tracking' : 'not published';
  if (ref.gone === true) return 'upstream gone';
  const parts: string[] = [];
  if ((ref.behind ?? 0) > 0) parts.push(`↓${ref.behind}`);
  if ((ref.ahead ?? 0) > 0) parts.push(`↑${ref.ahead}`);
  return parts.length > 0 ? parts.join(' ') : 'up to date';
}

/** The same relation as `relationText`, against "current", for a line that names its repository. */
export function relationShort(details: BranchPanelRepoDetailsDto | undefined): string | undefined {
  const vs = details?.vsHead;
  if (vs === undefined) return undefined;
  if (vs.ahead === 0 && vs.behind === 0) return 'same as current';
  if (vs.ahead === 0) return 'in current';
  if (vs.behind === 0) return `${vs.ahead} ahead of current`;
  return `${vs.ahead} ahead, ${vs.behind} behind current`;
}
