/**
 * Reword from log (P5-T5): "Edit Commit Message…" opens the original message
 * in an untitled git-commit editor with Accept/Cancel CodeLenses (IntelliJ
 * dialog parity without proposed APIs). HEAD rewords via
 * `commit --amend --only -F` (staged changes are NOT swept into the commit);
 * non-HEAD rewords run a full-range T1 plan with a single reword entry.
 * The published guard applies to both paths.
 */
import * as vscode from 'vscode';
import { notifySuccess } from '../ui/notify';
import type { RepoHandle } from '../core/core';
import { confirmModal } from '../ui/confirm';
import { isPublished } from './publishedGuard';
import type { RebasePlan, RebasePlanEntry } from './rebase/planSerializer';
import type { RebaseEngine } from './rebase/rebaseEngine';

export type RewordResult = 'done' | 'cancelled' | 'refused' | 'failed';

interface PendingEditor {
  resolve(message: string | undefined): void;
  /** What the Accept lens says it does. */
  acceptTitle: string;
}

export class RewordService implements vscode.CodeLensProvider, vscode.Disposable {
  private readonly pending = new Map<string, PendingEditor>();
  private readonly _onDidChangeCodeLenses = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this._onDidChangeCodeLenses.event;
  private readonly subs: vscode.Disposable[] = [];

