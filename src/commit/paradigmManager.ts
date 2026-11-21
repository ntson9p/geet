/**
 * ParadigmManager (P3-T1): owns geet.commit.paradigm and the
 * `geet.paradigm` context key every commit-UI `when` clause hangs off.
 * Switching staging→changelists unstages everything (changelists ignore the
 * index) after a modal confirm.
 */
import * as vscode from 'vscode';
import { writeSetting } from '../ui/writeSetting';
import type { Core } from '../core/core';
import { Emitter, type Event } from '../core/util/events';
import { confirmModal } from '../ui/confirm';

export type CommitParadigm = 'changelists' | 'staging';

export class ParadigmManager implements vscode.Disposable {
  private readonly _onDidChange = new Emitter<CommitParadigm>();
  readonly onDidChange: Event<CommitParadigm> = this._onDidChange.event;
  private readonly subs: vscode.Disposable[] = [];
  private current: CommitParadigm;

  constructor(private readonly core: Core) {
    this.current = this.read();
    void this.applyContext();
    this.subs.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('geet.commit.paradigm')) {
          const next = this.read();
          if (next !== this.current) {
            this.current = next;
            void this.applyContext();
            this._onDidChange.fire(next);
          }
        }
      }),
    );
  }

  get paradigm(): CommitParadigm {
    return this.current;
  }

  private read(): CommitParadigm {
    const v = vscode.workspace
      .getConfiguration('geet')
      .get<string>('commit.paradigm', 'changelists');
    return v === 'staging' ? 'staging' : 'changelists';
  }

  private async applyContext(): Promise<void> {
    await vscode.commands.executeCommand('setContext', 'geet.paradigm', this.current);
  }

  /** `geet.commit.switchParadigm` — flips the setting with side effects. */
  async switch(): Promise<void> {
    const target: CommitParadigm = this.current === 'changelists' ? 'staging' : 'changelists';
    if (target === 'changelists') {
      // Changelists ignore the index: unstage everything so state is honest.
      const anyStaged = this.core.repos.some((r) =>
        r.model.snapshot.statusEntries.some((e) => e.kind !== 'untracked' && e.kind !== 'ignored' && e.x !== '.'),
      );
      if (anyStaged) {
        const ok = await confirmModal(
          vscode.l10n.t('Switch to changelists?'),
          vscode.l10n.t(
            'The changelists paradigm ignores the git index. Currently staged changes will be unstaged (files stay modified).',
          ),
          vscode.l10n.t('Unstage and Switch'),
        );
        if (!ok) return;
        for (const repo of this.core.repos) {
          await repo.queue.enqueue({
            label: vscode.l10n.t('Unstage all (paradigm switch)'),
            kind: 'mutate',
            run: async (git, token) => {
              await git.exec(repo.root, ['reset', '-q'], { token, allowNonZeroExit: true });
            },
          });
        }
      }
    }
    await writeSetting('geet', 'commit.paradigm', target);
    // The config listener fires the change; ensure prompt UI update even if
    // the workspace value matches the global default.
    if (this.read() === target && this.current !== target) {
      this.current = target;
      await this.applyContext();
      this._onDidChange.fire(target);
    }
  }

  dispose(): void {
    for (const s of this.subs) s.dispose();
    this._onDidChange.dispose();
  }
}
