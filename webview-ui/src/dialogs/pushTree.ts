/**
 * The Push dialog's left tree, as IntelliJ's `PushLog` builds it: a row per
 * repository — `source → remote : branch` — and under it the outgoing commits,
 * twenty at first and a `...` row that doubles them; an error the commits
 * could not be listed for stands where they would. Pure: rows, which commits
 * a selection means, and whether the dialog can push.
 */
import type { TargetVariant } from '../../../src/scm/dialogs/pushModel';
import type { PushCommitDto, PushRepoDto, PushTargetDto } from '../../../src/shared/protocol';

/** `DEFAULT_CHILDREN_PRESENTATION_NUMBER`. */
export const INITIAL_SHOWN_COMMITS = 20;

/** One repository as the dialog holds it — what it opened with, and what the user changed. */
export interface RepoState {
  readonly dto: PushRepoDto;
  readonly target?: PushTargetDto;
  readonly commits: readonly PushCommitDto[];
  readonly loadError?: string;
  readonly checked: boolean;
  /** Its commits are being listed again for a new target. */
  readonly loading: boolean;
  /** `Set upstream`, as last left in the target editor. */
  readonly setUpstream: boolean;
  /** How many commits the row shows before its `...`. */
  readonly shown: number;
}

export function repoStateOf(dto: PushRepoDto): RepoState {
  return {
    dto,
    ...(dto.target !== undefined ? { target: dto.target } : {}),
    commits: dto.commits,
    ...(dto.loadError !== undefined ? { loadError: dto.loadError } : {}),
    checked: dto.checked,
    loading: false,
    setUpstream: false,
    shown: INITIAL_SHOWN_COMMITS,
  };
}

export type PushRow =
  | { readonly kind: 'repo'; readonly key: string; readonly root: string }
  | { readonly kind: 'commit'; readonly key: string; readonly root: string; readonly commit: PushCommitDto }
  | { readonly kind: 'more'; readonly key: string; readonly root: string }
  | { readonly kind: 'error'; readonly key: string; readonly root: string; readonly text: string };

export const repoKey = (root: string): string => `r\u0000${root}`;
export const commitKey = (root: string, sha: string): string => `c\u0000${root}\u0000${sha}`;

/**
 * The visible rows. With one repository its row is always open, as IntelliJ
 * shows no handle to close it; with several, `expanded` decides.
 */
export function buildRows(
  repos: readonly RepoState[],
  expanded: ReadonlySet<string>,
  single: boolean,
): PushRow[] {
  const rows: PushRow[] = [];
  for (const repo of repos) {
    const root = repo.dto.root;
    rows.push({ kind: 'repo', key: repoKey(root), root });
    if (!single && !expanded.has(root)) continue;
    if (repo.loadError !== undefined) {
      rows.push({ kind: 'error', key: `e\u0000${root}`, root, text: repo.loadError });
      continue;
    }
    for (const commit of repo.commits.slice(0, repo.shown)) {
      rows.push({ kind: 'commit', key: commitKey(root, commit.sha), root, commit });
    }
    if (repo.commits.length > repo.shown) rows.push({ kind: 'more', key: `m\u0000${root}`, root });
  }
  return rows;
}

/** A repository has rows under it to open. */
export function hasChildren(repo: RepoState): boolean {
  return repo.loadError !== undefined || repo.commits.length > 0;
}

/** The commits a selection means, per repository, oldest first — what the changes are built from. */
export interface SelectedCommits {
  readonly byRepo: ReadonlyMap<string, readonly string[]>;
  readonly count: number;
  /** A repository row is among the selection. */
  readonly repoSelected: boolean;
  /** The only commit, when exactly one is meant and no repository row is selected. */
  readonly single?: { readonly root: string; readonly commit: PushCommitDto };
}

/**
 * `PushLog.collectSelectedCommitNodes`: a selected repository row means all
 * its commits; then the selected commits not already counted. Bottom row
 * first, as IntelliJ walks them, so each repository's list runs oldest first.
 */
