/**
 * P7-T1 — StashService: list model straight from the repository snapshot
 * (P0's parser + git-dir watcher already cover `refs/stash` and its reflog),
 * every op on the mutation lane, and per-file access that hides git's
 * third-parent scheme for untracked stash content.
 */
import * as vscode from 'vscode';
import type { RepoHandle } from '../core/core';
import type { StashInfo } from '../core/git/parsers/stashList';
import { literalPathspecs } from '../core/git/pathspec';
import { SNAPSHOT_LABELS } from '../localHistory/hooks';
import type { ConflictSource } from '../merge/conflictSession';

export interface StashPushOptions {
  message?: string;
  /** Default true (`--include-untracked`); ignored when `staged` is set. */
  includeUntracked?: boolean;
  /** `--staged` — requires git ≥ 2.35 (caps.stashStaged). */
  staged?: boolean;
  /** Pathspec subset for "stash selected files". */
  paths?: readonly string[];
}

export type StashFileStatus = 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked';

/** One file inside a stash, with the rev pair a diff needs. */
export interface StashFile {
  /** Repo-relative path (rename: the new path). */
  path: string;
  status: StashFileStatus;
  /** Pre-stash side; undefined for untracked (nothing existed before). */
  left?: { ref: string; rel: string };
  /** Content inside the stash (untracked rides the third parent). */
  right: { ref: string; rel: string };
}

export interface StashApplyOutcome {
  status: 'clean' | 'conflicts';
}

export class StashService {
  constructor(
    private readonly repo: RepoHandle,
    /** P6-T7 producer seam — classifies the session a failed pop/apply drops. */
    private readonly expectConflict: (repoRoot: string, source: ConflictSource) => void,
  ) {}

  list(): readonly StashInfo[] {
    return this.repo.model.snapshot.stashes;
  }

  onDidChange(listener: () => void): { dispose(): void } {
    return this.repo.model.onDidChange((sections) => {
      if (sections.has('stashes')) listener();
    });
  }

  async push(opts: StashPushOptions = {}): Promise<void> {
    const args = ['stash', 'push'];
    if (opts.staged === true) {
      args.push('--staged');
    } else if (opts.includeUntracked !== false) {
      args.push('--include-untracked');
    }
    if (opts.message !== undefined && opts.message.length > 0) args.push('-m', opts.message);
    if (opts.paths !== undefined && opts.paths.length > 0) args.push('--', ...literalPathspecs(opts.paths));
    await this.repo.queue.enqueue({
      label: vscode.l10n.t('Stash changes'),
      kind: 'mutate',
      run: async (git, token) => {
        if (opts.staged === true && !git.caps.stashStaged) {
          throw new Error(
            vscode.l10n.t('Stashing only staged changes requires git 2.35+ (found {0}).', git.version),
          );
        }
        await git.exec(this.repo.root, args, { token });
      },
    });
    await this.repo.refresher.refreshNow();
  }

  apply(index: number, opts?: { restoreIndex?: boolean }): Promise<StashApplyOutcome> {
    return this.applyLike('apply', index, opts);
  }

  /** Conflicting pop keeps the entry (git demotes it to apply semantics). */
  pop(index: number, opts?: { restoreIndex?: boolean }): Promise<StashApplyOutcome> {
    return this.applyLike('pop', index, opts);
  }

  private async applyLike(
    verb: 'apply' | 'pop',
    index: number,
    opts?: { restoreIndex?: boolean },
  ): Promise<StashApplyOutcome> {
    const args = ['stash', verb];
    if (opts?.restoreIndex === true) args.push('--index');
    args.push(`stash@{${index}}`);
    const result = await this.repo.queue.enqueue({
      label: verb === 'pop' ? vscode.l10n.t('Stash: pop') : vscode.l10n.t('Stash: apply'),
      kind: 'mutate',
      isDestructive: true,
      snapshotLabel: verb === 'pop' ? SNAPSHOT_LABELS.stashPop : SNAPSHOT_LABELS.stashApply,
      run: (git, token) => git.exec(this.repo.root, args, { allowNonZeroExit: true, token }),
    });
    if (result.exitCode === 0) {
      await this.repo.refresher.refreshNow();
      return { status: 'clean' };
    }
    const text = result.stdout + result.stderr;
    if (!/conflict/iu.test(text)) {
      await this.repo.refresher.refreshNow();
      throw new Error(result.stderr.split('\n')[0] ?? vscode.l10n.t('stash {0} failed', verb));
    }
    // Register the producer hint BEFORE the refresh that creates the session.
    this.expectConflict(this.repo.root, 'stash-pop');
    await this.repo.refresher.refreshNow();
    return { status: 'conflicts' };
  }

