/**
 * The Branches panel's state, built from repository snapshots (new-way-4).
 *
 * Everything the panel draws without asking git again is decided here, from
 * the snapshot the status refresher already keeps: each repository's head,
 * its sync counts and working-tree changes, any operation git is in the middle
 * of, and its refs. What does cost git — recent branches, which branches are
 * merged — is read by the provider and handed in.
 *
 * vscode-free, so the rules are unit-tested without a window.
 */
import type { RefInfo } from '../core/model/refs';
import type { RepoSnapshot } from '../core/model/repositoryModel';
import type {
  BranchPanelOperationDto,
  BranchPanelRefDto,
  BranchPanelRepoDto,
} from '../shared/protocol';

export function toRefDto(ref: RefInfo): BranchPanelRefDto {
  return {
    name: ref.name,
    sha: ref.sha,
    ...(ref.creatorDate !== undefined ? { date: ref.creatorDate } : {}),
    ...(ref.subject !== undefined ? { subject: ref.subject } : {}),
    ...(ref.upstream !== undefined ? { upstream: ref.upstream } : {}),
    ...((ref.ahead ?? 0) > 0 ? { ahead: ref.ahead } : {}),
    ...((ref.behind ?? 0) > 0 ? { behind: ref.behind } : {}),
    ...(ref.upstreamGone === true ? { gone: true } : {}),
    ...(ref.type === 'head' && ref.isHead ? { current: true } : {}),
    ...(ref.remote !== undefined ? { remote: ref.remote } : {}),
  };
}

const REMOTES_PREFIX = 'refs/remotes/';

/**
 * The branch "merged" is measured against: where finished work lands.
 *
 * The remote's default branch first — `origin/HEAD`'s target, which is what a
 * pull request merges into and what `git clone` set up. A remote branch rather
 * than the local one on purpose: a branch merged through the hosting site has
 * reached `origin/main` the moment it was merged, while the local `main` only
 * knows once someone updates it. Then the conventional names, remote before
 * local. A repository with none of them has no answer, and the panel then says
 * nothing about merged-ness rather than guess.
 */
export function mainBranchOf(refs: readonly RefInfo[]): string | undefined {
  const heads = refs.filter(
    (r) => r.type === 'remote' && r.symrefTarget !== undefined && r.name.endsWith('/HEAD'),
  );
  const head = heads.find((r) => r.remote === 'origin') ?? heads[0];
  if (head?.symrefTarget?.startsWith(REMOTES_PREFIX) === true) {
    const target = head.symrefTarget.slice(REMOTES_PREFIX.length);
    if (refs.some((r) => r.type === 'remote' && r.name === target)) return target;
  }
  for (const name of ['origin/main', 'origin/master']) {
    if (refs.some((r) => r.type === 'remote' && r.name === name)) return name;
  }
  for (const name of ['main', 'master']) {
    if (refs.some((r) => r.type === 'head' && r.name === name)) return name;
  }
  return undefined;
}

/** The argv that lists the local branches whose tips `main` contains. */
export function mergedArgs(main: string): string[] {
  return ['for-each-ref', `--merged=${main}`, '--format=%(refname)', 'refs/heads/'];
}

const HEADS_PREFIX = 'refs/heads/';

/**
 * The local branches worth calling merged, from `mergedArgs`' output: every
 * branch whose tip main contains, except main itself and the local branch of
 * the same name.
 *
 * A branch sitting exactly on main's tip counts: a branch merged by
 * fast-forward looks just like that. So does one created from main with no
 * commit of its own yet, which is why Clean Up offers those unticked
 * (`CleanupCandidate.atMain`) rather than leaving them out.
 */
export function mergedBranches(
  output: string,
  refs: readonly RefInfo[],
  main: string,
): string[] {
  const mainRef = refs.find(
    (r) => (r.type === 'remote' || r.type === 'head') && r.name === main,
  );
  const mainLocal = mainRef?.type === 'remote' && mainRef.remote !== undefined
    ? main.slice(mainRef.remote.length + 1)
    : main;
  const out: string[] = [];
  for (const line of output.split('\n')) {
    const full = line.trim();
    if (!full.startsWith(HEADS_PREFIX)) continue;
    const name = full.slice(HEADS_PREFIX.length);
    if (name === main || name === mainLocal) continue;
    if (!refs.some((r) => r.type === 'head' && r.name === name)) continue;
    out.push(name);
  }
  return out.sort((a, b) => a.localeCompare(b));
}

/** A local branch Clean Up Branches offers to delete. */
export interface CleanupCandidate {
  readonly name: string;
  readonly sha: string;
  /** Every commit of it is on the main branch: deleting it loses nothing. */
  readonly merged: boolean;
  /** The remote branch it tracked was deleted — usually merged and removed by the hosting site. */
  readonly gone: boolean;
  /**
   * It sits exactly on main's tip: merged by fast-forward, or created from main
   * and not yet worked on. The two look the same, so it is offered unticked.
   */
  readonly atMain: boolean;
  readonly upstream?: string;
}

