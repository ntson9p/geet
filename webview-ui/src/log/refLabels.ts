/**
 * A commit's branch and tag labels, as IntelliJ's log draws them: grouped by
 * `GitRefManager.groupForTable`, fitted by `LabelPainter`. Each label is a tag
 * icon holding one colour per kind of ref in it, then a name in grey — or no
 * name, the icon alone. Pure: text widths come from the caller's `measure`, so
 * the grouping and the fitting are testable without a page.
 *
 * Presentation Settings decide the shape:
 * - **Compact References View** (on by default): every ref of a commit in one
 *   label, named after the first.
 * - Off: each branch its own label; a commit's tags share one.
 * - **Tag Names**: whether a label of tags alone carries the first tag's name.
 */
import type { RefChipDto } from '../../../src/shared/protocol';

/** IntelliJ's ref types, each with its icon colour (`GitRefManager`). */
export type RefKind = 'head' | 'local' | 'remote' | 'tag';

export interface LabelRef {
  readonly name: string;
  readonly kind: RefKind;
}

export interface RefGroup {
  /** `''` draws the icon alone. */
  readonly name: string;
  readonly refs: readonly LabelRef[];
  /** IntelliJ's `Detached HEAD` label: a warning icon and warning-coloured text. */
  readonly detached?: boolean;
}

/** What the row's repository says about its branches; from the Branches data. */
export interface RepoRefs {
  readonly currentBranch?: string;
  /** Local branch → the remote branch it tracks (`main` → `origin/main`). */
  readonly upstreams: ReadonlyMap<string, string>;
  readonly remotes: readonly string[];
}

export const NO_REPO_REFS: RepoRefs = { upstreams: new Map(), remotes: [] };

export const DETACHED_HEAD = 'Detached HEAD';
const DETACHED_HEAD_TOOLTIP =
  'New commits may be lost because the current commit is not on any branch.\nCheck out a branch to avoid that.';

const isBranch = (kind: RefKind): boolean => kind !== 'tag';

function kindOf(ref: RefChipDto): RefKind {
  switch (ref.type) {
    case 'remote-branch':
      return 'remote';
    case 'tag':
      return 'tag';
    case 'head':
      return 'head';
    case 'branch':
      return 'local';
  }
}

/**
 * IntelliJ's label order (`GitLabelComparator`): HEAD, the current branch,
 * `main`/`master`, `origin/main`/`origin/master`, other local branches, other
 * remote branches, tags; then by name.
 */
function rank(ref: LabelRef, currentBranch: string | undefined): number {
  switch (ref.kind) {
    case 'head':
      return 0;
    case 'local':
      if (ref.name === currentBranch) return 1;
      return ref.name === 'main' || ref.name === 'master' ? 2 : 4;
    case 'remote':
      return ref.name === 'origin/main' || ref.name === 'origin/master' ? 3 : 5;
    case 'tag':
      return 6;
  }
}

const byName = (a: string, b: string): number => a.localeCompare(b, undefined, { numeric: true });

/** The remote a remote branch belongs to: the longest configured remote that prefixes it. */
function remoteOf(branch: string, remotes: readonly string[]): string {
  let best = '';
  for (const remote of remotes) {
    if (branch.startsWith(`${remote}/`) && remote.length > best.length) best = remote;
  }
  return best.length > 0 ? best : (branch.split('/', 1)[0] ?? branch);
}

/**
 * The tracked pair for `local`: the remote branch it tracks, or failing that,
 * one named `<remote>/<local>` for a configured remote. IntelliJ names the pair
 * `origin & main`.
 */
