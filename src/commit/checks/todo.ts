/**
 * TODO check (P3-T7 step 5): scan only the ADDED lines of the commit for
 * TODO/FIXME-style markers. Non-blocking — the reminder, not the police.
 */
import * as path from 'node:path';
import * as vscode from 'vscode';
import { changesVsHead } from './changedRanges';
import type { CommitCheck } from './pipeline';
import { scanAddedTodos, type TodoHit } from './todoScanner';
export { scanAddedTodos, type TodoHit } from './todoScanner';

export function todoPattern(): RegExp {
  const raw = vscode.workspace
    .getConfiguration('geet.commit.checks')
    .get<string>('todoPattern', '\\b(TODO|FIXME)\\b');
  try {
    return new RegExp(raw);
  } catch {
    return /\b(TODO|FIXME)\b/;
  }
}

export const todoCheck: CommitCheck = {
  id: 'todo',
  label: vscode.l10n.t('TODO check (new comments)'),
  configKey: 'todo',
  advanced: true,
  async run(ctx) {
    const pattern = todoPattern();
    const all: Array<{ uri: vscode.Uri; hit: TodoHit }> = [];
    for (const uri of ctx.files) {
      if (ctx.token.isCancellationRequested) break;
      const target = await changesVsHead(ctx.repo, uri, ctx.baseRev ?? 'HEAD');
      if (!target) continue;
      for (const hit of scanAddedTodos(target.changes, target.doc.getText(), pattern)) {
        all.push({ uri, hit });
      }
    }
    if (all.length === 0) return { ok: true };
    const first = all[0]!;
    const list = all
      .slice(0, 8)
      .map((h) => `${path.basename(h.uri.fsPath)}:${h.hit.line} ${h.hit.text.slice(0, 60)}`)
      .join('\n');
    return {
      ok: false,
      blocking: false,
      message:
        (all.length === 1
          ? vscode.l10n.t('1 new TODO-like comment:')
          : vscode.l10n.t('{0} new TODO-like comments:', all.length)) +
        '\n' +
        list +
        (all.length > 8 ? '\n…' : ''),
      reveal: async () => {
        const editor = await vscode.window.showTextDocument(first.uri);
        const pos = new vscode.Position(first.hit.line - 1, 0);
        editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
        editor.selection = new vscode.Selection(pos, pos);
      },
    };
  },
};