/**
 * The branches that look finished: merged into the main branch, or tracking a
 * remote branch that has been deleted. Never the checked-out one. A squash or
 * rebase merge on the hosting site leaves a branch that is not `merged` but is
 * `gone`, which is why both are offered — and why only the merged ones are
 * ticked to start with (`preTicked`).
 */
export function cleanupCandidates(
  refs: readonly RefInfo[],
  merged: readonly string[],
  mainSha?: string,
): CleanupCandidate[] {
  const mergedSet = new Set(merged);
  return refs
    .filter(
      (r) => r.type === 'head' && !r.isHead && (mergedSet.has(r.name) || r.upstreamGone === true),
    )
    .map((r) => ({
      name: r.name,
      sha: r.sha,
      merged: mergedSet.has(r.name),
      gone: r.upstreamGone === true,
      atMain: mainSha !== undefined && r.sha === mainSha,
      ...(r.upstream !== undefined ? { upstream: r.upstream } : {}),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Ticked when Clean Up opens: merged, with commits of its own that main now
 * has. Not a branch merely sitting on main's tip, which may be one just made;
 * not one whose remote branch went but whose commits main lacks.
 */
export function preTicked(candidate: CleanupCandidate): boolean {
  return candidate.merged && !candidate.atMain;
}

/** What git is in the middle of, in the panel's four words, with its conflicts. */
export function operationOf(snapshot: RepoSnapshot): BranchPanelOperationDto | undefined {
  const op = snapshot.inProgressOp;
  if (op === undefined) return undefined;
  const kind: BranchPanelOperationDto['kind'] = op.kind.startsWith('rebase')
    ? 'rebase'
    : op.kind === 'cherry-pick' || op.kind === 'revert'
      ? op.kind
      : 'merge';
  const conflicts = snapshot.statusEntries.filter((e) => e.kind === 'unmerged').length;
  return {
    kind,
    conflicts,
    ...(op.step !== undefined ? { step: op.step } : {}),
    ...(op.total !== undefined ? { total: op.total } : {}),
  };
}

/** Changed files as the Commit view counts them: ignored files are not changes. */
export function changeCount(snapshot: RepoSnapshot): number {
  return snapshot.statusEntries.filter((e) => e.kind !== 'ignored').length;
}

/**
 * The merged branches the panel marks: those with commits of their own that
 * main now has. A branch sitting on main's very tip is left unmarked — it may be
 * one just created, and a "merged" chip on a branch nobody has worked on yet
 * reads as a mistake. Clean Up still offers it, unticked.
 */
export function shownMerged(
  refs: readonly RefInfo[],
  merged: readonly string[],
  main: string | undefined,
): string[] {
  if (main === undefined) return [];
  const mainSha = refs.find((r) => (r.type === 'remote' || r.type === 'head') && r.name === main)?.sha;
  return merged.filter(
    (name) => refs.find((r) => r.type === 'head' && r.name === name)?.sha !== mainSha,
  );
}

export interface RepoPanelInput {
  readonly root: string;
  readonly label: string;
  readonly colorIdx: number;
  readonly snapshot: RepoSnapshot;
  readonly recent: readonly string[];
  readonly favorites: Iterable<string>;
  readonly mainBranch?: string;
  readonly merged: readonly string[];
  readonly fetching: boolean;
}

/** One repository, as the panel's first row and every branch row it owns read it. */
export function buildRepoDto(input: RepoPanelInput): BranchPanelRepoDto {
  const snap = input.snapshot;
  const locals = snap.refs.filter((r) => r.type === 'head');
  const head = snap.detached ? undefined : snap.headRef;
  const localNames = new Set(locals.map((r) => r.name));
  const operation = operationOf(snap);
  return {
    root: input.root,
    label: input.label,
    colorIdx: input.colorIdx,
    ...(head !== undefined ? { head } : {}),
    detached: snap.detached,
    ...(snap.headSha !== undefined ? { headSha: snap.headSha } : {}),
    unborn: snap.initial,
    ...(snap.upstream !== undefined ? { upstream: snap.upstream } : {}),
    ...((snap.ahead ?? 0) > 0 ? { ahead: snap.ahead } : {}),
    ...((snap.behind ?? 0) > 0 ? { behind: snap.behind } : {}),
    ...(snap.upstreamGone ? { upstreamGone: true } : {}),
    changes: changeCount(snap),
    ...(operation !== undefined ? { operation } : {}),
    fetching: input.fetching,
    locals: locals.map(toRefDto),
    remotes: snap.refs
      .filter((r) => r.type === 'remote' && r.symrefTarget === undefined)
      .map(toRefDto),
    tags: snap.refs.filter((r) => r.type === 'tag').map(toRefDto),
    // The reflog can name branches since deleted, and the current one is
    // already the first row; neither belongs in Recent.
    recent: input.recent.filter((name) => localNames.has(name) && name !== head),
    favorites: [...input.favorites].sort((a, b) => a.localeCompare(b)),
    ...(input.mainBranch !== undefined ? { mainBranch: input.mainBranch } : {}),
    merged: shownMerged(snap.refs, input.merged, input.mainBranch),
  };
}
