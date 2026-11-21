/**
 * Destruction detection & recovery prompts (P9-T4): tails .git/logs/HEAD for
 * externally-run destructive ref moves (reset --hard, forced checkout) that
 * our queue didn't initiate, and offers Local History / recover-branch
 * actions. Our own destructive ops leave a quiet, frequency-capped
 * status-bar hint instead.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { Core, RepoHandle } from '../core/core';
import { Emitter, type Event } from '../core/util/events';
import { classifyReflogSubject, parseReflogLine, type DestructionKind } from './reflogParse';
import { showInfo } from '../ui/notices';

export interface DestructionEvent {
  repo: RepoHandle;
  kind: DestructionKind;
  oldSha: string;
  newSha: string;
  subject: string;
  /** True when the pre-event model had dirty files. */
  hadDirtyFiles: boolean;
}

export class RecoveryWatch implements vscode.Disposable {
  private readonly _onDidDetect = new Emitter<DestructionEvent>();
  readonly onDidDetectDestruction: Event<DestructionEvent> = this._onDidDetect.event;
  private readonly watchers: fs.FSWatcher[] = [];
  private readonly offsets = new Map<string, number>();
  private readonly dirtyByRepo = new Map<string, boolean>();
  private readonly hintShown = new Set<string>();
  private disposed = false;

  constructor(private readonly core: Core) {
    for (const repo of core.repos) this.attach(repo);
    core.onDidAddRepo((repo) => this.attach(repo));

    // Quiet hint after our own destructive ops (frequency-capped per label).
    for (const repo of core.repos) this.hookHints(repo);
    core.onDidAddRepo((repo) => this.hookHints(repo));
  }

  private hookHints(repo: RepoHandle): void {
    repo.disposables.add(
      repo.queue.onDidFinishMutation((e) => {
        if (!e.isDestructive || !e.succeeded) return;
        const capKey = e.snapshotLabel ?? e.label;
        if (this.hintShown.has(capKey)) return;
        this.hintShown.add(capKey);
        void vscode.window.setStatusBarMessage(
          vscode.l10n.t('$(history) Local History snapshot saved — Geet: Show Local History'),
          5000,
        );
      }),
    );
  }

  get hintCount(): number {
    return this.hintShown.size;
  }

  private attach(repo: RepoHandle): void {
    const logsHead = path.join(repo.dirs.gitDir, 'logs', 'HEAD');
    try {
      this.offsets.set(repo.root, fs.existsSync(logsHead) ? fs.statSync(logsHead).size : 0);
    } catch {
      this.offsets.set(repo.root, 0);
    }
    // Track dirty state so we can judge danger at event time.
    repo.disposables.add(
      repo.model.onDidChange((sections) => {
        if (sections.has('status')) {
          this.dirtyByRepo.set(
            repo.root,
            repo.model.snapshot.statusEntries.some((e) => e.kind !== 'ignored'),
          );
        }
      }),
    );
    const logsDir = path.dirname(logsHead);
    try {
      fs.mkdirSync(logsDir, { recursive: true });
      const watcher = fs.watch(logsDir, { persistent: false }, (_evt, name) => {
        if (name === 'HEAD') void this.onHeadLogChange(repo, logsHead);
      });
      this.watchers.push(watcher);
      repo.disposables.add({ dispose: () => watcher.close() });
    } catch {
      // best effort
    }
  }

  private async onHeadLogChange(repo: RepoHandle, logsHead: string): Promise<void> {
    if (this.disposed) return;
    let text: string;
    let size: number;
    try {
      const stat = fs.statSync(logsHead);
      size = stat.size;
      const from = Math.min(this.offsets.get(repo.root) ?? 0, size);
      if (size <= from) {
        this.offsets.set(repo.root, size);
        return;
      }
      const fd = fs.openSync(logsHead, 'r');
      try {
        const buf = Buffer.alloc(size - from);
        fs.readSync(fd, buf, 0, buf.length, from);
        text = buf.toString('utf8');
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return;
    }
    this.offsets.set(repo.root, size);

    // Our own operations are announced by the hint path, not the toast.
    if (repo.queue.isSelfInflicted(Date.now())) return;

    for (const line of text.split('\n')) {
      if (line.trim().length === 0) continue;
      const parsed = parseReflogLine(line);
      if (!parsed) continue;
      const kind = classifyReflogSubject(parsed.subject);
      if (kind === undefined) continue;
      const dangerous = await this.isDangerous(repo, parsed.oldSha, parsed.newSha, kind);
      if (!dangerous) continue;
      const event: DestructionEvent = {
        repo,
        kind,
        oldSha: parsed.oldSha,
        newSha: parsed.newSha,
        subject: parsed.subject,
        hadDirtyFiles: this.dirtyByRepo.get(repo.root) === true,
      };
      this._onDidDetect.fire(event);
      void this.prompt(event);
    }
  }

  /** Danger = old HEAD no longer reachable from the new one, or dirty files existed. */
  private async isDangerous(
    repo: RepoHandle,
    oldSha: string,
    newSha: string,
    kind: DestructionEvent['kind'],
  ): Promise<boolean> {
    if (kind === 'reset' && this.dirtyByRepo.get(repo.root) === true) return true;
    if (oldSha === newSha) return false;
    const reachable = await repo.queue.enqueue({
      label: 'recovery reachability check',
      kind: 'read',
      run: (git, token) =>
        git.exec(repo.root, ['merge-base', '--is-ancestor', oldSha, newSha], {
          structured: true,
          noOptionalLocks: true,
          allowNonZeroExit: true,
          token,
        }),
    });
    return reachable.exitCode !== 0; // old commit fell out of the new history
  }

  private async prompt(event: DestructionEvent): Promise<void> {
    const short = event.oldSha.slice(0, 7);
    const openHistory = vscode.l10n.t('Restore files from Local History');
    const recover = vscode.l10n.t('Recover commit {0} (create branch)', short);
    const choice = await vscode.window.showWarningMessage(
      vscode.l10n.t('That looked destructive: "{0}".', event.subject),
      openHistory,
      recover,
    );
    if (choice === openHistory) {
      await vscode.commands.executeCommand('geet.history.show', event.repo.root);
    } else if (choice === recover) {
      await this.recoverCommit(event.repo, event.oldSha);
    }
  }

  /** `git branch recovered/<short> <sha>` after a liveness check. */
  async recoverCommit(repo: RepoHandle, sha: string): Promise<string | undefined> {
    const alive = await repo.queue.enqueue({
      label: 'check commit liveness',
      kind: 'read',
      run: (git, token) =>
        git.exec(repo.root, ['cat-file', '-e', `${sha}^{commit}`], {
          structured: true,
          noOptionalLocks: true,
          allowNonZeroExit: true,
          token,
        }),
    });
    if (alive.exitCode !== 0) {
      void vscode.window.showErrorMessage(
        vscode.l10n.t('Commit {0} is no longer in the object store.', sha.slice(0, 7)),
      );
      return undefined;
    }
    const branch = `recovered/${sha.slice(0, 7)}`;
    await repo.queue.enqueue({
      label: vscode.l10n.t('Recover commit {0}', sha.slice(0, 7)),
      kind: 'mutate',
      run: async (git, token) => {
        await git.exec(repo.root, ['branch', '-f', '--', branch, sha], { token });
      },
    });
    showInfo(
      vscode.l10n.t('Created branch {0} at {1}.', branch, sha.slice(0, 7)),
    );
    return branch;
  }

  dispose(): void {
    this.disposed = true;
    for (const w of this.watchers) w.close();
    this._onDidDetect.dispose();
  }
}
