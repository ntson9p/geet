/**
 * P6-T7 — operation lifecycle integration: sessions are created/refreshed
 * automatically from model transitions (`inProgressOp` + unmerged status)
 * and from queue mutations that fail with a classified `merge-conflict`;
 * producer ops without a .git marker (stash-pop, unshelve, checkout -m)
 * announce themselves through `expectConflict` (P2-T4 / P7 callers).
 *
 * While a session lives, the repo's mutation lane is HELD: unrelated
 * mutations queue behind resolution (reads still flow), preventing index
 * corruption mid-resolution. Resolution ops carry `bypassHold` so the pause
 * can end. Completion routes to a contextual CTA per producer; abort
 * routing lives on the session (T1) — stash/unshelve get re-apply guidance.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { conflictedFilesCount } from '../ui/counts';
import type { Core, RepoHandle } from '../core/core';
import { stopIdentity } from '../core/model/inProgressOp';
import { canonicalKey } from '../core/repoDiscovery';
import { DisposableStore } from '../core/util/events';
import { staleNotice } from '../ui/notify';
import { conflictsDialogEnabled } from './conflictsDialog';
import { ConflictSession, type ConflictSource } from './conflictSession';

/** P14-T4 — the commit window's message box, via the phase03 registry. */
interface Phase03MessageBox {
  messageBoxFor(repo: RepoHandle): { value: string } | undefined;
}

/** What the user did, in the words of the menus they did it from. */
function operationName(source: ConflictSource): string {
  switch (source) {
    case 'merge':
      return vscode.l10n.t('Merge');
    case 'rebase':
      return vscode.l10n.t('Rebase');
    case 'cherry-pick':
      return vscode.l10n.t('Cherry-pick');
    case 'revert':
      return vscode.l10n.t('Revert');
    case 'stash-pop':
      return vscode.l10n.t('Unstash');
    case 'unshelve':
      return vscode.l10n.t('Unshelve');
    case 'checkout-merge':
      return vscode.l10n.t('Checkout');
  }
}

export class MergeLifecycle implements vscode.Disposable {
  private readonly sessions = new Map<string, ConflictSession>();
  private readonly holds = new Map<string, { dispose(): void }>();
  /** One-shot producer hints for op-less conflicts (stash-pop, unshelve, checkout -m). */
  private readonly expected = new Map<string, ConflictSource>();
  /** Repositories whose conflicts an operation in progress will report itself, and how many hold each. */
  private readonly quiet = new Map<string, number>();
  /** Unmerged paths at each repository's last look: a session's new stop is 0 → some. */
  private readonly unmergedSeen = new Map<string, number>();
  private readonly store = new DisposableStore();
  private readonly _onDidChangeSessions = new vscode.EventEmitter<void>();
  readonly onDidChangeSessions = this._onDidChangeSessions.event;
  /**
   * P13-T8 · S7: a conflicted stop just began. IntelliJ gates on a `Files
   * Merged with Conflicts` **dialog** here; the persistent tree view stays as
   * the ongoing surface. Fires once for a session's first stop, and again for
   * each later stop of the same operation on conflicts of its own — a rebase's
   * next step, a cherry-pick sequence's next pick — as IntelliJ shows its
   * dialog at every one (POST-QA).
   */
  private readonly _onDidStartSession = new vscode.EventEmitter<ConflictSession>();
  readonly onDidStartSession = this._onDidStartSession.event;

  constructor(
    private readonly core: Core,
    private readonly trace: (line: string) => void,
  ) {
    for (const repo of core.repos) this.attach(repo);
    this.store.add(core.onDidAddRepo((repo) => this.attach(repo)));
  }

  get(repoRoot: string): ConflictSession | undefined {
    return this.sessions.get(canonicalKey(repoRoot));
  }

  all(): ConflictSession[] {
    return [...this.sessions.values()];
  }

  /**
   * Producer seam: an operation that is about to (or just did) drop op-less
   * conflicts registers its identity so the next session classifies right.
   */
  expectConflict(repoRoot: string, source: ConflictSource): void {
    this.expected.set(canonicalKey(repoRoot), source);
  }

