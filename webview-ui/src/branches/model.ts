/**
 * The Branches panel's rows, from the host's state and the panel's own view
 * state (new-way-4). Pure: no React, no DOM, so every rule is unit-tested.
 *
 * **One list for every repository.** A branch name is one row however many
 * repositories have it; the row carries a marker per repository in view, and
 * whatever the row does, it does in the repositories it stands for. Narrowing
 * the view to some repositories (the scope) narrows both the rows and what
 * they act on.
 *
 * **What is wanted first comes first**: the repositories and what each has
 * checked out, then the branches recently used and the starred ones, then
 * every local branch, then the remote ones and the tags, which start shut.
 *
 * **Searching flattens.** With text in the filter, sections hold their matches
 * as one flat list of whole names, matched letters marked, Recent gives way to
 * avoid listing a match twice, and every section with a match opens.
 */
import type {
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

export type SectionId = 'repos' | 'recent' | 'local' | 'remote' | 'tags';

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
      readonly height: number;
    }
  | {
      readonly kind: 'hint';
      readonly id: string;
      readonly text: string;
      /** A name the search offers to create. */
      readonly create?: string;
      readonly height: number;
    };

export interface PanelUiState {
  readonly query: string;
  /** Roots the panel is narrowed to; empty means every repository. */
  readonly scope: readonly string[];
  /** Ids whose open state differs from their default. */
  readonly toggled: ReadonlySet<string>;
  /** The row whose card is open. */
  readonly openCard?: string;
}

export interface PanelModel {
  readonly rows: readonly PanelRow[];
  /** Repositories whose branches are listed and acted on. */
  readonly scopeRepos: readonly BranchPanelRepoDto[];
  /** More than one repository in the workspace. */
  readonly multi: boolean;
  /** More than one repository in view: rows carry repository markers. */
  readonly markers: boolean;
  /** Matches across every section, while searching. */
  readonly matches: number;
}

const SECTION_LABEL: Record<SectionId, string> = {
  repos: 'Repositories',
  recent: 'Recent',
  local: 'Local',
  remote: 'Remote',
  tags: 'Tags',
};

/** What is open before anyone touches it. */
function defaultOpen(section: SectionId): boolean {
  return section !== 'remote' && section !== 'tags';
}

