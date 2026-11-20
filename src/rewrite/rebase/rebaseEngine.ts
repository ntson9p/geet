/**
 * Interactive-rebase engine (P5-T1): serializes a plan, hands it to git via
 * the sequence-editor shim, and drives continue/skip/abort — every step a
 * destructive mutation with its binding P9 snapshot label. No terminal, no
 * GIT_EDITOR prompts, ever.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { conflictedFilesCount } from '../../ui/counts';
import type { RepoHandle } from '../../core/core';
import type { CancelToken, GitExecutor, GitResult } from '../../core/git/executor';
import { readStaged, restoreStaged, type StagedSnapshot } from '../../core/ops/keepStaged';
import { Emitter, type Event } from '../../core/util/events';
import { SNAPSHOT_LABELS } from '../../localHistory/hooks';
import { serializePlan, type RebasePlan } from './planSerializer';

export type RebaseRunStatus =
  | 'completed'
  /** Git stopped mid-rebase (conflict or failed exec); state dir is alive. */
  | 'paused'
  /** Pre-flight found merge commits in range — --rebase-merges is v1-refused. */
  | 'refused-merges'
  | 'failed';

export interface RebaseOutcome {
  status: RebaseRunStatus;
  stderr?: string;
}

/** Forward slashes work in git's sh on every platform (incl. `C:/…`). */
function toPosix(p: string): string {
  return p.replace(/\\/g, '/');
}

/**
 * git's `--autostash` puts the stash back without `--index`: every staged
 * change comes back unstaged. These rewrites record the staging first and put
 * it back when the rebase ends (POST-QA F3), unless the stash itself did not
 * apply — then the changes wait in `git stash list` and the index is left be.
 */
function autostashConflicted(result: GitResult): boolean {
  return /autostash resulted in conflicts/iu.test(`${result.stdout}\n${result.stderr}`);
}

export class RebaseEngine {
  /** Message files must outlive `start()` — exec lines read them later. */
  private sessionTmpDir: string | undefined;
  /**
   * The staging when the current rewrite started, until it ends through
   * Geet (completes, or is aborted). A rebase finished from a terminal
   * leaves it unclaimed; the next rewrite replaces it.
   */
  private pendingStaged: StagedSnapshot | undefined;
  /**
   * Fires when any rebase-family rewrite finishes successfully (P5-T6), with
   * the HEAD it started from — what the push-safety check compares against.
   */
  private readonly _onDidCompleteRewrite = new Emitter<string | undefined>();
  readonly onDidCompleteRewrite: Event<string | undefined> = this._onDidCompleteRewrite.event;
  /** HEAD when the current rewrite started; outlives a pause. */
  private startHead: string | undefined;

  constructor(
    private readonly repo: RepoHandle,
    private readonly deps: { shimDir: string; trace: (line: string) => void },
  ) {}

  /** Pre-flight: merge commits in `base..HEAD` are v1-refused. */
  async hasMergesInRange(baseSha: string): Promise<boolean> {
    const result = await this.repo.queue.enqueue({
      label: 'rebase pre-flight (merge scan)',
      kind: 'read',
      run: (git, token) =>
        git.exec(
          this.repo.root,
          ['rev-list', '--merges', '--max-count=1', `${baseSha}..HEAD`],
          { structured: true, noOptionalLocks: true, token },
        ),
    });
    return result.stdout.trim().length > 0;
  }