  /**
   * POST-P14aw: while held, a session starting in `repoRoot` raises no toast of
   * its own — the operation holding it names the conflicts in its result, and
   * Update Project across seven repositories would otherwise say "merge
   * produced 1 conflicted file(s)" once for each, before its own summary. The
   * session itself, the Conflicts view and the dialog are unchanged.
   */
  holdNotices(repoRoot: string): vscode.Disposable {
    const key = canonicalKey(repoRoot);
    this.quiet.set(key, (this.quiet.get(key) ?? 0) + 1);
    let released = false;
    return new vscode.Disposable(() => {
      if (released) return;
      released = true;
      const left = (this.quiet.get(key) ?? 1) - 1;
      if (left > 0) this.quiet.set(key, left);
      else this.quiet.delete(key);
    });
  }

  private attach(repo: RepoHandle): void {
    repo.disposables.add(
      repo.model.onDidChange((sections) => {
        if (sections.has('status') || sections.has('op')) this.evaluate(repo);
      }),
    );
    // A mutation that died on a classified merge-conflict may land before
    // any watcher event — refresh immediately so the session appears now.
    repo.disposables.add(
      repo.queue.onDidFinishMutation((e) => {
        if (e.errorKind === 'merge-conflict') {
          this.trace(`"${e.label}" hit a merge conflict — refreshing for session creation`);
          void repo.refresher.refreshNow();
        }
      }),
    );
    this.evaluate(repo);
  }

  private sourceOf(repo: RepoHandle): ConflictSource {
    switch (repo.model.snapshot.inProgressOp?.kind) {
      case 'merge':
        return 'merge';
      case 'rebase-interactive':
      case 'rebase-apply':
        return 'rebase';
      case 'cherry-pick':
        return 'cherry-pick';
      case 'revert':
        return 'revert';
      case undefined:
      default: {
        // No .git marker: trust the producer hint, else checkout -m style.
        return this.expected.get(canonicalKey(repo.root)) ?? 'checkout-merge';
      }
    }
  }

  private evaluate(repo: RepoHandle): void {
    const key = canonicalKey(repo.root);
    const existing = this.sessions.get(key);
    const unmerged = repo.model.snapshot.statusEntries.filter((e) => e.kind === 'unmerged').length;
    const before = this.unmergedSeen.get(key) ?? 0;
    this.unmergedSeen.set(key, unmerged);

    if (!existing && unmerged > 0) {
      const source = this.sourceOf(repo);
      this.expected.delete(key);
      const session = new ConflictSession(repo, source);
      this.sessions.set(key, session);
      // §4: hold the mutation lane for the duration of the pause.
      this.holds.set(key, repo.queue.holdMutations(`conflict resolution (${source})`));
      this._onDidChangeSessions.fire();
      session.onDidChange(() => this._onDidChangeSessions.fire());
      session.onDidResolveAll(() => {
        this._onDidChangeSessions.fire();
        this.offerCompletion(session);
      });
      this.announce(session, unmerged);
      return;
    }

    if (existing && unmerged === 0 && repo.model.snapshot.inProgressOp === undefined) {
      this.endSession(key, existing);
      return;
    }
    if (existing) {
      this._onDidChangeSessions.fire();
      // The operation went on and stopped again on conflicts of its own: a
      // stop like the first, not a silent change to the view (POST-QA).
      if (before === 0 && unmerged > 0) this.announce(existing, unmerged);
    }
  }

  /**
   * IntelliJ Conflicts-dialog parity: reveal, and one notice per conflicted
   * stop. The Files Merged with Conflicts dialog is that notice when it is
   * on; a toast as well made two, three with the operation's own (POST-QA).
   */
  private announce(session: ConflictSession, unmerged: number): void {
    const repo = session.repo;
    void vscode.commands.executeCommand('gittree.conflicts.focus');
    if (!this.quiet.has(canonicalKey(repo.root)) && !conflictsDialogEnabled()) {
      const show = vscode.l10n.t('Show Conflicts');
      // With several repositories open, which one: the toast was the same for each.
      // The operation by its name, not its id: `stash-pop produced 1
      // conflicted file(s)` read like a log line (POST-QA).
      const message =
        this.core.repos.length > 1
          ? vscode.l10n.t(
              '{0} in {1} stopped on {2}.',
              operationName(session.source),
              path.basename(repo.root),
              conflictedFilesCount(unmerged),
            )
          : vscode.l10n.t('{0} stopped on {1}.', operationName(session.source), conflictedFilesCount(unmerged));
      void vscode.window.showWarningMessage(message, show).then((choice) => {
        if (choice === show) return vscode.commands.executeCommand('gittree.conflicts.focus');
        return undefined;
      });
    }
    // Fired last, so a subscriber that opens the S7 dialog sees a session
    // that is already registered and holding the mutation lane.
    this._onDidStartSession.fire(session);
  }

