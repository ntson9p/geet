/**
 * Undo Commit & Drop Commit (P5-T3). Undo = soft reset of HEAD with
 * IntelliJ-parity aftermath (changelists paradigm files the paths into a new
 * changelist named after the commit subject and restores the message into
 * the commit input; staging paradigm leaves everything staged). Drop = a
 * background `git rebase --autostash --onto <sha>^ <sha>` through the T1
 * engine's classification, with an in-session Undo back to the pre-drop sha.
 * Both refuse published commits unless the warn modal is accepted.
 */
import * as vscode from 'vscode';
import { notifySuccess } from '../ui/notify';
import type { Core, RepoHandle } from '../core/core';
import { canonicalKey } from '../core/repoDiscovery';
import { SNAPSHOT_LABELS } from '../localHistory/hooks';
import { confirmModal } from '../ui/confirm';
import { isPublished } from './publishedGuard';
import type { RebaseEngine, RebaseOutcome } from './rebase/rebaseEngine';

/** Structural slices of the P1/P3 registries this service composes with. */
interface MessageBoxShape {
  messageBoxFor(repo: RepoHandle): { value: string } | undefined;
}
interface CommitShape {
  paradigm: { paradigm: 'changelists' | 'staging' };
  changelistsFor: (repo: RepoHandle) => {
    getLists(): Array<{ id: string; name: string }>;
    create(name: string, comment?: string, makeActive?: boolean): { id: string };
    moveFiles(relPaths: readonly string[], targetId: string): void;
  };
}

export type UndoCommitResult =
  | { status: 'done'; subject: string }
  | { status: 'refused-published' }
  | { status: 'no-parent' }
  | { status: 'no-commit' };

export type DropResult =
  | { status: RebaseOutcome['status']; stderr?: string }
  | { status: 'refused-published' }
  | { status: 'refused-merges' };

export class UndoDropService {
  /** Last successful drop per repo — powers the in-session Undo toast. */
  private readonly lastDrop = new Map<string, string>();

  constructor(
    private readonly core: Core,
    private readonly engineFor: (repo: RepoHandle) => RebaseEngine | undefined,
  ) {}

  /**
   * P14-T4: the SCM input box is gone. The commit window's message box is the
   * only place a message lives, and phase03 exposes it.
   */
  private inputBoxFor(repo: RepoHandle): { value: string } | undefined {
    const p3 = this.core.debugRegistry.get('phase03') as MessageBoxShape | undefined;
    return p3?.messageBoxFor(repo);
  }

  private commitShape(): CommitShape | undefined {
    return this.core.debugRegistry.get('phase03') as CommitShape | undefined;
  }

  /** Undo Commit — HEAD only (callers hide/refuse other shas). */
  async undoCommit(repo: RepoHandle): Promise<UndoCommitResult> {
    // Authoritative HEAD — the model can lag CLI-created commits.
    const head = await this.tryRevParse(repo, 'HEAD');
    if (head === undefined) return { status: 'no-commit' };

    const parent = await this.tryRevParse(repo, 'HEAD^');
    if (parent === undefined) {
      void vscode.window.showErrorMessage(
        vscode.l10n.t('The initial commit cannot be undone — it has no parent.'),
      );
      return { status: 'no-parent' };
    }

    if (await isPublished(repo, head)) {
      const ok = await confirmModal(
        vscode.l10n.t('Undo a published commit?'),
        vscode.l10n.t(
          'Commit {0} is already on the upstream. Undoing it rewrites shared history and will require a force push.',
          head.slice(0, 7),
        ),
        vscode.l10n.t('Undo Anyway'),
      );
      if (!ok) return { status: 'refused-published' };
    }

    // Subject/body + affected paths, captured before the reset.
    const metaRaw = await this.read(repo, ['log', '-1', '--format=%s%x00%B', 'HEAD']);
    const [subjectRaw, bodyRaw] = metaRaw.split('\x00');
    const subject = (subjectRaw ?? '').trim();
    const message = (bodyRaw ?? '').replace(/\n+$/, '');
    const filesRaw = await this.read(repo, [
      'diff-tree',
      '--no-commit-id',
      '--name-only',
      '-r',
      '-z',
      'HEAD',
    ]);
    const relPaths = filesRaw.split('\0').filter((p) => p.length > 0);

    const changelistParadigm = this.commitShape()?.paradigm.paradigm === 'changelists';
    await repo.queue.enqueue({
      label: vscode.l10n.t('Undo commit {0}', head.slice(0, 7)),
      kind: 'mutate',
      isDestructive: true,
      snapshotLabel: SNAPSHOT_LABELS.reset,
      run: async (git, token) => {
        await git.exec(repo.root, ['reset', '--soft', 'HEAD^'], { token });
        if (changelistParadigm) {
          // Changelists bypass the index — unstage so the files return to
          // plain worktree modifications the lists can own.
          await git.exec(repo.root, ['reset'], { token });
        }
      },
    });

    if (changelistParadigm && relPaths.length > 0) {
      const commit = this.commitShape();
      const service = commit?.changelistsFor(repo);
      if (service) {
        const name = subject.length > 0 ? subject : vscode.l10n.t('Undone commit');
        const existing = service.getLists().find((l) => l.name === name);
        const target = existing ?? service.create(name);
        service.moveFiles(relPaths, target.id);
      }
    }

    const input = this.inputBoxFor(repo);
    if (input) input.value = message;
    await repo.refresher.refreshNow();
    // IntelliJ's `git.undo.action.successful.notification.message`.
    notifySuccess(vscode.l10n.t('Undo commit successful'));
    return { status: 'done', subject };
  }

