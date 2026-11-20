/**
 * Core assembly (master §7: "extension.ts stays thin — builds Core"). One
 * Core per window: executor, discovery, and a RepoHandle
 * (model + queue + refresher + watchers) per repository. Later phases receive
 * this object through their registerPhaseXX(context, core) entry points.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { createCredentialResolver } from './git/askpass/credentialResolver';
import { AskpassServer } from './git/askpass/server';
import {
  createGitExecutor,
  type GitExecutorImpl,
  type RepoId,
} from './git/executor';
import { CommandLog } from './git/commandLog';
import { migrateUnsetGitEnabled } from './migrations/unsetGitEnabled';
import { RepositoryModel } from './model/repositoryModel';
import { OperationQueue } from './ops/operationQueue';
import { StatusRefresher } from './ops/statusRefresher';
import { canonicalKey, RepoDiscovery, type ScanOptions } from './repoDiscovery';
import { DisposableStore, Emitter, type Event } from './util/events';
import { GitDirWatcher, resolveGitDir, type ResolvedGitDir } from './watch/gitDirWatcher';
import { createWorkspaceWatcher } from './watch/workspaceWatcher';
import { vscodeProgressAdapter } from '../ui/progress';

/** Repositories opened at once during discovery — each costs several spawns. */
const OPEN_CONCURRENCY = 4;

/** A clone writes many paths; one rediscovery at the end of the burst is enough. */
const RESCAN_DEBOUNCE_MS = 500;

export interface RepoHandle {
  id: RepoId;
  root: string;
  dirs: ResolvedGitDir;
  model: RepositoryModel;
  queue: OperationQueue;
  refresher: StatusRefresher;
  disposables: DisposableStore;
}


export class Core implements vscode.Disposable {
  private readonly handles = new Map<string, RepoHandle>(); // canonical key → handle
  private readonly store = new DisposableStore();
  /** Per-phase registries for integration tests (reachable via getCore()). */
  readonly debugRegistry = new Map<string, unknown>();
  /** P10-T4: recent trace lines — feeds the sanitized issue report. */
  getTraceTail: () => readonly string[] = () => [];
  /** P12-T8: the structured (redacted) git-command ring behind the Console tab. */
  commandLog: CommandLog = new CommandLog(0);
  private readonly _onDidAddRepo = new Emitter<RepoHandle>();
  private readonly _onDidRemoveRepo = new Emitter<RepoHandle>();
  readonly onDidAddRepo: Event<RepoHandle> = this._onDidAddRepo.event;
  readonly onDidRemoveRepo: Event<RepoHandle> = this._onDidRemoveRepo.event;
  private readonly discovery: RepoDiscovery;
  private rescanning: Promise<void> = Promise.resolve();
  private rescanTimer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;

  constructor(
    readonly git: GitExecutorImpl,
    readonly output: vscode.OutputChannel,
    private readonly trace: (line: string) => void,
  ) {
    this.discovery = new RepoDiscovery({
      getRepoRoot: (dir) => this.getRepoRoot(dir),
      trace,
    });
  }

  get repos(): RepoHandle[] {
    return [...this.handles.values()];
  }

  getRepo(id: RepoId): RepoHandle | undefined {
    return this.handles.get(canonicalKey(id));
  }

  /** Longest-root match so nested open repos resolve to the inner one. */
  repoForUri(uri: vscode.Uri): RepoHandle | undefined {
    if (uri.scheme !== 'file') return undefined;
    return this.repoForPath(uri.fsPath);
  }

  repoForPath(fsPath: string): RepoHandle | undefined {
    const key = canonicalKey(fsPath);
    let best: RepoHandle | undefined;
    let bestLen = -1;
    for (const [rootKey, handle] of this.handles) {
      if ((key === rootKey || key.startsWith(rootKey + '/')) && rootKey.length > bestLen) {
        best = handle;
        bestLen = rootKey.length;
      }
    }
    return best;
  }