  /**
   * Starts `git rebase -i --autostash <base>` with the serialized plan.
   * Resolves when git exits: completed, paused (conflict), or failed.
   */
  async start(plan: RebasePlan): Promise<RebaseOutcome> {
    if (await this.hasMergesInRange(plan.baseSha)) {
      void vscode.window.showErrorMessage(
        vscode.l10n.t(
          'The selected range contains merge commits. Geet cannot rebase merges yet — rebase from a commit after the merge instead.',
        ),
      );
      return { status: 'refused-merges' };
    }

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gittree-rebase-'));
    const serialized = serializePlan(plan, toPosix(tmpDir));
    const planFile = path.join(tmpDir, 'plan.txt');
    fs.writeFileSync(planFile, serialized.todo);
    for (const f of serialized.messageFiles) {
      fs.writeFileSync(path.join(tmpDir, f.name), f.content);
    }
    this.disposeSessionTmp();
    this.sessionTmpDir = tmpDir;
    this.deps.trace(`rebase: plan\n${serialized.todo}`);

    const editor = `"${toPosix(process.execPath)}" "${toPosix(
      path.join(this.deps.shimDir, 'seq-editor.cjs'),
    )}" "${toPosix(planFile)}"`;

    return this.runStep(
      vscode.l10n.t('Interactive rebase'),
      SNAPSHOT_LABELS.rebaseStart,
      ['rebase', '-i', '--autostash', plan.baseSha],
      { GIT_SEQUENCE_EDITOR: editor, GIT_EDITOR: 'true' },
      true,
    );
  }

  /**
   * Drop Commit (P5-T3): background `git rebase --autostash --onto <sha>^
   * <sha>` — replays everything above the commit onto its parent. No todo
   * UI; conflicts land in the standard paused flow.
   */
  async dropOnto(sha: string): Promise<RebaseOutcome> {
    return this.runStep(
      vscode.l10n.t('Drop commit {0}', sha.slice(0, 7)),
      SNAPSHOT_LABELS.rebaseStart,
      ['rebase', '--autostash', '--onto', `${sha}^`, sha],
      { GIT_EDITOR: 'true' },
      true,
    );
  }

  /**
   * Drop Commits over one unbroken run, `oldest` to `newest`: everything
   * above `newest` replayed onto the run's parent, as Drop Commit does for one.
   */
  async dropRange(oldest: string, newest: string, count: number): Promise<RebaseOutcome> {
    return this.runStep(
      vscode.l10n.t('Drop {0} commits', count),
      SNAPSHOT_LABELS.rebaseStart,
      ['rebase', '--autostash', '--onto', `${oldest}^`, newest],
      { GIT_EDITOR: 'true' },
      true,
    );
  }

  /** `git rebase --continue`; refuses while conflicted paths remain. */
  async continueRebase(): Promise<RebaseOutcome> {
    // Authoritative unmerged check straight from git — the model may lag a
    // few hundred ms behind a just-staged resolution.
    const unresolved = await this.repo.queue.enqueue({
      label: 'rebase continue pre-check',
      kind: 'read',
      run: (git, token) =>
        git.exec(this.repo.root, ['diff', '--name-only', '--diff-filter=U'], {
          structured: true,
          noOptionalLocks: true,
          token,
        }),
    });
    const conflicted = unresolved.stdout.split('\n').filter((l) => l.trim().length > 0);
    if (conflicted.length > 0) {
      void vscode.window.showWarningMessage(
        vscode.l10n.t(
          'Resolve {0} and stage the results before continuing.',
          conflictedFilesCount(conflicted.length),
        ),
      );
      return { status: 'paused' };
    }
    return this.runStep(
      vscode.l10n.t('Rebase: continue'),
      SNAPSHOT_LABELS.rebaseContinue,
      ['rebase', '--continue'],
      { GIT_EDITOR: 'true' },
    );
  }

  /** `git rebase --skip` — drops the stopped commit and moves on. */
  async skip(): Promise<RebaseOutcome> {
    return this.runStep(
      vscode.l10n.t('Rebase: skip commit'),
      SNAPSHOT_LABELS.rebaseSkip,
      ['rebase', '--skip'],
      { GIT_EDITOR: 'true' },
    );
  }