  private endSession(key: string, session: ConflictSession): void {
    session.ended = true;
    session.dispose();
    this.sessions.delete(key);
    this.holds.get(key)?.dispose();
    this.holds.delete(key);
    this._onDidChangeSessions.fire();
  }

  /** Contextual CTA once every conflict in the session is resolved. */
  private offerCompletion(session: ConflictSession): void {
    const op = session.repo.model.snapshot.inProgressOp;
    const steps =
      op?.step !== undefined && op.total !== undefined ? ` (${op.step}/${op.total})` : '';
    // Clicked from the notification centre once the operation went on — the
    // merge committed, the rebase or pick on to its next stop, whose
    // conflicts this notification never saw: said, not acted on (POST-QA).
    const at = stopIdentity(session.repo.dirs.gitDir);
    const stale = (): boolean => session.ended || stopIdentity(session.repo.dirs.gitDir) !== at;
    switch (session.source) {
      case 'checkout-merge':
        // Plain done — the resolved index IS the completed operation.
        return;
      case 'stash-pop':
      case 'unshelve':
        void vscode.window.showInformationMessage(
          vscode.l10n.t('All conflicts resolved — the applied changes are ready to commit.'),
        );
        return;
      case 'merge': {
        const commit = vscode.l10n.t('Commit Merge…');
        void vscode.window
          .showInformationMessage(vscode.l10n.t('All conflicts resolved.'), commit)
          .then((choice) => {
            if (choice !== commit) return undefined;
            if (stale()) return staleNotice();
            return this.openMergeCommitUi(session.repo);
          });
        return;
      }
      case 'rebase':
      case 'cherry-pick':
      case 'revert': {
        const label =
          session.source === 'rebase'
            ? vscode.l10n.t('Continue Rebase{0}…', steps)
            : session.source === 'cherry-pick'
              ? vscode.l10n.t('Continue Cherry-pick{0}…', steps)
              : vscode.l10n.t('Continue Revert{0}…', steps);
        void vscode.window
          .showInformationMessage(vscode.l10n.t('All conflicts resolved.'), label)
          .then(async (choice): Promise<void> => {
            if (choice !== label) return;
            if (stale()) {
              staleNotice();
              return;
            }
            await session.continueOp();
          });
        return;
      }
    }
  }

  /** "Commit Merge…": commit window with the merge message prefilled (MERGE_MSG). */
  private async openMergeCommitUi(repo: RepoHandle): Promise<void> {
    // P14-T4: the SCM input box is gone; the commit window's message box is
    // where a message lives, and phase03 owns it.
    const p3 = this.core.debugRegistry.get('phase03') as Phase03MessageBox | undefined;
    const input = p3?.messageBoxFor(repo);
    if (input && input.value.trim().length === 0) {
      try {
        const msg = fs.readFileSync(path.join(repo.dirs.gitDir, 'MERGE_MSG'), 'utf8');
        input.value = msg
          .split('\n')
          .filter((l) => !l.startsWith('#'))
          .join('\n')
          .trim();
      } catch {
        this.trace('MERGE_MSG unreadable — commit UI opens without a prefill');
      }
    }
    // P14-T1: our own container, not VS Code's SCM one — and the Commit view
    // in it, expanded: the container alone left a collapsed Commit view
    // collapsed, the message nowhere to be seen (POST-QA).
    await vscode.commands.executeCommand('gittree.commit.focus');
  }

  dispose(): void {
    for (const [key, session] of [...this.sessions]) this.endSession(key, session);
    for (const hold of this.holds.values()) hold.dispose();
    this.holds.clear();
    this.store.dispose();
    this._onDidChangeSessions.dispose();
    this._onDidStartSession.dispose();
  }
}
