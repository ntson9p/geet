/**
 * Drop Commits and Squash Commits… from the log's selection (IntelliJ's
 * `GitDropLogAction` / `GitSquashLogAction`), for any number of commits on the
 * current branch, adjacent or not. Both run through the T1 rebase engine, like
 * Drop Commit and Edit Commit Message do, and both leave an in-session Undo.
 *
 * The checks are IntelliJ's (`GitCommitEditingActionBase`): every selected
 * commit in the current branch, no merge between the oldest of them and HEAD,
 * not the initial commit. Commits already on the upstream are asked about,
 * which is GitTree's published guard (P5), where IntelliJ refuses commits on a
 * protected branch.
 */
import * as vscode from 'vscode';
import type { RepoHandle } from '../core/core';
import { canonicalKey } from '../core/repoDiscovery';
import { confirmModal } from '../ui/confirm';
import { buildDropPlan, buildSquashPlan, isContiguous, prettySquash } from './multiCommitPlans';
import { isPublished } from './publishedGuard';
import type { RebaseEngine, RebaseOutcome } from './rebase/rebaseEngine';
import { undoHistoryEdit, type HistoryEdit, type HistoryEditKind } from './undoEdit';

export type MultiEditResult = RebaseOutcome['status'] | 'refused' | 'cancelled';

/** Where the selected commits sit on the current branch. */
interface Prepared {
  /** The parent of the oldest selected commit: what the rebase replays onto. */
  readonly base: string;
  /** `base..HEAD`, oldest first. */
  readonly range: readonly string[];
  readonly selected: ReadonlySet<string>;
}

/** Opens the message to edit; resolves with it, or `undefined` when cancelled. */
export type PromptMessage = (original: string, acceptTitle: string) => Promise<string | undefined>;

const SHA = /^[0-9a-f]{40,64}$/u;

export class MultiCommitEditService {
  /** The last drop or squash per repository: HEAD before and after — what Undo needs. */
  private readonly lastEdit = new Map<string, HistoryEdit & { kind: HistoryEditKind }>();

  constructor(
    private readonly engineFor: (repo: RepoHandle) => RebaseEngine | undefined,
    private readonly promptMessage: PromptMessage,
  ) {}

  /** Drop Commits: every selected commit gone, the rest replayed. */
  async dropCommits(repo: RepoHandle, shas: readonly string[]): Promise<MultiEditResult> {
    const engine = this.engineFor(repo);
    if (!engine) return 'failed';
    const ready = await this.prepare(repo, shas, {
      title: vscode.l10n.t('Drop published commits?'),
      action: vscode.l10n.t('Drop Anyway'),
      what: vscode.l10n.t('Dropping them'),
    });
    if (ready === undefined) return 'refused';

    const preHead = await this.revParse(repo, 'HEAD');
    const members = ready.range.filter((sha) => ready.selected.has(sha));
    // One unbroken run needs no todo; it is also the only way to drop every
    // commit above the base, which a todo of nothing but drops cannot say.
    const outcome = isContiguous(ready.range, ready.selected)
      ? await engine.dropRange(members[0]!, members[members.length - 1]!, members.length)
      : await engine.start(buildDropPlan(ready.base, ready.range, ready.selected));
    if (outcome.status === 'completed') {
      await this.offerUndo(repo, preHead, 'drop', vscode.l10n.t('Dropped {0} commits.', members.length));
    }
    return outcome.status;
  }

  /**
   * Squash Commits…: the selected commits become one, at the place of the
   * oldest of them, with a message edited from all of theirs.
   */
  async squashCommits(repo: RepoHandle, shas: readonly string[]): Promise<MultiEditResult> {
    if (new Set(shas).size < 2) return 'refused';
    const engine = this.engineFor(repo);
    if (!engine) return 'failed';
    const ready = await this.prepare(repo, shas, {
      title: vscode.l10n.t('Squash published commits?'),
      action: vscode.l10n.t('Squash Anyway'),
      what: vscode.l10n.t('Squashing them'),
    });
    if (ready === undefined) return 'refused';

    // IntelliJ starts from the selected messages in the order they are listed.
    const messages = await this.messagesOf(repo, [...new Set(shas)]);
    const message = await this.promptMessage(prettySquash(messages), vscode.l10n.t('Squash Commits'));
    if (message === undefined || message.trim().length === 0) return 'cancelled';

    const preHead = await this.revParse(repo, 'HEAD');
    const outcome = await engine.start(buildSquashPlan(ready.base, ready.range, ready.selected, message));
    if (outcome.status === 'completed') {
      await this.offerUndo(repo, preHead, 'squash', vscode.l10n.t('Squashed {0} commits.', ready.selected.size));
    }
    return outcome.status;
  }