  /**
   * `context` is unused since P14-T6 removed the `gittree.mode` config
   * listener; kept in the signature because every caller passes it and the
   * next thing needing extension state will want it back.
   */
  async initialize(_context: vscode.ExtensionContext): Promise<void> {
    await this.queueRescan();

    this.store.add(
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        void this.queueRescan();
      }),
    );

    // Re-scan when the search depth or the ignore list changes, so the setting
    // takes effect where the user changed it rather than on the next reload.
    this.store.add(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('gittree.repositoryScan')) void this.queueRescan();
      }),
    );

    // One workspace-wide watcher routes worktree events to the owning repo —
    // and reports a `.git` entry appearing or vanishing, so a repository
    // cloned or `init`-ed after startup joins without a window reload. It is
    // deliberately the same watcher: a second one over the same folders costs
    // event-routing latency on every file change in the workspace, and this
    // one already sees them all.
    this.store.add(
      createWorkspaceWatcher(
        (fsPath) => {
          const handle = this.repoForPath(fsPath);
          if (!handle) return undefined;
          return {
            root: handle.root,
            gitDir: handle.dirs.gitDir,
            onWorktreeEvent: (_p: string, ts: number) => {
              handle.model.bumpWorkdirGeneration();
              handle.refresher.poke('worktree', ts);
            },
          };
        },
        { onGitEntryChanged: () => this.pokeRescan() },
      ),
    );

    if (this.git.caps.belowFloor) {
      this.trace(
        `git ${this.git.version} is below the supported floor (2.36); some features degrade`,
      );
    }
  }

  /**
   * Rescans are serialized. They used to have exactly one trigger
   * (`onDidChangeWorkspaceFolders`); now a filesystem watcher and a
   * configuration listener can fire too, and two interleaved runs would both
   * see a key as missing, both call `addRepo`, and leak the first handle's
   * watchers when the second overwrote it in the map.
   */
  /** Coalesces a burst of `.git` events into one rediscovery. */
  private pokeRescan(): void {
    if (this.rescanTimer) clearTimeout(this.rescanTimer);
    this.rescanTimer = setTimeout(() => {
      this.rescanTimer = undefined;
      if (!this.disposed) void this.queueRescan();
    }, RESCAN_DEBOUNCE_MS);
  }

  private queueRescan(): Promise<void> {
    const next = this.rescanning.then(
      () => this.rescan(),
      () => this.rescan(),
    );
    // Triggers call this as `void queueRescan()`; a rejection here must not
    // surface as an unhandled one, nor fail activation over a single repo.
    this.rescanning = next.catch((err: unknown) => {
      this.trace(`rescan failed: ${String(err)}`);
    });
    return this.rescanning;
  }

  private scanOptions(): ScanOptions {
    const cfg = vscode.workspace.getConfiguration('gittree');
    return {
      maxDepth: cfg.get<number>('repositoryScan.maxDepth', 1),
      ignoredFolders: cfg.get<string[]>('repositoryScan.ignoredFolders', ['node_modules']),
    };
  }

  private async rescan(): Promise<void> {
    const folders = (vscode.workspace.workspaceFolders ?? [])
      .filter((f) => f.uri.scheme === 'file')
      .map((f) => f.uri.fsPath);
    let roots: string[];
    try {
      roots = await this.discovery.scan(folders, this.scanOptions());
    } catch (err) {
      // Never let a failed rediscovery tear down the repositories already open.
      this.trace(`rescan failed, keeping the current repositories: ${String(err)}`);
      return;
    }
    const nextKeys = new Set(roots.map((r) => canonicalKey(r)));
    const opts = this.scanOptions();
    this.trace(
      `discovery: ${roots.length} repo(s) from ${folders.length} folder(s) ` +
        `(maxDepth ${String(opts.maxDepth)}): ${roots.join(', ') || '(none)'}`,
    );

    for (const [key, handle] of [...this.handles]) {
      if (!nextKeys.has(key)) {
        this.handles.delete(key);
        handle.disposables.dispose();
        this._onDidRemoveRepo.fire(handle);
        this.trace(`repo removed: ${handle.root}`);
      }
    }
    // Opening a repository costs several git invocations, and a folder of
    // checkouts can now yield dozens, so they open a few at a time rather than
    // strictly one after another — the difference between a window that is
    // ready in a moment and one that is ready in several seconds. `handles` is
    // still filled in `roots` order: addRepo registers its handle before its
    // first await, so the batch's synchronous prefixes run in order.
    const pending = roots.filter((root) => !this.handles.has(canonicalKey(root)));
    for (let i = 0; i < pending.length; i += OPEN_CONCURRENCY) {
      if (this.disposed) return;
      await Promise.all(
        pending.slice(i, i + OPEN_CONCURRENCY).map(async (root) => {
          try {
            await this.addRepo(canonicalKey(root), root);
          } catch (err) {
            // One repository that will not open (permissions, a corrupt git
            // dir) must not hide the rest.
            this.trace(`repo at ${root} failed to open: ${String(err)}`);
          }
        }),
      );
    }
  }

  private async addRepo(key: string, root: string): Promise<void> {
    const dirs = resolveGitDir(root);
    if (!dirs) {
      this.trace(`repo at ${root} has no resolvable git dir; skipped`);
      return;
    }
    const disposables = new DisposableStore();
    const model = disposables.add(new RepositoryModel(root));
    const queue = disposables.add(
      new OperationQueue(root, this.git, {
        progress: vscodeProgressAdapter(),
        trace: (l) => this.trace(`[queue] ${l}`),
      }),
    );
    const refresher = disposables.add(
      new StatusRefresher({
        repo: root,
        gitDir: dirs.gitDir,
        git: this.git,
        model,
        queue,
        trace: (l) => this.trace(`[watch] ${l}`),
      }),
    );
    const watcher = disposables.add(new GitDirWatcher(dirs));
    disposables.add(watcher.onDidChange((e) => refresher.poke('gitdir', e.ts)));

    const handle: RepoHandle = { id: root, root, dirs, model, queue, refresher, disposables };
    this.handles.set(key, handle);
    model.update({ capabilities: this.git.caps });
    await refresher.refreshNow();
    this._onDidAddRepo.fire(handle);
    this.trace(`repo added: ${root} (git dir ${dirs.gitDir})`);
  }

  private async getRepoRoot(dir: string): Promise<string | undefined> {
    const result = await this.git.exec(dir, ['rev-parse', '--show-toplevel'], {
      structured: true,
      noOptionalLocks: true,
      allowNonZeroExit: true,
    });
    if (result.exitCode !== 0) return undefined;
    const top = result.stdout.trim();
    return top.length > 0 ? path.normalize(top) : undefined;
  }

  dispose(): void {
    // A rescan already in flight must not re-add handles after teardown.
    this.disposed = true;
    if (this.rescanTimer) clearTimeout(this.rescanTimer);
    for (const handle of this.handles.values()) {
      handle.disposables.dispose();
    }
    this.handles.clear();
    this.store.dispose();
    this._onDidAddRepo.dispose();
    this._onDidRemoveRepo.dispose();
  }
}