export function selectedCommits(
  rows: readonly PushRow[],
  selection: ReadonlySet<string>,
  repos: readonly RepoState[],
): SelectedCommits {
  const byRoot = new Map(repos.map((r) => [r.dto.root, r]));
  const picked = rows.filter((r) => selection.has(r.key)).reverse();
  const out = new Map<string, string[]>();
  const seen = new Set<string>();
  const shaOf = new Map<string, PushCommitDto>();
  const add = (root: string, commit: PushCommitDto): void => {
    const key = commitKey(root, commit.sha);
    if (seen.has(key)) return;
    seen.add(key);
    shaOf.set(key, commit);
    const list = out.get(root) ?? [];
    list.push(commit.sha);
    out.set(root, list);
  };
  let repoSelected = false;
  for (const row of picked) {
    if (row.kind !== 'repo') continue;
    repoSelected = true;
    const repo = byRoot.get(row.root);
    if (!repo) continue;
    for (const commit of [...repo.commits].reverse()) add(row.root, commit);
  }
  for (const row of picked) if (row.kind === 'commit') add(row.root, row.commit);
  const result: SelectedCommits = { byRepo: out, count: seen.size, repoSelected };
  if (seen.size === 1 && !repoSelected) {
    const [key] = [...seen];
    const [root] = [...out.keys()];
    const commit = shaOf.get(key!);
    if (root !== undefined && commit !== undefined) return { ...result, single: { root, commit } };
  }
  return result;
}

/** The repository can be pushed: it has a target, and commits to have. */
export function pushable(repo: RepoState): boolean {
  return repo.target !== undefined && repo.dto.error === undefined;
}

/** `PushController.isPushAllowed`: not while a target is being edited, and some checked repository can be pushed. */
export function canPush(repos: readonly RepoState[], editing: boolean): boolean {
  return !editing && repos.some((r) => r.checked && pushable(r));
}

/** The repositories the push covers. */
export function chosenRepos(repos: readonly RepoState[]): RepoState[] {
  return repos.filter((r) => r.checked && pushable(r));
}

/**
 * Space on the tree (`toggleRepositoriesFromCommits`): the selected rows'
 * repositories — a commit counts for its own — all take the opposite of the
 * first one's state. A repository with no target cannot be ticked.
 */
export function toggledByKeyboard(
  rows: readonly PushRow[],
  selection: ReadonlySet<string>,
  repos: readonly RepoState[],
): Map<string, boolean> {
  const byRoot = new Map(repos.map((r) => [r.dto.root, r]));
  const roots: string[] = [];
  for (const row of rows) {
    if (!selection.has(row.key) || roots.includes(row.root)) continue;
    if (byRoot.get(row.root)?.target !== undefined) roots.push(row.root);
  }
  const first = roots[0] !== undefined ? byRoot.get(roots[0]) : undefined;
  if (!first) return new Map();
  return new Map(roots.map((root) => [root, !first.checked]));
}

/**
 * The row selected when the dialog opens: the repository asked for, else
 * (`selectIfNothingSelected`) the first checked one with commits to push.
 */
export function initialSelection(repos: readonly RepoState[], highlight: string | undefined): string | undefined {
  if (highlight !== undefined && repos.some((r) => r.dto.root === highlight)) return repoKey(highlight);
  const first = repos.find((r) => r.checked && r.commits.length > 0);
  return first !== undefined ? repoKey(first.dto.root) : undefined;
}

/**
 * The target field's suggestions for what is typed: those starting with it
 * first, then the others containing it, each group in IntelliJ's order.
 */
export function matchVariants(variants: readonly TargetVariant[], text: string): TargetVariant[] {
  const q = text.toLowerCase();
  if (q.length === 0) return [...variants];
  const starts = variants.filter((v) => v.name.toLowerCase().startsWith(q));
  const contains = variants.filter(
    (v) => !v.name.toLowerCase().startsWith(q) && v.name.toLowerCase().includes(q),
  );
  return [...starts, ...contains];
}