  /**
   * Back to where the repository was before the last drop or squash — while
   * HEAD is still where that edit left it; local changes are kept
   * (`undoHistoryEdit`, POST-QA F4).
   */
  async undoLast(repo: RepoHandle): Promise<boolean> {
    const key = canonicalKey(repo.root);
    const edit = this.lastEdit.get(key);
    if (edit === undefined) return false;
    const done = await undoHistoryEdit(repo, edit, edit.kind);
    // Either way this edit cannot be undone again: done, or HEAD has moved on.
    if (this.lastEdit.get(key) === edit) this.lastEdit.delete(key);
    return done;
  }

  private async offerUndo(
    repo: RepoHandle,
    preHead: string | undefined,
    kind: HistoryEditKind,
    message: string,
  ): Promise<void> {
    const postHead = await this.revParse(repo, 'HEAD');
    if (preHead !== undefined && postHead !== undefined) {
      this.lastEdit.set(canonicalKey(repo.root), { preHead, postHead, kind });
    }
    const undo = vscode.l10n.t('Undo');
    void vscode.window.showInformationMessage(message, undo).then(async (choice) => {
      if (choice === undo) await this.undoLast(repo);
    });
  }

  /**
   * IntelliJ's checks, each said plainly when it fails: the commits lie on the
   * current branch, above a parent, with no merge between them and HEAD; and
   * commits already pushed are confirmed before history is rewritten.
   */
  private async prepare(
    repo: RepoHandle,
    shas: readonly string[],
    published: { title: string; action: string; what: string },
  ): Promise<Prepared | undefined> {
    const selected = new Set(shas.filter((s) => SHA.test(s)));
    if (selected.size === 0) return undefined;

    // On one line of history the common ancestor of them all is the oldest.
    const oldest = (await this.read(repo, ['merge-base', '--octopus', ...selected])).trim();
    if (!selected.has(oldest)) return this.refuse(vscode.l10n.t('The selected commits are not all in the current branch.'));

    const base = await this.revParse(repo, `${oldest}^`);
    if (base === undefined) {
      return this.refuse(vscode.l10n.t('The initial commit cannot be changed this way — it has no parent.'));
    }
    const merge = (await this.read(repo, ['rev-list', '--merges', '--max-count=1', `${base}..HEAD`])).trim();
    if (merge.length > 0) {
      return this.refuse(
        vscode.l10n.t(
          'Commit {0} between the selection and HEAD is a merge — rewriting past it would flatten it.',
          merge.slice(0, 7),
        ),
      );
    }
    const range = (await this.read(repo, ['rev-list', '--reverse', `${base}..HEAD`]))
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    const outside = [...selected].find((sha) => !range.includes(sha));
    if (outside !== undefined) {
      return this.refuse(vscode.l10n.t('Commit {0} is not in the current branch.', outside.slice(0, 7)));
    }

    if (await isPublished(repo, oldest)) {
      const ok = await confirmModal(
        published.title,
        vscode.l10n.t(
          'Some of these commits are already on the upstream. {0} rewrites shared history and will require a force push.',
          published.what,
        ),
        published.action,
      );
      if (!ok) return undefined;
    }
    return { base, range, selected };
  }

  private refuse(message: string): undefined {
    void vscode.window.showErrorMessage(message);
    return undefined;
  }

  /** Each commit's full message, in the order given. */
  private async messagesOf(repo: RepoHandle, shas: readonly string[]): Promise<string[]> {
    const raw = await this.read(repo, ['log', '--no-walk=unsorted', '--format=%B%x00', ...shas]);
    return raw
      .split('\0')
      .map((m) => m.replace(/^\n+/u, '').replace(/\n+$/u, ''))
      .filter((m) => m.length > 0);
  }

  private async revParse(repo: RepoHandle, rev: string): Promise<string | undefined> {
    const sha = (await this.read(repo, ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`])).trim();
    return SHA.test(sha) ? sha : undefined;
  }

  private async read(repo: RepoHandle, args: string[]): Promise<string> {
    const result = await repo.queue.enqueue({
      label: 'drop/squash read',
      kind: 'read',
      run: (git, token) =>
        git.exec(repo.root, args, { structured: true, noOptionalLocks: true, allowNonZeroExit: true, token }),
    });
    return result.exitCode === 0 ? result.stdout : '';
  }
}
