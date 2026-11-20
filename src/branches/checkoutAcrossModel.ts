/**
 * One branch checked out in every repository (POST-P14ax), vscode-free so every
 * rule is unit-tested: what each repository does, the argv it runs, the choices
 * the picker offers, and the one summary of the run.
 *
 * A branch is wanted by its name, wherever a repository keeps it. `release/2.0`
 * is a local branch in one repository and only `origin/release/2.0` in the next;
 * checking it out in "all of them" means the local branch where there is one, and
 * where there is not, a new local branch tracking the remote one — IntelliJ's
 * Checkout on a remote branch. A repository with neither stays where it is, and
 * the summary says so.
 */

/** One repository, as far as checking a branch out in it needs to know. */
export interface RepoRefState {
  readonly root: string;
  /** What Geet calls it everywhere. */
  readonly label: string;
  /** The checked-out branch; undefined when HEAD is detached. */
  readonly head: string | undefined;
  /** Why nothing can be checked out here now: a merge or rebase in progress. */
  readonly busy?: string;
  readonly locals: readonly string[];
  /** Remote branches, `origin/release/2.0`, with the remote each is on. */
  readonly remotes: readonly { readonly name: string; readonly remote: string }[];
  readonly tags: readonly string[];
  /** The remote the checked-out branch tracks: where to look first for a branch. */
  readonly trackingRemote?: string;
}

/** What is wanted: a branch by its own name, or a tag. */
export interface CheckoutTarget {
  readonly kind: 'branch' | 'tag';
  /** `release/2.0`, never `origin/release/2.0`. */
  readonly name: string;
  /** The remote to take it from where there is no local branch, when one was named. */
  readonly remote?: string;
}

export type CheckoutStep =
  /** A local branch of that name: switch to it. */
  | { readonly kind: 'switch'; readonly root: string; readonly name: string }
  /** Only a remote branch of that name: a new local branch tracking it. */
  | { readonly kind: 'create'; readonly root: string; readonly name: string; readonly from: string }
  /** A tag: check it out, detached. */
  | { readonly kind: 'tag'; readonly root: string; readonly name: string }
  | { readonly kind: 'already'; readonly root: string }
  | { readonly kind: 'missing'; readonly root: string }
  | { readonly kind: 'busy'; readonly root: string; readonly reason: string };

/** `origin/release/2.0` on `origin` is `release/2.0`. */
export function branchOfRemote(remoteBranch: string, remote: string): string {
  return remoteBranch.startsWith(`${remote}/`) ? remoteBranch.slice(remote.length + 1) : remoteBranch;
}

/**
 * The remote branch to start from where no local branch has the name: the remote
 * asked for, else the one the checked-out branch tracks, else `origin`, else the
 * first that has it.
 */
function remoteFor(state: RepoRefState, target: CheckoutTarget): string | undefined {
  const named = state.remotes.filter((r) => r.name === `${r.remote}/${target.name}`);
  const pick = (remote: string | undefined): string | undefined =>
    remote === undefined ? undefined : named.find((r) => r.remote === remote)?.name;
  return pick(target.remote) ?? pick(state.trackingRemote) ?? pick('origin') ?? named[0]?.name;
}

/** What `target` comes to in one repository. */
export function stepFor(state: RepoRefState, target: CheckoutTarget): CheckoutStep {
  const { root } = state;
  if (state.busy !== undefined) return { kind: 'busy', root, reason: state.busy };
  if (target.kind === 'tag') {
    return state.tags.includes(target.name) ? { kind: 'tag', root, name: target.name } : { kind: 'missing', root };
  }
  if (state.head === target.name) return { kind: 'already', root };
  if (state.locals.includes(target.name)) return { kind: 'switch', root, name: target.name };
  const from = remoteFor(state, target);
  return from !== undefined ? { kind: 'create', root, name: target.name, from } : { kind: 'missing', root };
}

export function planCheckout(states: readonly RepoRefState[], target: CheckoutTarget): CheckoutStep[] {
  return states.map((s) => stepFor(s, target));
}

/** The steps that change anything. */
export function changes(steps: readonly CheckoutStep[]): CheckoutStep[] {
  return steps.filter((s) => s.kind === 'switch' || s.kind === 'create' || s.kind === 'tag');
}

/**
 * The argv of a step that changes something. `force` throws local changes away
 * (Force Checkout, after a Local History snapshot); without it git refuses where
 * they would be overwritten, and Smart Checkout sets them aside instead.
 */
export function checkoutArgs(step: CheckoutStep, force = false): string[] {
  const f = force ? ['-f'] : [];
  switch (step.kind) {
    case 'switch':
    case 'tag':
      // No `--`: that would make the name a pathspec and restore files instead.
      return ['checkout', ...f, step.name];
    case 'create':
      // Spelled out rather than left to git's guess, which refuses once two
      // remotes have the branch. Tracking it is what the name says (D35).
      return ['checkout', ...f, '-b', step.name, '--track', step.from];
    case 'already':
    case 'missing':
    case 'busy':
      return [];
  }
}