function trackedGroup(local: LabelRef, remotes: readonly LabelRef[], repo: RepoRefs): RefGroup | undefined {
  const upstream = repo.upstreams.get(local.name);
  if (upstream !== undefined) {
    const tracked = remotes.find((r) => r.name === upstream);
    if (tracked !== undefined) {
      return { name: `${remoteOf(upstream, repo.remotes)} & ${local.name}`, refs: [local, tracked] };
    }
  }
  const candidates = remotes.filter((r) => r.name.endsWith(`/${local.name}`));
  for (const remote of repo.remotes) {
    const candidate = candidates.find((r) => r.name === `${remote}/${local.name}`);
    if (candidate !== undefined) return { name: `${remote} & ${local.name}`, refs: [local, candidate] };
  }
  return undefined;
}

/** `GitRefManager.groupForTable`. */
export function groupRefs(
  chips: readonly RefChipDto[],
  repo: RepoRefs,
  opts: { readonly compact: boolean; readonly showTagNames: boolean },
): RefGroup[] {
  if (chips.length === 0) return [];
  // HEAD is its own ref in IntelliJ. Geet's rows say so as `isHeadTarget`
  // on the branch it points at, or as a bare `HEAD` when it points at none.
  const detached = chips.some((c) => c.type === 'head');
  const headRefs: LabelRef[] =
    detached || chips.some((c) => c.isHeadTarget === true) ? [{ name: 'HEAD', kind: 'head' }] : [];

  const sorted = chips
    .filter((c) => c.type !== 'head')
    .map((c): LabelRef => ({ name: c.name, kind: kindOf(c) }))
    .sort((a, b) => rank(a, repo.currentBranch) - rank(b, repo.currentBranch) || byName(a.name, b.name));
  // Grouped by kind, kinds in the order they first appear: IntelliJ's linked MultiMap.
  const grouped = new Map<RefKind, LabelRef[]>();
  for (const ref of sorted) grouped.set(ref.kind, [...(grouped.get(ref.kind) ?? []), ref]);

  const remotes = grouped.get('remote') ?? [];
  const tracked: RefGroup[] = [];
  for (const local of grouped.get('local') ?? []) {
    const group = trackedGroup(local, remotes, repo);
    if (group !== undefined) tracked.push(group);
  }
  const paired = new Set(tracked.flatMap((g) => g.refs));
  for (const [kind, refs] of grouped) grouped.set(kind, refs.filter((r) => !paired.has(r)));

  const locals = grouped.get('local') ?? [];
  const current = locals.find((r) => r.name === repo.currentBranch);
  if (current !== undefined) grouped.set('local', locals.filter((r) => r !== current));
  const refGroups: RefGroup[] = [
    ...(current !== undefined ? [{ name: current.name, refs: [current] }] : []),
    ...tracked,
  ];

  const groups = buildGroups(refGroups, grouped, opts.compact, opts.showTagNames);
  if (headRefs.length === 0) return groups;
  if (detached) return [{ name: DETACHED_HEAD, refs: headRefs, detached: true }, ...groups];
  if (groups.length === 0) return [{ name: '', refs: headRefs }];
  const [first, ...rest] = groups;
  return [{ ...first!, refs: [...headRefs, ...first!.refs] }, ...rest];
}

/** `SimpleRefGroup.buildGroups`. */
function buildGroups(
  refGroups: readonly RefGroup[],
  grouped: ReadonlyMap<RefKind, readonly LabelRef[]>,
  compact: boolean,
  showTagNames: boolean,
): RefGroup[] {
  const remaining = [...grouped.values()].flat();
  if (remaining.length === 0) return [...refGroups];
  if (compact) {
    if (refGroups.length === 0) {
      const first = remaining[0]!;
      return [{ name: isBranch(first.kind) || showTagNames ? first.name : '', refs: remaining }];
    }
    return [{ name: refGroups[0]!.name, refs: [...refGroups.flatMap((g) => g.refs), ...remaining] }];
  }
  const result = [...refGroups];
  for (const [kind, refs] of grouped) {
    if (refs.length === 0) continue;
    if (isBranch(kind)) result.push(...refs.map((ref) => ({ name: ref.name, refs: [ref] })));
    else result.push({ name: showTagNames ? refs[0]!.name : '', refs: [...refs] });
  }
  return result;
}