  constructor(private readonly engineFor: (repo: RepoHandle) => RebaseEngine | undefined) {
    this.subs.push(
      vscode.languages.registerCodeLensProvider({ scheme: 'untitled' }, this),
      vscode.commands.registerCommand('gittree.reword.accept', async (uri: unknown) => {
        const key = String(uri);
        const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === key);
        const entry = this.pending.get(key);
        if (entry && doc) {
          this.pending.delete(key);
          entry.resolve(doc.getText());
          await this.closeEditor(doc);
        }
      }),
      vscode.commands.registerCommand('gittree.reword.cancel', async (uri: unknown) => {
        const key = String(uri);
        const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === key);
        const entry = this.pending.get(key);
        if (entry) {
          this.pending.delete(key);
          entry.resolve(undefined);
          if (doc) await this.closeEditor(doc);
        }
      }),
      vscode.workspace.onDidCloseTextDocument((doc) => {
        const entry = this.pending.get(doc.uri.toString());
        if (entry) {
          this.pending.delete(doc.uri.toString());
          entry.resolve(undefined);
        }
      }),
    );
  }

  provideCodeLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
    const entry = this.pending.get(doc.uri.toString());
    if (entry === undefined) return [];
    const top = new vscode.Range(0, 0, 0, 0);
    return [
      new vscode.CodeLens(top, {
        command: 'gittree.reword.accept',
        title: vscode.l10n.t('$(check) Accept: {0}', entry.acceptTitle),
        arguments: [doc.uri.toString()],
      }),
      new vscode.CodeLens(top, {
        command: 'gittree.reword.cancel',
        title: vscode.l10n.t('$(close) Cancel'),
        arguments: [doc.uri.toString()],
      }),
    ];
  }

  /** Entry point: reword `sha` on the current branch. */
  async reword(repo: RepoHandle, sha: string): Promise<RewordResult> {
    const full = await this.revParse(repo, sha);
    if (full === undefined) return 'failed';

    if (await isPublished(repo, full)) {
      const ok = await confirmModal(
        vscode.l10n.t('Reword a published commit?'),
        vscode.l10n.t(
          'Commit {0} is already on the upstream. Changing its message rewrites shared history and will require a force push.',
          full.slice(0, 7),
        ),
        vscode.l10n.t('Reword Anyway'),
      );
      if (!ok) return 'refused';
    }

    const original = (await this.read(repo, ['log', '-1', '--format=%B', full])).replace(/\n+$/, '');
    const message = await this.editMessage(original, full.slice(0, 7));
    if (message === undefined || message.trim().length === 0) return 'cancelled';
    if (message.replace(/\n+$/, '') === original) return 'cancelled';

    const head = await this.revParse(repo, 'HEAD');
    const result =
      head === full ? await this.rewordHead(repo, message) : await this.rewordMidHistory(repo, full, message);
    if (result === 'done' && head !== undefined) this.notifyChanged(repo, head);
    return result;
  }

  /**
   * IntelliJ's `Commit message changed`, with its `Undo`: back to the commit
   * as it was, while nothing else has happened to the branch since.
   */
  private notifyChanged(repo: RepoHandle, preHead: string): void {
    void this.revParse(repo, 'HEAD').then((postHead) => {
      notifySuccess(vscode.l10n.t('Commit message changed'), {
        title: vscode.l10n.t('Undo'),
        run: () => this.undo(repo, preHead, postHead),
      });
    });
  }

  private async undo(repo: RepoHandle, preHead: string, postHead: string | undefined): Promise<void> {
    const now = await this.revParse(repo, 'HEAD');
    if (postHead === undefined || now !== postHead) {
      void vscode.window.showWarningMessage(
        vscode.l10n.t('Cannot undo commit message edit: the repository has already been changed.'),
      );
      return;
    }
    // Only the message changed, so the trees match and `--keep` moves HEAD
    // without touching a single file, local changes included.
    await repo.queue.enqueue({
      label: vscode.l10n.t('Undo commit message edit'),
      kind: 'mutate',
      run: async (git, token) => {
        await git.exec(repo.root, ['reset', '--keep', preHead], { token });
      },
    });
    await repo.refresher.refreshNow();
  }

  /**
   * HEAD: message-only amend — `--only` keeps staged changes out. Like
   * P3-T5's amend this is not P9-destructive: the worktree is untouched and
   * the old commit stays reflog-reachable.
   */
  private async rewordHead(repo: RepoHandle, message: string): Promise<RewordResult> {
    await repo.queue.enqueue({
      label: vscode.l10n.t('Reword HEAD'),
      kind: 'mutate',
      run: async (git, token) => {
        await git.exec(repo.root, ['commit', '--amend', '--only', '--no-verify', '-F', '-'], {
          stdin: message.endsWith('\n') ? message : `${message}\n`,
          token,
        });
      },
    });
    await repo.refresher.refreshNow();
    return 'done';
  }

  /** Non-HEAD: full-range T1 plan with a single reword entry. */
  private async rewordMidHistory(
    repo: RepoHandle,
    sha: string,
    message: string,
  ): Promise<RewordResult> {
    const engine = this.engineFor(repo);
    if (!engine) return 'failed';
    const raw = await this.read(repo, ['rev-list', '--reverse', `${sha}^..HEAD`]);
    const range = raw.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
    if (range.length === 0 || range[0] !== sha) return 'failed';
    const entries: RebasePlanEntry[] = range.map((s) =>
      s === sha ? { sha: s, action: 'reword', message } : { sha: s, action: 'pick' },
    );
    const plan: RebasePlan = { baseSha: `${sha}^`, entries };
    const base = await this.revParse(repo, `${sha}^`);
    if (base === undefined) return 'failed';
    plan.baseSha = base;
    const outcome = await engine.start(plan);
    return outcome.status === 'completed' ? 'done' : 'failed';
  }

  /** Untitled git-commit editor; resolves on Accept/Cancel/close. */
  private async editMessage(original: string, shortSha: string): Promise<string | undefined> {
    return this.promptMessage(
      original,
      vscode.l10n.t('Rewrite Commit Message'),
      vscode.l10n.t('Editing message of {0} — use the Accept code lens to apply', shortSha),
    );
  }

  /**
   * The same editor for any message to be written before a rewrite — Squash
   * Commits… uses it for the squashed commit's message, as IntelliJ's
   * `Squashed Commit Message` dialog does.
   */
  async promptMessage(original: string, acceptTitle: string, status?: string): Promise<string | undefined> {
    const seeded = process.env['GITTREE_TEST_REWORD_MESSAGE'];
    if (seeded !== undefined) return seeded.length > 0 ? seeded : undefined;

    const doc = await vscode.workspace.openTextDocument({
      content: original,
      language: 'git-commit',
    });
    await vscode.window.showTextDocument(doc, { preview: false });
    void vscode.window.setStatusBarMessage(
      status ?? vscode.l10n.t('Use the Accept code lens to apply: {0}', acceptTitle),
      8000,
    );
    return new Promise<string | undefined>((resolve) => {
      this.pending.set(doc.uri.toString(), { resolve, acceptTitle });
      this._onDidChangeCodeLenses.fire();
    });
  }

  private async closeEditor(doc: vscode.TextDocument): Promise<void> {
    await vscode.window.showTextDocument(doc, { preview: false });
    await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
  }

  private async revParse(repo: RepoHandle, rev: string): Promise<string | undefined> {
    const raw = await this.read(repo, ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`]);
    const sha = raw.trim();
    return /^[0-9a-f]{40,64}$/.test(sha) ? sha : undefined;
  }

  private async read(repo: RepoHandle, args: string[]): Promise<string> {
    const result = await repo.queue.enqueue({
      label: 'reword read',
      kind: 'read',
      run: (git, token) =>
        git.exec(repo.root, args, {
          structured: true,
          noOptionalLocks: true,
          allowNonZeroExit: true,
          token,
        }),
    });
    return result.exitCode === 0 ? result.stdout : '';
  }

  dispose(): void {
    for (const [, entry] of this.pending) entry.resolve(undefined);
    this.pending.clear();
    for (const sub of this.subs) sub.dispose();
    this._onDidChangeCodeLenses.dispose();
  }
}