  /** Drop Commit — any linear unpushed commit, via background rebase. */
  async dropCommit(repo: RepoHandle, sha: string): Promise<DropResult> {
    const engine = this.engineFor(repo);
    if (!engine) return { status: 'failed' };

    const parent = await this.tryRevParse(repo, `${sha}^`);
    if (parent === undefined) {
      void vscode.window.showErrorMessage(
        vscode.l10n.t('The initial commit cannot be dropped — it has no parent.'),
      );
      return { status: 'failed' };
    }
    if (await engine.hasMergesInRange(parent)) {
      void vscode.window.showErrorMessage(
        vscode.l10n.t(
          'The range above {0} contains merge commits — dropping it would flatten them.',
          sha.slice(0, 7),
        ),
      );
      return { status: 'refused-merges' };
    }
    if (await isPublished(repo, sha)) {
      const ok = await confirmModal(
        vscode.l10n.t('Drop a published commit?'),
        vscode.l10n.t(
          'Commit {0} is already on the upstream. Dropping it rewrites shared history and will require a force push.',
          sha.slice(0, 7),
        ),
        vscode.l10n.t('Drop Anyway'),
      );
      if (!ok) return { status: 'refused-published' };
    }

    // Authoritative HEAD — the model can lag CLI-created commits.
    const preHead = await this.tryRevParse(repo, 'HEAD');
    const outcome = await engine.dropOnto(sha);
    if (outcome.status === 'completed') {
      if (preHead !== undefined) this.lastDrop.set(canonicalKey(repo.root), preHead);
      const undo = vscode.l10n.t('Undo');
      void vscode.window
        .showInformationMessage(
          vscode.l10n.t('Dropped commit {0}.', sha.slice(0, 7)),
          undo,
        )
        .then(async (choice) => {
          if (choice === undo) await this.undoLastDrop(repo);
        });
    }
    return outcome;
  }

  /** In-session Undo of the last drop: hard reset back to the pre-drop sha. */
  async undoLastDrop(repo: RepoHandle): Promise<boolean> {
    const preHead = this.lastDrop.get(canonicalKey(repo.root));
    if (preHead === undefined) return false;
    await repo.queue.enqueue({
      label: vscode.l10n.t('Undo drop (reset to {0})', preHead.slice(0, 7)),
      kind: 'mutate',
      isDestructive: true,
      snapshotLabel: SNAPSHOT_LABELS.reset,
      run: async (git, token) => {
        await git.exec(repo.root, ['reset', '--hard', preHead], { token });
      },
    });
    this.lastDrop.delete(canonicalKey(repo.root));
    await repo.refresher.refreshNow();
    return true;
  }

  private async read(repo: RepoHandle, args: string[]): Promise<string> {
    const result = await repo.queue.enqueue({
      label: 'undo/drop read',
      kind: 'read',
      run: (git, token) =>
        git.exec(repo.root, args, { structured: true, noOptionalLocks: true, token }),
    });
    return result.stdout;
  }

  private async tryRevParse(repo: RepoHandle, rev: string): Promise<string | undefined> {
    const result = await repo.queue.enqueue({
      label: 'undo/drop rev-parse',
      kind: 'read',
      run: (git, token) =>
        git.exec(repo.root, ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`], {
          structured: true,
          noOptionalLocks: true,
          allowNonZeroExit: true,
          token,
        }),
    });
    if (result.exitCode !== 0) return undefined;
    const sha = result.stdout.trim();
    return /^[0-9a-f]{40,64}$/.test(sha) ? sha : undefined;
  }
}
