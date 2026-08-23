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
import type { Core, RepoHandle } from '../core/core';
import { canonicalKey } from '../core/repoDiscovery';
import { DisposableStore } from '../core/util/events';
import { ConflictSession, type ConflictSource } from './conflictSession';

interface Phase01SourceControls {
  sourceControls: Map<string, { sc: vscode.SourceControl }>;
}

export class MergeLifecycle implements vscode.Disposable {
  private readonly sessions = new Map<string, ConflictSession>();
  private readonly holds = new Map<string, { dispose(): void }>();
  /** One-shot producer hints for op-less conflicts (stash-pop, unshelve, checkout -m). */
  private readonly expected = new Map<string, ConflictSource>();
  private readonly store = new DisposableStore();
  private readonly _onDidChangeSessions = new vscode.EventEmitter<void>();
  readonly onDidChangeSessions = this._onDidChangeSessions.event;
  /**
   * P13-T8 · S7: a conflicted operation just started. IntelliJ gates on a
   * `Files Merged with Conflicts` **dialog** here; the persistent tree view
   * stays as the ongoing surface, so this fires exactly once per session.
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

    if (!existing && unmerged > 0) {
      const source = this.sourceOf(repo);
      this.expected.delete(key);
      const session = new ConflictSession(repo, source);
      this.sessions.set(key, session);
      // §4: hold the mutation lane for the duration of the pause.
      this.holds.set(key, repo.queue.holdMutations(`conflict resolution (${source})`));
      this._onDidChangeSessions.fire();
      // IntelliJ Conflicts-dialog parity: reveal + one-shot toast.
      void vscode.commands.executeCommand('gittree.conflicts.focus');
      const show = vscode.l10n.t('Show Conflicts');
      void vscode.window
        .showWarningMessage(
          vscode.l10n.t('{0} produced {1} conflicted file(s).', source, unmerged),
          show,
        )
        .then((choice) => {
          if (choice === show) return vscode.commands.executeCommand('gittree.conflicts.focus');
          return undefined;
        });
      session.onDidChange(() => this._onDidChangeSessions.fire());
      session.onDidResolveAll(() => {
        this._onDidChangeSessions.fire();
        this.offerCompletion(session);
      });
      // Fired last, so a subscriber that opens the S7 dialog sees a session
      // that is already registered and holding the mutation lane.
      this._onDidStartSession.fire(session);
      return;
    }

    if (existing && unmerged === 0 && repo.model.snapshot.inProgressOp === undefined) {
      this.endSession(key, existing);
      return;
    }
    if (existing) this._onDidChangeSessions.fire();
  }

  private endSession(key: string, session: ConflictSession): void {
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
          .then((choice) => (choice === commit ? this.openMergeCommitUi(session.repo) : undefined));
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
          .then((choice) => (choice === label ? session.continueOp() : undefined));
        return;
      }
    }
  }

  /** "Commit Merge…": SCM view with the merge message prefilled (MERGE_MSG). */
  private async openMergeCommitUi(repo: RepoHandle): Promise<void> {
    const p1 = this.core.debugRegistry.get('phase01') as Phase01SourceControls | undefined;
    const input = p1?.sourceControls.get(canonicalKey(repo.root))?.sc.inputBox;
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
    // P14-T1: our own container, not VS Code's SCM one.
    await vscode.commands.executeCommand('workbench.view.extension.gittree');
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
