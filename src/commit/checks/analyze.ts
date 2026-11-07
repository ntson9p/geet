/**
 * Analyze check (P3-T7 step 4): save targets, wait for diagnostics to
 * quiesce (1.2 s silence, 10 s cap), then gate on collected diagnostics at or
 * above gittree.commit.checks.analyzeSeverity. Non-blocking (IntelliJ lets
 * you commit anyway); Review opens the Problems view + first offender.
 */
import * as vscode from 'vscode';
import type { CommitCheck } from './pipeline';

const QUIESCE_MS = 1200;
const QUIESCE_CAP_MS = 10_000;

function severityFloor(): vscode.DiagnosticSeverity {
  const v = vscode.workspace
    .getConfiguration('gittree.commit.checks')
    .get<string>('analyzeSeverity', 'error');
  return v === 'warning' ? vscode.DiagnosticSeverity.Warning : vscode.DiagnosticSeverity.Error;
}

async function quiesce(uris: readonly vscode.Uri[], capMs = QUIESCE_CAP_MS): Promise<void> {
  const keys = new Set(uris.map((u) => u.toString()));
  await new Promise<void>((resolve) => {
    let timer: NodeJS.Timeout;
    const done = (): void => {
      sub.dispose();
      clearTimeout(cap);
      resolve();
    };
    const arm = (): void => {
      clearTimeout(timer);
      timer = setTimeout(done, QUIESCE_MS);
    };
    const sub = vscode.languages.onDidChangeDiagnostics((e) => {
      if (e.uris.some((u) => keys.has(u.toString()))) arm();
    });
    const cap = setTimeout(done, capMs);
    arm();
  });
}

export const analyzeCheck: CommitCheck = {
  id: 'analyze',
  label: vscode.l10n.t('Analyze code'),
  configKey: 'analyze',
  advanced: true,
  async run(ctx) {
    // Save so language servers lint what will actually be committed.
    for (const uri of ctx.files) {
      const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
      if (doc?.isDirty) await doc.save();
    }
    ctx.progress(vscode.l10n.t('Waiting for diagnostics…'));
    await quiesce(ctx.files);

    const floor = severityFloor();
    const offenders: Array<{ uri: vscode.Uri; diagnostic: vscode.Diagnostic }> = [];
    for (const uri of ctx.files) {
      for (const d of vscode.languages.getDiagnostics(uri)) {
        if (d.severity <= floor) offenders.push({ uri, diagnostic: d });
      }
    }
    if (offenders.length === 0) return { ok: true };

    const first = offenders[0]!;
    return {
      ok: false,
      blocking: false,
      message:
        offenders.length === 1
          ? vscode.l10n.t(
              '1 problem at or above "{0}" in the files being committed.',
              floor === vscode.DiagnosticSeverity.Warning ? 'warning' : 'error',
            )
          : vscode.l10n.t(
              '{0} problems at or above "{1}" in the files being committed.',
              offenders.length,
              floor === vscode.DiagnosticSeverity.Warning ? 'warning' : 'error',
            ),
      reveal: async () => {
        await vscode.commands.executeCommand('workbench.actions.view.problems');
        const doc = await vscode.window.showTextDocument(first.uri);
        doc.revealRange(first.diagnostic.range, vscode.TextEditorRevealType.InCenter);
        doc.selection = new vscode.Selection(first.diagnostic.range.start, first.diagnostic.range.start);
      },
    };
  },
};
