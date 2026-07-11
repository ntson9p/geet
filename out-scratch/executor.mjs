// src/core/git/executor.ts
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

// src/core/git/capabilities.ts
var GIT_FLOOR = [2, 36, 0];
function parseGitVersion(versionOutput) {
  const m = /git version (\d+)\.(\d+)(?:\.(\d+))?/.exec(versionOutput);
  if (!m) return void 0;
  return `${m[1]}.${m[2]}.${m[3] ?? "0"}`;
}
function compareVersion(version, [maj, min, pat]) {
  const parts = version.split(".").map((p) => Number.parseInt(p, 10));
  const a = [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
  const b = [maj, min, pat];
  for (let i = 0; i < 3; i++) {
    const ai = a[i] ?? 0;
    const bi = b[i] ?? 0;
    if (ai !== bi) return ai < bi ? -1 : 1;
  }
  return 0;
}
function buildCapabilities(version) {
  const atLeast = (maj, min, pat = 0) => compareVersion(version, [maj, min, pat]) >= 0;
  return {
    version,
    belowFloor: compareVersion(version, GIT_FLOOR) < 0,
    stashStaged: atLeast(2, 35),
    commitGraph: atLeast(2, 24),
    forceIfIncludes: atLeast(2, 30),
    fsmonitor: atLeast(2, 37),
    rebaseUpdateRefs: atLeast(2, 38),
    zdiff3: atLeast(2, 35)
  };
}

// src/core/git/errors.ts
var GitError = class extends Error {
  constructor(kind, message, details) {
    super(message);
    this.kind = kind;
    this.details = details;
  }
  name = "GitError";
  get stderr() {
    return this.details.stderr;
  }
  get exitCode() {
    return this.details.exitCode;
  }
};
var RULES = [
  {
    kind: "index-lock",
    patterns: [
      /index\.lock': File exists/i,
      /Unable to create '.*index\.lock'/i,
      /Another git process seems to be running/i,
      /could not lock (?:the )?index/i
    ]
  },
  {
    kind: "would-overwrite-checkout",
    patterns: [
      /would be overwritten by (checkout|merge|rebase)/i,
      /Please commit your changes or stash them before you (switch branches|merge)/i
    ]
  },
  {
    kind: "merge-conflict",
    patterns: [
      /^CONFLICT \(/m,
      /Automatic merge failed/i,
      /error: could not apply/i,
      /Merge conflict in /i,
      /after resolving the conflicts/i,
      /unmerged files/i,
      /needs merge/i
    ]
  },
  {
    kind: "auth",
    patterns: [
      /terminal prompts disabled/i,
      /Authentication failed/i,
      /could not read Username/i,
      /could not read Password/i,
      /Permission denied \(publickey/i,
      /Invalid username or (password|token)/i,
      /HTTP Basic: Access denied/i
    ]
  },
  {
    kind: "not-fast-forward",
    patterns: [
      /non-fast-forward/i,
      /fetch first/i,
      /\[rejected\].*stale info/i,
      /Updates were rejected because/i
    ]
  },
  {
    kind: "no-upstream",
    patterns: [
      /has no upstream branch/i,
      /no tracking information for the current branch/i,
      /no upstream configured for branch/i
    ]
  }
];
function classifyGitError(stderr, stdout = "") {
  const haystack = stderr + "\n" + stdout;
  for (const rule of RULES) {
    if (rule.patterns.some((p) => p.test(haystack))) return rule.kind;
  }
  return "unknown";
}
function makeGitError(details) {
  const kind = classifyGitError(details.stderr, details.stdout);
  const firstLine = details.stderr.split("\n").find((l) => l.trim().length > 0) ?? `git exited with code ${details.exitCode}`;
  return new GitError(kind, firstLine.trim(), details);
}

// src/core/git/executor.ts
var BASE_ARGS = ["-c", "core.quotepath=false", "-c", "color.ui=false"];
var STREAM_YIELD_EVERY = 2e3;
var TRACE_ARG_MAX = 120;
var GitExecutorImpl = class {
  version;
  caps;
  gitPath;
  trace;
  baseEnv;
  baseArgs;
  constructor(init) {
    this.gitPath = init.gitPath;
    this.version = init.version;
    this.caps = buildCapabilities(init.version);
    this.trace = init.trace ?? (() => void 0);
    this.baseEnv = init.baseEnv ?? (() => ({}));
    this.baseArgs = init.baseArgs ?? BASE_ARGS;
  }
  spawnGit(repo, args, o) {
    const env = {
      ...process.env,
      ...this.baseEnv(),
      GIT_TERMINAL_PROMPT: "0",
      ...o.noOptionalLocks ? { GIT_OPTIONAL_LOCKS: "0" } : {},
      ...o.structured ? { LC_ALL: "C" } : {},
      ...o.env
    };
    return spawn(this.gitPath, [...this.baseArgs, ...args], {
      cwd: o.cwd ?? repo,
      env,
      windowsHide: true
    });
  }
  traceRun(args, startedAt, exitCode, note = "") {
    const ms = Date.now() - startedAt;
    const argv = args.map((a) => a.length > TRACE_ARG_MAX ? `${a.slice(0, TRACE_ARG_MAX)}\u2026(${a.length})` : a).join(" ");
    this.trace(`git ${argv} \u2192 ${exitCode} in ${ms}ms${note ? ` (${note})` : ""}`);
  }
  async exec(repo, args, o = {}) {
    if (o.token?.isCancellationRequested) {
      throw new GitError("unknown", "Operation cancelled before start", {
        args,
        exitCode: -1,
        stderr: "",
        stdout: "",
        cwd: repo
      });
    }
    const startedAt = Date.now();
    const child = this.spawnGit(repo, args, o);
    let cancelled = false;
    const tokenSub = o.token?.onCancellationRequested(() => {
      cancelled = true;
      killTree(child);
    });
    const stdoutChunks = [];
    const stderrChunks = [];
    child.stdout.on("data", (c) => stdoutChunks.push(c));
    child.stderr.on("data", (c) => stderrChunks.push(c));
    if (o.stdin !== void 0) {
      child.stdin.on("error", () => void 0);
      child.stdin.write(o.stdin);
    }
    child.stdin.end();
    try {
      const exitCode = await waitForExit(child);
      const result = {
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
        exitCode
      };
      this.traceRun(args, startedAt, exitCode, cancelled ? "cancelled" : "");
      if (exitCode !== 0 && !o.allowNonZeroExit && !cancelled) {
        throw makeGitError({ args, exitCode, stderr: result.stderr, stdout: result.stdout, cwd: repo });
      }
      return result;
    } finally {
      tokenSub?.dispose();
    }
  }
  stream(repo, args, onLine, o = {}) {
    const startedAt = Date.now();
    const delimiter = o.delimiter ?? "\0";
    const child = this.spawnGit(repo, args, o);
    let cancelled = false;
    const stderrChunks = [];
    child.stderr.on("data", (c) => stderrChunks.push(c));
    child.stdin.end();
    let finished = false;
    let resolveDone;
    let rejectDone;
    const done = new Promise((res, rej) => {
      resolveDone = res;
      rejectDone = rej;
    });
    let pending = "";
    let pumpScheduled = false;
    let exitCode;
    const tokenSub = o.token?.onCancellationRequested(() => {
      cancelled = true;
      killTree(child);
    });
    const finalize = () => {
      if (finished) return;
      finished = true;
      tokenSub?.dispose();
      if (!cancelled && pending.length > 0) {
        onLine(pending);
        pending = "";
      }
      const stderr = Buffer.concat(stderrChunks).toString("utf8");
      const code = exitCode ?? -1;
      this.traceRun(args, startedAt, code, cancelled ? "cancelled (stream)" : "stream");
      if (code !== 0 && !cancelled && !o.allowNonZeroExit) {
        rejectDone(makeGitError({ args, exitCode: code, stderr, stdout: "", cwd: repo }));
      } else {
        resolveDone({ stdout: "", stderr, exitCode: code });
      }
    };
    const pump = () => {
      pumpScheduled = false;
      if (finished) return;
      let count = 0;
      let idx;
      while (!cancelled && (idx = pending.indexOf(delimiter)) !== -1) {
        const frame = pending.slice(0, idx);
        pending = pending.slice(idx + 1);
        onLine(frame);
        if (++count >= STREAM_YIELD_EVERY) {
          pumpScheduled = true;
          child.stdout.pause();
          setImmediate(pump);
          return;
        }
      }
      if (exitCode !== void 0 || cancelled) {
        finalize();
      } else {
        child.stdout.resume();
      }
    };
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      pending += chunk;
      if (!pumpScheduled) pump();
    });
    child.once("error", (e) => {
      if (!finished) {
        finished = true;
        tokenSub?.dispose();
        rejectDone(e);
      }
    });
    child.once("close", (code, signal) => {
      exitCode = code ?? (signal ? -1 : 0);
      if (!pumpScheduled) pump();
    });
    return {
      cancel: () => {
        cancelled = true;
        killTree(child);
      },
      done
    };
  }
};
function waitForExit(child) {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      resolve(code ?? (signal ? -1 : 0));
    });
  });
}
function killTree(child) {
  if (child.exitCode !== null || child.pid === void 0) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
  } else {
    child.kill("SIGTERM");
    const pid = child.pid;
    setTimeout(() => {
      if (child.exitCode === null) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
        }
      }
    }, 2e3).unref();
  }
}
function resolveGitCandidates(s = {}) {
  const platform = s.platform ?? process.platform;
  const env = s.env ?? process.env;
  const candidates = [];
  if (s.gittreeGitPath) candidates.push(s.gittreeGitPath);
  if (s.builtinGitPath) candidates.push(s.builtinGitPath);
  candidates.push("git");
  if (platform === "win32") {
    const roots = [env["ProgramFiles"], env["ProgramFiles(x86)"], env["LocalAppData"]].filter(
      (r) => typeof r === "string" && r.length > 0
    );
    for (const root of roots) {
      candidates.push(path.join(root, "Git", "cmd", "git.exe"));
    }
    candidates.push("C:\\Program Files\\Git\\cmd\\git.exe");
  } else if (platform === "darwin") {
    candidates.push("/usr/bin/git", "/opt/homebrew/bin/git", "/usr/local/bin/git");
  } else {
    candidates.push("/usr/bin/git", "/usr/local/bin/git");
  }
  return [...new Set(candidates)];
}
async function findGit(candidates) {
  for (const candidate of candidates) {
    if (path.isAbsolute(candidate) && !fs.existsSync(candidate)) continue;
    const version = await probeVersion(candidate);
    if (version) return { path: candidate, version };
  }
  return void 0;
}
function probeVersion(gitPath) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(gitPath, ["--version"], { windowsHide: true });
    } catch {
      resolve(void 0);
      return;
    }
    const chunks = [];
    child.stdout.on("data", (c) => chunks.push(c));
    child.on("error", () => resolve(void 0));
    child.on("close", (code) => {
      if (code !== 0) {
        resolve(void 0);
        return;
      }
      resolve(parseGitVersion(Buffer.concat(chunks).toString("utf8")));
    });
  });
}
async function createGitExecutor(settings, init = {}) {
  const found = await findGit(resolveGitCandidates(settings));
  if (!found) return void 0;
  return new GitExecutorImpl({ ...init, gitPath: found.path, version: found.version });
}
export {
  GitExecutorImpl,
  createGitExecutor,
  findGit,
  killTree,
  resolveGitCandidates
};