  /** `git rebase --abort` — restores the pre-rebase state. */
  async abort(): Promise<void> {
    await this.repo.queue.enqueue({
      label: vscode.l10n.t('Rebase: abort'),
      kind: 'mutate',
      isDestructive: true,
      bypassHold: true,
      snapshotLabel: SNAPSHOT_LABELS.rebaseAbort,
      run: async (git, token) => {
        const result = await git.exec(this.repo.root, ['rebase', '--abort'], { token });
        // Back on the old HEAD: every staged path is untouched again.
        await this.restorePending(git, result, token);
      },
    });
    this.disposeSessionTmp();
  }

  /**
   * Puts the recorded staging back once git has re-applied its autostash.
   * Runs inside the step's own mutate task, so nothing stages in between.
   */
  private async restorePending(git: GitExecutor, result: GitResult, token: CancelToken): Promise<void> {
    const pending = this.pendingStaged;
    this.pendingStaged = undefined;
    if (pending === undefined || autostashConflicted(result)) return;
    try {
      const kept = await restoreStaged(git, this.repo.root, pending, token);
      if (kept.skipped.length > 0) {
        void vscode.window.showWarningMessage(
          kept.skipped.length === 1
            ? vscode.l10n.t('1 staged file was changed by the rewrite and is now unstaged: {0}', kept.skipped.join(', '))
            : vscode.l10n.t(
                '{0} staged files were changed by the rewrite and are now unstaged: {1}',
                kept.skipped.length,
                kept.skipped.join(', '),
              ),
        );
      }
    } catch (err) {
      this.deps.trace(`rebase: could not restore the staged changes: ${String(err)}`);
    }
  }

  private async runStep(
    label: string,
    snapshotLabel: string,
    args: string[],
    env: Record<string, string>,
    starts = false,
  ): Promise<RebaseOutcome> {
    const result = await this.repo.queue.enqueue({
      label,
      kind: 'mutate',
      isDestructive: true,
      snapshotLabel,
      snapshotAfter: true,
      // P6-T7: continue/skip resolve the very pause that holds the lane.
      bypassHold: true,
      run: async (git, token) => {
        if (starts) {
          this.pendingStaged = await readStaged(git, this.repo.root, token);
          const head = await git.exec(this.repo.root, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], {
            structured: true,
            allowNonZeroExit: true,
            token,
          });
          this.startHead = head.exitCode === 0 ? head.stdout.trim() : undefined;
        }
        const r = await git.exec(this.repo.root, args, { env, allowNonZeroExit: true, token });
        if (r.exitCode === 0) {
          await this.restorePending(git, r, token);
        } else if (!this.isRebaseInProgress()) {
          // Never started, or gave up on its own: git left the index alone.
          this.pendingStaged = undefined;
        }
        return r;
      },
    });
    if (result.exitCode === 0) {
      this.disposeSessionTmp();
      const startHead = this.startHead;
      this.startHead = undefined;
      this._onDidCompleteRewrite.fire(startHead);
      return { status: 'completed' };
    }
    if (this.isRebaseInProgress()) {
      this.deps.trace(`rebase: paused (${label}): ${result.stderr.split('\n')[0] ?? ''}`);
      return { status: 'paused', stderr: result.stderr };
    }
    this.disposeSessionTmp();
    this.deps.trace(`rebase: failed (${label}): ${result.stderr}`);
    return { status: 'failed', stderr: result.stderr };
  }

  isRebaseInProgress(): boolean {
    for (const dir of ['rebase-merge', 'rebase-apply']) {
      try {
        if (fs.statSync(path.join(this.repo.dirs.gitDir, dir)).isDirectory()) return true;
      } catch {
        // not present
      }
    }
    return false;
  }

  private disposeSessionTmp(): void {
    if (this.sessionTmpDir !== undefined) {
      fs.rmSync(this.sessionTmpDir, { recursive: true, force: true });
      this.sessionTmpDir = undefined;
    }
  }

  dispose(): void {
    this.disposeSessionTmp();
    this._onDidCompleteRewrite.dispose();
  }
}