  async drop(index: number): Promise<void> {
    await this.repo.queue.enqueue({
      label: vscode.l10n.t('Stash: drop'),
      kind: 'mutate',
      isDestructive: true,
      snapshotLabel: SNAPSHOT_LABELS.stashDrop,
      run: async (git, token) => {
        await git.exec(this.repo.root, ['stash', 'drop', `stash@{${index}}`], { token });
      },
    });
    await this.repo.refresher.refreshNow();
  }

  async clear(): Promise<void> {
    await this.repo.queue.enqueue({
      label: vscode.l10n.t('Stash: clear all'),
      kind: 'mutate',
      isDestructive: true,
      snapshotLabel: SNAPSHOT_LABELS.stashClear,
      run: async (git, token) => {
        await git.exec(this.repo.root, ['stash', 'clear'], { token });
      },
    });
    await this.repo.refresher.refreshNow();
  }

  /** `git stash branch <name> stash@{n}` — checkout base, branch, pop. */
  async branch(name: string, index: number): Promise<void> {
    await this.repo.queue.enqueue({
      label: vscode.l10n.t('Stash: branch {0}', name),
      kind: 'mutate',
      isDestructive: true,
      snapshotLabel: SNAPSHOT_LABELS.stashPop,
      run: async (git, token) => {
        await git.exec(this.repo.root, ['stash', 'branch', name, `stash@{${index}}`], { token });
      },
    });
    await this.repo.refresher.refreshNow();
  }

  /**
   * Files inside stash@{n} with diffable rev pairs. Tracked changes come
   * from `stash@{n}^..stash@{n}`; untracked files live in the stash's THIRD
   * parent (`stash@{n}^3`, present only when the stash was pushed with
   * `--include-untracked`) — callers never see that detail.
   */
  async getStashFiles(index: number): Promise<StashFile[]> {
    const sel = `stash@{${index}}`;
    const [tracked, untracked] = await Promise.all([
      this.read(['diff', '--name-status', '-z', `${sel}^`, sel]),
      this.read(['ls-tree', '-r', '-z', '--name-only', `${sel}^3`]),
    ]);
    const files: StashFile[] = [];
    if (tracked.exitCode === 0) {
      const fields = tracked.stdout.split('\0');
      for (let i = 0; i + 1 < fields.length && (fields[i] as string).length > 0; ) {
        const code = fields[i] as string;
        if (code.startsWith('R') || code.startsWith('C')) {
          const oldPath = fields[i + 1] as string;
          const newPath = fields[i + 2] as string;
          files.push({
            path: newPath,
            status: 'renamed',
            left: { ref: `${sel}^`, rel: oldPath },
            right: { ref: sel, rel: newPath },
          });
          i += 3;
          continue;
        }
        const path = fields[i + 1] as string;
        const status: StashFileStatus =
          code === 'A' ? 'added' : code === 'D' ? 'deleted' : 'modified';
        files.push({
          path,
          status,
          left: { ref: `${sel}^`, rel: path },
          right: { ref: sel, rel: path },
        });
        i += 2;
      }
    }
    // Exit != 0 simply means "no third parent" — stash without untracked.
    if (untracked.exitCode === 0) {
      for (const rel of untracked.stdout.split('\0')) {
        if (rel.length === 0) continue;
        files.push({ path: rel, status: 'untracked', right: { ref: `${sel}^3`, rel } });
      }
    }
    return files;
  }

  private read(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    return this.repo.queue.enqueue({
      label: 'stash read',
      kind: 'read',
      run: (git, token) =>
        git.exec(this.repo.root, args, {
          structured: true,
          noOptionalLocks: true,
          allowNonZeroExit: true,
          token,
        }),
    });
  }
}