export async function createCore(context: vscode.ExtensionContext): Promise<Core | undefined> {
  const output = vscode.window.createOutputChannel('Geet');
  context.subscriptions.push(output);
  const traceEnabled = (): boolean =>
    vscode.workspace.getConfiguration('gittree').get<boolean>('trace', false);
  // P10-T4: ring buffer of recent trace lines (kept even with tracing off) —
  // feeds the sanitized "Report issue" body; paths are hashed at report time.
  const traceTail: string[] = [];
  const trace = (line: string): void => {
    traceTail.push(line);
    if (traceTail.length > 50) traceTail.shift();
    if (traceEnabled()) output.appendLine(`[${new Date().toISOString()}] ${line}`);
  };

  // Askpass bridge (P0-T8): best-effort — auth degrades to GitError('auth')
  // if the pipe server cannot start.
  let askpass: AskpassServer | undefined;
  try {
    askpass = await AskpassServer.start(createCredentialResolver(context, trace), {
      shimDir: resolveShimDir(context),
      trace,
    });
    context.subscriptions.push(askpass);
  } catch (err) {
    trace(`askpass server failed to start: ${String(err)}`);
  }
  const applyTerminalAuth = (): void => {
    const enabled = vscode.workspace.getConfiguration('gittree').get<boolean>('terminalAuth', false);
    const collection = context.environmentVariableCollection;
    collection.clear();
    if (enabled && askpass) {
      collection.description = vscode.l10n.t('Geet git authentication');
      for (const [key, value] of Object.entries(askpass.env)) {
        collection.replace(key, value);
      }
    }
  };
  applyTerminalAuth();
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('gittree.terminalAuth')) applyTerminalAuth();
    }),
  );

  const cfg = vscode.workspace.getConfiguration();
  // P14-T5: the built-in extension's `git.path` is no longer consulted. It was
  // only ever a convenience fallback and reading a *setting* is harmless, but
  // "Geet reads no `git.*` configuration" is a rule that can be checked;
  // "reads exactly one key" is not.
  // P12-T8: every git run lands (redacted) in the Console tab's ring. The
  // limit is read once at activation — resizing a ring live has churn for no
  // one, and the setting exists for constrained hosts, not live tuning.
  const consoleLimit = cfg.get<number>('gittree.log.console.limit', 2000);
  const commandLog = new CommandLog(
    Number.isFinite(consoleLimit) && consoleLimit >= 100 ? Math.floor(consoleLimit) : 2000,
  );
  const executor = await createGitExecutor(
    { gittreeGitPath: cfg.get<string | null>('gittree.gitPath') ?? undefined },
    {
      trace: (l) => trace(`[exec] ${l}`),
      baseEnv: () => askpass?.env ?? {},
      onDidRun: (run) => commandLog.push(run),
    },
  );
  if (!executor) {
    void vscode.window.showErrorMessage(
      vscode.l10n.t(
        'Geet could not find a git installation. Set "gittree.gitPath" or install git.',
      ),
    );
    return undefined;
  }
  output.appendLine(`[exec] Geet using git ${executor.version} at ${executor.gitPath}`);

  // P14-T6: the coexistence state machine is gone. Geet no longer competes
  // for VS Code's SCM surfaces, so there is nothing to negotiate — but a
  // workspace that consented to takeover still carries the `git.enabled: false`
  // this extension wrote, and that has to be handed back.
  void migrateUnsetGitEnabled({
    workspaceState: context.workspaceState,
    clearBuiltinGitEnabled: async () => {
      await vscode.workspace
        .getConfiguration('git')
        .update('enabled', undefined, vscode.ConfigurationTarget.Workspace);
    },
    notify: (message) => {
      void vscode.window.showInformationMessage(message);
    },
    trace,
  }).catch((err: unknown) => {
    // Never fail activation over this; the next launch retries.
    trace(`takeover migration deferred: ${String(err)}`);
  });

  const core = new Core(executor, output, trace);
  core.commandLog = commandLog;
  context.subscriptions.push(new vscode.Disposable(() => commandLog.dispose()));
  core.getTraceTail = () => [...traceTail];
  context.subscriptions.push(core);
  await core.initialize(context);
  return core;
}

/** Packaged builds carry shims in dist/shims (esbuild copy); dev falls back to source. */
/** Packaged shims in dist/shims; source checkout falls back to shims/. */
export function resolveShimDir(context: vscode.ExtensionContext): string {
  const packaged = path.join(context.extensionPath, 'dist', 'shims');
  if (fs.existsSync(path.join(packaged, 'askpass.cjs'))) return packaged;
  return path.join(context.extensionPath, 'shims');
}
