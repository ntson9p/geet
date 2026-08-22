/**
 * Commit message history & input UX (P3-T6): 50-entry ring buffer per repo
 * identity in globalState, history QuickPick (SCM title button + ctrl+up),
 * commit.template prefill, subject-length soft hint.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { Core, RepoHandle } from '../core/core';
import { repoIdentityHash } from '../core/util/repoIdentity';
import type { CommitMessageBox } from './messageBox';

const RING_SIZE = 50;

interface HistoryEntry {
  message: string;
  ts: number;
}

export class MessageHistory {
  constructor(
    private readonly core: Core,
    private readonly globalState: vscode.Memento,
  ) {}

  private async key(repo: RepoHandle): Promise<string> {
    return `gittree.msghistory.${await repoIdentityHash(repo)}`;
  }

  async entries(repo: RepoHandle): Promise<HistoryEntry[]> {
    return this.globalState.get<HistoryEntry[]>(await this.key(repo)) ?? [];
  }

  async push(repo: RepoHandle, message: string): Promise<void> {
    const trimmed = message.trim();
    if (trimmed.length === 0) return;
    const key = await this.key(repo);
    const entries = this.globalState.get<HistoryEntry[]>(key) ?? [];
    if (entries[0]?.message === trimmed) return; // dedupe consecutive
    entries.unshift({ message: trimmed, ts: Date.now() });
    await this.globalState.update(key, entries.slice(0, RING_SIZE));
  }

  async showPicker(repo: RepoHandle, inputBox: CommitMessageBox): Promise<void> {
    const entries = await this.entries(repo);
    if (entries.length === 0) {
      void vscode.window.showInformationMessage(vscode.l10n.t('No commit message history yet.'));
      return;
    }
    const picked = await vscode.window.showQuickPick(
      entries.map((e) => ({
        label: e.message.split('\n')[0] ?? e.message,
        detail: relativeTime(e.ts),
        message: e.message,
      })),
      { placeHolder: vscode.l10n.t('Commit message history'), matchOnDetail: true },
    );
    if (picked) inputBox.value = picked.message;
  }

  /** commit.template prefill when the input is empty (P3-T6 step 3). */
  async applyTemplate(repo: RepoHandle, inputBox: CommitMessageBox): Promise<void> {
    if (inputBox.value.trim().length > 0) return;
    const result = await repo.queue.enqueue({
      label: 'read commit.template',
      kind: 'read',
      run: (git, token) =>
        git.exec(repo.root, ['config', '--get', 'commit.template'], {
          structured: true,
          noOptionalLocks: true,
          allowNonZeroExit: true,
          token,
        }),
    });
    if (result.exitCode !== 0) return;
    let templatePath = result.stdout.trim();
    if (templatePath.length === 0) return;
    if (templatePath.startsWith('~')) {
      templatePath = path.join(process.env['HOME'] ?? process.env['USERPROFILE'] ?? '', templatePath.slice(1));
    }
    if (!path.isAbsolute(templatePath)) templatePath = path.join(repo.root, templatePath);
    try {
      const content = fs.readFileSync(templatePath, 'utf8');
      // Commit templates conventionally carry #-comment guidance; strip it.
      const cleaned = content
        .split('\n')
        .filter((l) => !l.startsWith('#'))
        .join('\n')
        .replace(/\n+$/, '');
      if (inputBox.value.trim().length === 0) inputBox.value = cleaned;
    } catch {
      // unreadable template — ignore
    }
  }
}

/** One recent commit whose message the Amend ▾ dropdown can reuse (P11-T4). */
export interface RecentCommitMessage {
  sha: string;
  shortSha: string;
  subject: string;
  message: string;
}

/**
 * Recent commits for the commit window's `Amend  last commit ▾` dropdown
 * (P11-T4 step 4). NUL separates sha from body and RS separates records, so a
 * multi-line body — the very thing worth reusing — survives parsing intact.
 */
export async function recentCommitMessages(
  repo: RepoHandle,
  limit: number,
): Promise<RecentCommitMessage[]> {
  const result = await repo.queue.enqueue({
    label: 'read recent commit messages',
    kind: 'read',
    run: (git, token) =>
      git.exec(repo.root, ['log', `-${limit}`, '--format=%H%x00%B%x1e'], {
        structured: true,
        noOptionalLocks: true,
        allowNonZeroExit: true, // an unborn HEAD is "no commits", not an error
        token,
      }),
  });
  if (result.exitCode !== 0) return [];
  const commits: RecentCommitMessage[] = [];
  for (const record of result.stdout.split('\x1e')) {
    const cut = record.indexOf('\x00');
    if (cut < 0) continue;
    const sha = record.slice(0, cut).replace(/^\s+/, '');
    if (!/^[0-9a-f]{40}$/.test(sha)) continue;
    const message = record.slice(cut + 1).replace(/\n+$/, '');
    commits.push({
      sha,
      shortSha: sha.slice(0, 8),
      subject: message.split('\n')[0] ?? '',
      message,
    });
  }
  return commits;
}

function relativeTime(ts: number): string {
  const minutes = Math.round((Date.now() - ts) / 60_000);
  if (minutes < 1) return vscode.l10n.t('just now');
  if (minutes < 60) return vscode.l10n.t('{0} min ago', minutes);
  const hours = Math.round(minutes / 60);
  if (hours < 24) return vscode.l10n.t('{0} h ago', hours);
  return new Date(ts).toLocaleDateString();
}

/** Soft 72-char subject hint appended to the placeholder (validation API is proposed-only). */
export function subjectHint(message: string, basePlaceholder: string): string {
  const subject = message.split('\n')[0] ?? '';
  if (subject.length > 72) {
    return `${basePlaceholder} — ${vscode.l10n.t('subject is {0} chars (aim ≤ 72)', subject.length)}`;
  }
  return basePlaceholder;
}