function isOpen(id: string, byDefault: boolean, ui: PanelUiState): boolean {
  return ui.toggled.has(id) ? !byDefault : byDefault;
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

/** Lines in a branch's card: what `cardHeight` sizes and the card draws. */
export function cardLineCount(entry: BranchEntry | undefined, markers: boolean): number {
  if (entry === undefined) return 2;
  if (markers && entry.presence.length > 1) return 1 + entry.presence.length;
  return isCurrentEverywhere(entry) ? 2 : 3;
}

export function cardHeight(entry: BranchEntry | undefined, markers: boolean): number {
  return CARD_PAD + cardLineCount(entry, markers) * CARD_LINE + CARD_BUTTONS;
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
  const rows: PanelRow[] = [];

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
    const cut = whole ? shownName.lastIndexOf('/') + 1 : 0;
    const prefix = whole ? shownName.slice(0, cut) : '';
    const label = whole ? shownName.slice(cut) : shownName;
    const highlights = searching ? (matchRanges(prefix + label, tokens) ?? []) : [];
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
      height: ROW + (card ? cardHeight(entry, markers) : 0),
    };
  };

  // ---- Repositories, or the one repository's current branch ---------------
  if (multi) {
    const id = 'sec:repos';
    const open = isOpen(id, true, ui);
    rows.push({
      kind: 'section',
      id,
      section: 'repos',
      label: SECTION_LABEL.repos,
      count: state.repos.length,
      open,
      height: SECTION,
    });
    if (open) {
      for (const repo of state.repos) {
        rows.push({
          kind: 'repo',
          id: `repo:${repo.root}`,
          repo,
          inScope: scopeRepos.includes(repo),
          narrowed,
          height: REPO,
        });
        if (repo.operation !== undefined) {
          rows.push({ kind: 'operation', id: `op:${repo.root}`, repo, height: OPERATION });
        }
      }
    }
  } else {
    const repo = state.repos[0];
    if (repo !== undefined) {
      const entry = repo.head !== undefined ? localByKey.get(entryKey('local', repo.head)) : undefined;
      const id = `head:${repo.root}`;
      const card = ui.openCard === id;
      rows.push({
        kind: 'head',
        id,
        repo,
        ...(entry !== undefined ? { entry } : {}),
        card,
        height: REPO + (card ? cardHeight(entry, false) : 0),
      });
      if (repo.operation !== undefined) {
        rows.push({ kind: 'operation', id: `op:${repo.root}`, repo, height: OPERATION });
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
      rows.push({
        kind: 'section',
        id,
        section,
        label: SECTION_LABEL[section],
        count: hits.length,
        open: true,
        height: SECTION,
      });
      for (const entry of hits) rows.push(branchRow(entry, section, 0, true, entry.name));
      return;
    }
    if (!fold) {
      for (const entry of [...entries].sort(order)) {
        rows.push(branchRow(entry, section, depth, true, relative(entry)));
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
        rows.push({
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
        rows.push(branchRow(entry, section, level, false, relative(entry).slice(prefix.length)));
      }
    };
    walk('', depth);
  };

  const sectionHeader = (section: SectionId, count: number): boolean => {
    const id = `sec:${section}`;
    const open = isOpen(id, defaultOpen(section), ui);
    rows.push({
      kind: 'section',
      id,
      section,
      label: SECTION_LABEL[section],
      count,
      open,
      height: SECTION,
    });
    return open;
  };

  // ---- Recent -------------------------------------------------------------
  if (!searching) {
    const recent = recentEntries(scopeRepos, localByKey);
    if (recent.length > 0 && sectionHeader('recent', recent.length)) {
      for (const entry of recent) rows.push(branchRow(entry, 'recent', 0, true, entry.name));
    }
  }

  // ---- Local --------------------------------------------------------------
  if (searching) pushSection('local', locals, compareEntries, false);
  else if (sectionHeader('local', locals.length)) {
    if (locals.length === 0) {
      rows.push({
        kind: 'hint',
        id: 'hint:local',
        text: scopeRepos.every((r) => r.unborn)
          ? 'No branches yet: the first commit creates one.'
          : 'No local branches.',
        height: HINT,
      });
    }
    pushSection('local', locals, compareEntries, state.groupByFolder);
  }

  // ---- Remote, one group per remote ---------------------------------------
  const remotes = buildEntries(scopeRepos, 'remote');
  if (searching) pushSection('remote', remotes, compareEntries, false);
  else if (remotes.length > 0 && sectionHeader('remote', remotes.length)) {
    const names = [...new Set(remotes.map((e) => remoteOf(e)))].sort((a, b) => a.localeCompare(b));
    for (const remote of names) {
      const mine = remotes.filter((e) => remoteOf(e) === remote);
      const id = `rem:${remote}`;
      const open = isOpen(id, true, ui);
      rows.push({ kind: 'remote', id, remote, count: mine.length, open, depth: 0, height: ROW });
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
  }

  // ---- Tags ---------------------------------------------------------------
  if (state.showTags) {
    const tags = buildEntries(scopeRepos, 'tag');
    if (searching) pushSection('tags', tags, compareTags, false);
    else if (tags.length > 0 && sectionHeader('tags', tags.length)) {
      pushSection('tags', tags, compareTags, false);
    }
  }

  if (searching && matches === 0) {
    const name = ui.query.trim();
    rows.push({
      kind: 'hint',
      id: 'hint:nomatch',
      text: `No branch matches “${name}”.`,
      ...(isPlausibleBranchName(name) ? { create: name } : {}),
      height: HINT,
    });
  }

  return { rows, scopeRepos, multi, markers, matches };
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
 * `origin/x was deleted`.
 */
export function trackingText(ref: BranchPanelRefDto, kind: BranchPanelRefKind, trackedBy?: string): string {
  if (kind === 'tag') return 'Tag';
  if (kind === 'remote') {
    return trackedBy !== undefined ? `Checked out locally as ${trackedBy}` : 'Not checked out locally';
  }
  if (ref.upstream === undefined) return 'Not published';
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
export function trackingShort(ref: BranchPanelRefDto, kind: BranchPanelRefKind, trackedBy?: string): string {
  if (kind === 'tag') return 'tag';
  if (kind === 'remote') return trackedBy !== undefined ? `local ${trackedBy}` : 'not checked out';
  if (ref.upstream === undefined) return 'not published';
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
