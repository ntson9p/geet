/**
 * Git feature probing (master §0.4). Floor is git ≥ 2.36; older versions keep
 * working with per-feature degradation — consumers check `caps.<feature>` and
 * disable UI with an explanatory tooltip instead of failing at runtime.
 */
export interface GitCapabilities {
  /** Parsed `major.minor.patch` from `git --version`. */
  readonly version: string;
  /** True when the running git is older than the supported floor (2.36). */
  readonly belowFloor: boolean;
  /** `git stash push --staged` (2.35). */
  readonly stashStaged: boolean;
  /**
   * `git merge --autostash` (2.27). `git rebase --autostash` is far older
   * (1.8.4), so only the merge half of Update Project needs asking.
   */
  readonly mergeAutostash: boolean;
  /** `git commit-graph write --reachable` maintenance (2.24). */
  readonly commitGraph: boolean;
  /** `git push --force-with-lease --force-if-includes` (2.30). */
  readonly forceIfIncludes: boolean;
  /** Built-in FSMonitor `core.fsmonitor=true` (2.37). */
  readonly fsmonitor: boolean;
  /** `git rebase --update-refs` (2.38). */
  readonly rebaseUpdateRefs: boolean;
  /** `checkout --conflict=zdiff3` style (2.35). */
  readonly zdiff3: boolean;
}

export const GIT_FLOOR = [2, 36, 0] as const;

/** Extracts "2.43.0" from e.g. "git version 2.43.0.windows.1". */
export function parseGitVersion(versionOutput: string): string | undefined {
  const m = /git version (\d+)\.(\d+)(?:\.(\d+))?/.exec(versionOutput);
  if (!m) return undefined;
  return `${m[1]}.${m[2]}.${m[3] ?? '0'}`;
}

export function compareVersion(version: string, [maj, min, pat]: readonly [number, number, number]): number {
  const parts = version.split('.').map((p) => Number.parseInt(p, 10));
  const a = [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
  const b = [maj, min, pat];
  for (let i = 0; i < 3; i++) {
    const ai = a[i] ?? 0;
    const bi = b[i] ?? 0;
    if (ai !== bi) return ai < bi ? -1 : 1;
  }
  return 0;
}

export function buildCapabilities(version: string): GitCapabilities {
  const atLeast = (maj: number, min: number, pat = 0): boolean =>
    compareVersion(version, [maj, min, pat]) >= 0;
  return {
    version,
    belowFloor: compareVersion(version, GIT_FLOOR) < 0,
    stashStaged: atLeast(2, 35),
    mergeAutostash: atLeast(2, 27),
    commitGraph: atLeast(2, 24),
    forceIfIncludes: atLeast(2, 30),
    fsmonitor: atLeast(2, 37),
    rebaseUpdateRefs: atLeast(2, 38),
    zdiff3: atLeast(2, 35),
  };
}