/**
 * A branch Checkout across repositories offers: in how many it would change
 * something, of how many in view. Undefined unless it would change at least two —
 * one is the single repository's own Checkout.
 */
export function acrossOffer(
  states: readonly RepoRefState[],
  target: CheckoutTarget,
): { readonly changes: number; readonly of: number } | undefined {
  if (states.length < 2) return undefined;
  const n = changes(planCheckout(states, target)).length;
  return n >= 2 ? { changes: n, of: states.length } : undefined;
}

/** `a`, `a and b`, `a, b and c`; past `max`, `a, b, c and 2 more`. */
export function listNames(names: readonly string[], max = 4): string {
  if (names.length === 0) return '';
  if (names.length === 1) return names[0]!;
  if (names.length > max) return `${names.slice(0, max - 1).join(', ')} and ${names.length - (max - 1)} more`;
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]!}`;
}

/** One branch the picker offers, and where it is. */
export interface BranchChoice {
  readonly name: string;
  /** Repositories where it is checked out. */
  readonly current: readonly string[];
  /** Where a local branch has it, not checked out. */
  readonly local: readonly string[];
  /** Where only a remote branch has it, and which remote. */
  readonly remote: readonly { readonly label: string; readonly remote: string }[];
  readonly missing: readonly string[];
  /** In how many it would change something: checked out, or created and checked out. */
  readonly changes: number;
  /** `4 of 5 repositories`, `checked out in all 5`. */
  readonly description: string;
  /** Where it is: `local in api · from origin in web, docs and tools · not in infra`. */
  readonly detail: string;
}

/**
 * Every branch any repository has, locally or on a remote, by its own name, for
 * the picker: the ones that would change the most repositories first, a branch
 * checked out everywhere already last.
 */
export function branchChoices(states: readonly RepoRefState[]): BranchChoice[] {
  const names = new Set<string>();
  for (const s of states) {
    for (const local of s.locals) names.add(local);
    for (const r of s.remotes) {
      const name = branchOfRemote(r.name, r.remote);
      if (name !== 'HEAD' && name.length > 0) names.add(name);
    }
  }
  const out: BranchChoice[] = [];
  for (const name of names) {
    const current: string[] = [];
    const local: string[] = [];
    const remote: { label: string; remote: string }[] = [];
    const missing: string[] = [];
    for (const s of states) {
      const step = stepFor({ ...s, busy: undefined }, { kind: 'branch', name });
      if (step.kind === 'already') current.push(s.label);
      else if (step.kind === 'switch') local.push(s.label);
      else if (step.kind === 'create') remote.push({ label: s.label, remote: step.from.slice(0, step.from.length - name.length - 1) });
      else missing.push(s.label);
    }
    const n = local.length + remote.length;
    const total = states.length;
    const description =
      n === 0
        ? current.length === total
          ? `checked out in all ${total}`
          : `checked out in ${current.length} of ${total}`
        : n === total
          ? `all ${total} repositories`
          : `${n} of ${total} repositories`;
    const parts: string[] = [];
    if (current.length > 0) parts.push(`checked out in ${listNames(current)}`);
    if (local.length > 0) parts.push(`local in ${listNames(local)}`);
    const byRemote = new Map<string, string[]>();
    for (const r of remote) byRemote.set(r.remote, [...(byRemote.get(r.remote) ?? []), r.label]);
    for (const [r, labels] of byRemote) parts.push(`from ${r} in ${listNames(labels)}`);
    if (missing.length > 0) parts.push(`not in ${listNames(missing)}`);
    out.push({ name, current, local, remote, missing, changes: n, description, detail: parts.join(' · ') });
  }
  return out.sort(
    (a, b) =>
      (b.changes > 0 ? 1 : 0) - (a.changes > 0 ? 1 : 0) ||
      b.changes + b.current.length - (a.changes + a.current.length) ||
      b.local.length + b.current.length - (a.local.length + a.current.length) ||
      a.name.localeCompare(b.name),
  );
}

/** One repository's part in a checkout across repositories, once run. */
export type CheckoutResult =
  | {
      readonly kind: 'switched';
      readonly label: string;
      /** It was made here, tracking this remote branch. */
      readonly created?: string;
      /** Local changes in the way were set aside and put back, or kept in the stash. */
      readonly setAside?: 'restored' | 'kept';
      /** Local changes in the way were thrown away (Local History has them). */
      readonly forced?: boolean;
    }
  | { readonly kind: 'already'; readonly label: string }
  | { readonly kind: 'missing'; readonly label: string; readonly head?: string }
  | { readonly kind: 'busy'; readonly label: string; readonly reason: string }
  /** Local changes were in the way, and the user chose to leave this one be. */
  | { readonly kind: 'blocked'; readonly label: string; readonly head?: string; readonly files: readonly string[] }
  | { readonly kind: 'failed'; readonly label: string; readonly reason: string }
  /** Cancelled before its turn came. */
  | { readonly kind: 'notAttempted'; readonly label: string };

export interface CheckoutSummary {
  readonly kind: 'info' | 'warning';
  readonly message: string;
  /** Some repository's put-back changes conflicted: there is something to resolve. */
  readonly conflicts: boolean;
}

function sentence(text: string): string {
  return /[.!?]$/u.test(text) ? text : `${text}.`;
}

/**
 * The one notification for the run. Problems first, since a toast shows its
 * first line until it is opened, then where it went in, then what stayed.
 */
export function summarizeCheckout(
  target: CheckoutTarget,
  results: readonly CheckoutResult[],
): CheckoutSummary {
  const of = <K extends CheckoutResult['kind']>(kind: K): Array<Extract<CheckoutResult, { kind: K }>> =>
    results.filter((r): r is Extract<CheckoutResult, { kind: K }> => r.kind === kind);
  const switched = of('switched');
  const failed = of('failed');
  const blocked = of('blocked');
  const busy = of('busy');
  const missing = of('missing');
  const already = of('already');
  const notAttempted = of('notAttempted');
  const kept = switched.filter((r) => r.setAside === 'kept');
  const what = target.kind === 'tag' ? `tag ${target.name}` : target.name;

  const parts: string[] = [];
  for (const r of failed.slice(0, 3)) parts.push(sentence(`Couldn't check out ${what} in ${r.label}: ${r.reason}`));
  if (failed.length > 3) parts.push(`${failed.length - 3} more couldn't check it out.`);
  for (const r of blocked) {
    const files = r.files.length === 0 ? 'local changes' : `local changes to ${listNames(r.files, 3)}`;
    parts.push(`${r.label} stays on ${r.head ?? 'its commit'}: your ${files} would be overwritten.`);
  }
  if (kept.length > 0) {
    parts.push(
      `In ${listNames(kept.map((r) => r.label))}, putting your local changes back conflicted; they are kept in the stash.`,
    );
  }
  if (switched.length > 0) {
    const where = switched.length > 4 ? `${switched.length} repositories` : listNames(switched.map((r) => r.label));
    const created = switched.filter((r) => r.created !== undefined);
    const from = listNames([...new Set(created.map((r) => r.created!))]);
    // Made from the remote branch where no local one had the name: worth saying,
    // since a branch the user never created now exists.
    const made =
      created.length === 0
        ? ''
        : created.length === switched.length
          ? `, as a new branch tracking ${from}`
          : `; in ${listNames(created.map((r) => r.label))} as a new branch tracking ${from}`;
    parts.push(`Checked out ${what} in ${where}${made}.`);
    const restored = switched.filter((r) => r.setAside === 'restored');
    if (restored.length > 0) {
      parts.push(`Your local changes in ${listNames(restored.map((r) => r.label))} were set aside and put back.`);
    }
    const forced = switched.filter((r) => r.forced === true);
    if (forced.length > 0) {
      parts.push(`Your local changes in ${listNames(forced.map((r) => r.label))} were discarded; Local History has them.`);
    }
  }
  if (already.length > 0) {
    const verb = switched.length > 0 ? (already.length === 1 ? 'was' : 'were') : already.length === 1 ? 'is' : 'are';
    parts.push(`${listNames(already.map((r) => r.label))} ${verb} already on ${what}.`);
  }
  if (missing.length > 0) {
    const heads = [...new Set(missing.map((r) => r.head ?? ''))];
    const stays = heads.length === 1 && heads[0] !== '' ? ` and ${missing.length === 1 ? 'stays' : 'stay'} on ${heads[0]}` : '';
    parts.push(
      `${listNames(missing.map((r) => r.label))} ${missing.length === 1 ? 'has' : 'have'} no ${target.kind === 'tag' ? 'tag' : 'branch'} ${target.name}${stays}.`,
    );
  }
  if (notAttempted.length > 0) {
    parts.push(`Cancelled before ${listNames(notAttempted.map((r) => r.label))}.`);
  }
  if (busy.length > 0) {
    parts.push(`Skipped ${listNames(busy.map((r) => `${r.label} (${r.reason})`))}.`);
  }
  const conflicts = kept.length > 0;
  return {
    kind: failed.length > 0 || blocked.length > 0 || notAttempted.length > 0 || conflicts ? 'warning' : 'info',
    message: parts.join(' '),
    conflicts,
  };
}