/**
 * The colours in a group's icon (`SimpleRefGroup.getColors`): one per kind of
 * ref in it, in the order the kinds appear, twice for a kind it holds more than
 * one of — which is how the icon shows that there are several.
 */
export function groupColors(group: RefGroup): RefKind[] {
  if (group.detached === true) return [];
  const counts = new Map<RefKind, number>();
  for (const ref of group.refs) counts.set(ref.kind, (counts.get(ref.kind) ?? 0) + 1);
  return [...counts].flatMap(([kind, n]) => (n > 1 ? [kind, kind] : [kind]));
}

/** The icon for several groups folded into one (`LabelPainter.getColors`). */
function mergedColors(groups: readonly RefGroup[]): RefKind[] {
  const counts = new Map<RefKind, number>();
  for (const group of groups) {
    for (const kind of groupColors(group)) counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  return [...counts].flatMap(([kind, n]) => (n > 1 ? [kind, kind] : [kind]));
}

// ---------------------------------------------------------------------------
// Fitting (`LabelPainter`)
// ---------------------------------------------------------------------------

/** IntelliJ's label metrics, in CSS pixels. */
export const LABEL_METRICS = {
  /** The icon's height: the label font's line height. */
  iconHeight: 16,
  leftPadding: 4,
  rightPadding: 4,
  middlePadding: 12,
  compactMiddlePadding: 6,
  iconTextPadding: 1,
  /** The warning icon of `Detached HEAD`, and the extra gap after it. */
  warningIconWidth: 16,
  warningIconPadding: 3,
} as const;

const MAX_LENGTH = 22;
const ELLIPSIS = '…';

/** A label's icon width for `count` colours: each one past the first adds a step. */
export function iconWidth(count: number, height: number = LABEL_METRICS.iconHeight): number {
  const size = 6.25;
  return Math.round((size + 2 * Math.max(0, count - 1)) * (height / size));
}

export interface RefLabel {
  readonly text: string;
  readonly colors: readonly RefKind[];
  readonly refs: readonly LabelRef[];
  readonly detached?: boolean;
  /** Icon, gap and text, in pixels. */
  readonly width: number;
}

export type Measure = (text: string) => number;

const textWidth = (measure: Measure, text: string): number => {
  const w = measure(text);
  return w > 0 ? LABEL_METRICS.iconTextPadding + w : 0;
};

/** `StringUtil.shortenTextWithEllipsis(text, maxLength, 0, …)`: the start, then `…`. */
function withEllipsis(text: string, maxLength: number): string {
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - ELLIPSIS.length)}${ELLIPSIS}`;
}

/**
 * `LabelPainter.shortenRefName`: a name that does not fit and is longer than
 * 22 characters loses what is before its first `/` (`..`), then its end, but
 * never below 22 characters. Shorter names are always shown whole.
 */
export function shortenRefName(name: string, measure: Measure, available: number): string {
  if (measure(name) <= available || name.length <= MAX_LENGTH) return name;
  const slash = name.indexOf('/');
  const text = slash > 2 ? `..${name.slice(slash)}` : name;
  if (available <= 0) return withEllipsis(text, MAX_LENGTH);
  if (measure(text) <= available) return text;
  for (let length = text.length; length > MAX_LENGTH; length--) {
    const shortened = withEllipsis(text, length);
    if (measure(shortened) <= available) return shortened;
  }
  return withEllipsis(text, MAX_LENGTH);
}

/**
 * The width the labels may take (`GraphCommitCellRenderer.getAvailableWidth`).
 * Compact: at most a third of the message column, and only what the message
 * leaves free. Otherwise: what the message leaves, but at least half the
 * column, or all of it bar 80 pixels of message. With the labels on the left
 * the message is not counted.
 */
export function labelsBudget(
  columnWidth: number,
  subjectWidth: number,
  compact: boolean,
  leftAligned: boolean,
): number {
  const free = columnWidth - (leftAligned ? 0 : subjectWidth);
  const allowed = compact
    ? Math.min(free, columnWidth / 3)
    : Math.max(free, Math.max(columnWidth / 2, columnWidth - 80));
  return Math.max(0, Math.floor(allowed));
}

/**
 * `LabelPainter.calculatePresentation`: the labels drawn within `available`
 * pixels. Without Compact References View, groups that no longer fit fold
 * into one last icon carrying all their colours — named only when it is the
 * first label. Names past 22 characters are shortened to fit.
 */
export function layoutLabels(
  groups: readonly RefGroup[],
  available: number,
  compact: boolean,
  measure: Measure,
): { labels: RefLabel[]; width: number } {
  if (groups.length === 0) return { labels: [], width: 0 };
  const m = LABEL_METRICS;
  const middle = compact ? m.compactMiddlePadding : m.middlePadding;
  const first = groups[0]!;
  const detached: RefLabel | undefined =
    first.detached === true
      ? {
          text: first.name,
          colors: [],
          refs: first.refs,
          detached: true,
          width: m.warningIconWidth + m.warningIconPadding + textWidth(measure, first.name),
        }
      : undefined;
  const remaining = available - (detached !== undefined ? detached.width + middle : 0) - m.leftPadding - m.rightPadding;

  const labels: RefLabel[] = [];
  let used = 0;
  for (let i = 0; i < groups.length; i++) {
    const group = groups[i]!;
    if (group.detached === true) continue;
    const rest = groups.slice(i + 1);
    const doNotFit = !compact && rest.length > 0 ? iconWidth(mergedColors(rest).length) : 0;
    const colors = groupColors(group);
    const isLast = i === groups.length - 1;
    let width = used + iconWidth(colors.length) + (isLast ? 0 : middle);
    const text = shortenRefName(group.name, measure, remaining - width - doNotFit);
    width += textWidth(measure, text);
    if (!compact && remaining - width - doNotFit < 0) {
      const folded = groups.slice(i);
      const foldedColors = mergedColors(folded);
      const name = labels.length === 0 ? text : '';
      labels.push({
        text: name,
        colors: foldedColors,
        refs: folded.flatMap((g) => g.refs),
        width: iconWidth(foldedColors.length) + textWidth(measure, name),
      });
      break;
    }
    labels.push({ text, colors, refs: group.refs, width: iconWidth(colors.length) + textWidth(measure, text) });
    used = width;
  }

  const all = detached !== undefined ? [detached, ...labels] : labels;
  const sum = all.reduce((w, l) => w + l.width, 0) + middle * Math.max(0, all.length - 1);
  return { labels: all, width: sum > 0 ? sum + m.leftPadding + m.rightPadding : 0 };
}

/** What hovering a label shows: its refs, one per line — or why a detached HEAD matters. */
export function labelTooltip(label: RefLabel): string {
  if (label.detached === true) return DETACHED_HEAD_TOOLTIP;
  return label.refs
    .filter((r) => r.kind !== 'head')
    .map((r) => r.name)
    .join('\n');
}

/** The Branches data a row's labels need. */
export function repoRefs(
  branches:
    | {
        readonly current?: string;
        readonly locals: ReadonlyArray<{ readonly name: string; readonly upstream?: string }>;
        readonly remotes: ReadonlyArray<{ readonly remote: string }>;
      }
    | null
    | undefined,
): RepoRefs {
  if (branches == null) return NO_REPO_REFS;
  const upstreams = new Map<string, string>();
  for (const local of branches.locals) {
    if (local.upstream !== undefined) upstreams.set(local.name, local.upstream);
  }
  return {
    ...(branches.current !== undefined ? { currentBranch: branches.current } : {}),
    upstreams,
    remotes: branches.remotes.map((r) => r.remote),
  };
}
