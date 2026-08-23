/**
 * Core assembly (master §7: "extension.ts stays thin — builds Core"). One
 * Core per window: executor, mode manager, discovery, and a RepoHandle
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
import { ModeManager, type ConsentChoice, type GitTreeMode } from './modeManager';
import { RepositoryModel } from './model/repositoryModel';
import { OperationQueue } from './ops/operationQueue';
import { StatusRefresher } from './ops/statusRefresher';
import { canonicalKey, RepoDiscovery } from './repoDiscovery';
import { DisposableStore, Emitter, type Event } from './util/events';
import { GitDirWatcher, resolveGitDir, type ResolvedGitDir } from './watch/gitDirWatcher';
import { createWorkspaceWatcher } from './watch/workspaceWatcher';
import { vscodeProgressAdapter } from '../ui/progress';

export interface RepoHandle {
  id: RepoId;
  root: string;
  dirs: ResolvedGitDir;
  model: RepositoryModel;
  queue: OperationQueue;
  refresher: StatusRefresher;
  disposables: DisposableStore;
}

const MODE_STATE_KEY = 'gittree.mode';

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

  constructor(
    readonly git: GitExecutorImpl,
    readonly mode: ModeManager,
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

  async initialize(context: vscode.ExtensionContext): Promise<void> {
    await this.rescan();

    this.store.add(
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        void this.rescan();
      }),
    );

    // One workspace-wide watcher routes worktree events to the owning repo.
    this.store.add(
      createWorkspaceWatcher((fsPath) => {
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
      }),
    );

    context.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('gittree.mode')) {
          void this.mode.refreshFromSetting();
        }
      }),
    );

    if (this.git.caps.belowFloor) {
      this.trace(
        `git ${this.git.version} is below the supported floor (2.36); some features degrade`,
      );
    }
  }

  private async rescan(): Promise<void> {
    const folders = (vscode.workspace.workspaceFolders ?? [])
      .filter((f) => f.uri.scheme === 'file')
      .map((f) => f.uri.fsPath);
    const roots = await this.discovery.scan(folders);
    const nextKeys = new Set(roots.map((r) => canonicalKey(r)));

    for (const [key, handle] of [...this.handles]) {
      if (!nextKeys.has(key)) {
        this.handles.delete(key);
        handle.disposables.dispose();
        this._onDidRemoveRepo.fire(handle);
        this.trace(`repo removed: ${handle.root}`);
      }
    }
    for (const root of roots) {
      const key = canonicalKey(root);
      if (!this.handles.has(key)) {
        await this.addRepo(key, root);
      }
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
    for (const handle of this.handles.values()) {
      handle.disposables.dispose();
    }
    this.handles.clear();
    this.store.dispose();
    this.mode.dispose();
    this._onDidAddRepo.dispose();
    this._onDidRemoveRepo.dispose();
  }
}

export async function createCore(context: vscode.ExtensionContext): Promise<Core | undefined> {
  const output = vscode.window.createOutputChannel('GitTree');
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
      collection.description = vscode.l10n.t('GitTree git authentication');
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
  // "GitTree reads no `git.*` configuration" is a rule that can be checked;
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
        'GitTree could not find a git installation. Set "gittree.gitPath" or install git.',
      ),
    );
    return undefined;
  }
  output.appendLine(`[exec] GitTree using git ${executor.version} at ${executor.gitPath}`);

  const mode = new ModeManager({
    getPersisted: () =>
      context.workspaceState.get<Exclude<GitTreeMode, 'unset'>>(MODE_STATE_KEY),
    persist: async (m) => {
      await context.workspaceState.update(MODE_STATE_KEY, m);
    },
    getSettingOverride: () => {
      const v = vscode.workspace.getConfiguration('gittree').get<string>('mode', 'auto');
      return v === 'takeover' || v === 'companion' ? v : undefined;
    },
    showConsentDialog: () => showConsentDialog(),
    setBuiltinGitEnabled: async (enabled) => {
      await vscode.workspace
        .getConfiguration('git')
        .update('enabled', enabled, vscode.ConfigurationTarget.Workspace);
    },
    trace,
  });

  const core = new Core(executor, mode, output, trace);
  core.commandLog = commandLog;
  context.subscriptions.push(new vscode.Disposable(() => commandLog.dispose()));
  core.getTraceTail = () => [...traceTail];
  context.subscriptions.push(core);
  await core.initialize(context);

  // One-time consent, only when there is actually a repo and not under test.
  if (core.repos.length > 0 && process.env['GITTREE_TEST'] !== '1') {
    void mode.ensurePrompted();
  }
  return core;
}

/** Packaged builds carry shims in dist/shims (esbuild copy); dev falls back to source. */
/** Packaged shims in dist/shims; source checkout falls back to shims/. */
export function resolveShimDir(context: vscode.ExtensionContext): string {
  const packaged = path.join(context.extensionPath, 'dist', 'shims');
  if (fs.existsSync(path.join(packaged, 'askpass.cjs'))) return packaged;
  return path.join(context.extensionPath, 'shims');
}

async function showConsentDialog(): Promise<ConsentChoice> {
  const useGitTree = vscode.l10n.t('Use GitTree');
  const keepBoth = vscode.l10n.t('Keep both');
  const choice = await vscode.window.showInformationMessage(
    vscode.l10n.t('Use GitTree as your Git interface?'),
    {
      modal: true,
      detail: vscode.l10n.t(
        'GitTree provides changelists, a log graph, interactive rebase, a 3-pane merge editor and more.\n\n"Use GitTree" disables the built-in Git extension for this workspace (writes "git.enabled": false — reversible at any time). "Keep both" runs GitTree alongside the built-in Git with overlapping decorations disabled. Choosing nothing asks again next time.',
      ),
    },
    useGitTree,
    keepBoth,
  );
  if (choice === useGitTree) return 'takeover';
  if (choice === keepBoth) return 'companion';
  return 'later';
}
