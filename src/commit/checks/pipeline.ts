/**
 * Pre-commit CheckPipeline (P3-T7): sequential, setting-gated, cancellable;
 * aggregates results into one Review / Commit-Anyway / Cancel decision.
 * Check order (IntelliJ parity): reformat → imports → cleanup → analyze → todo.
 */
import * as vscode from 'vscode';
import { writeSetting } from '../../ui/writeSetting';
import type { RepoHandle } from '../../core/core';
import type { CancelToken } from '../../core/git/executor';

export interface CheckContext {
  repo: RepoHandle;
  files: vscode.Uri[];
  token: CancelToken;
  progress: (message: string) => void;
  /**
   * P11-T5: diff baseline for range-scoped checks. Pre-commit runs leave it
   * unset (= HEAD); the deferred post-commit pass sets the new commit's
   * parent, because after the commit worktree↔HEAD is empty.
   */
  baseRev?: string;
}

export type CheckResult =
  | { ok: true }
  | { ok: false; blocking: boolean; message: string; reveal?: () => Promise<void> };

export interface CommitCheck {
  id: string;
  label: string;
  /** Setting under geet.commit.checks.* gating this check. */
  configKey: string;
  /**
   * P11-T5: an "Advanced Commit Check" (Analyze, TODO). When
   * `geet.commit.checks.deferAdvanced` is on these run *after* the commit
   * and report via notification — IntelliJ's "Failed checks will not prevent
   * a commit". Non-advanced checks (reformat/imports/cleanup) rewrite files,
   * so deferring them would commit the unformatted tree; they always gate.
   */
  advanced?: boolean;
  run(ctx: CheckContext): Promise<CheckResult>;
}

export interface PipelineOutcome {
  /** false → abort the commit (user cancelled or reviewed a failure). */
  proceed: boolean;
  cancelled: boolean;
  failures: Array<{ check: CommitCheck; result: Extract<CheckResult, { ok: false }> }>;
}

export function checksEnabled(configKey: string): boolean {
  return vscode.workspace.getConfiguration('geet.commit.checks').get<boolean>(configKey, false);
}

export class CheckPipeline {
  constructor(private readonly checks: CommitCheck[]) {}

  get all(): CommitCheck[] {
    return [...this.checks];
  }

  async run(ctx: CheckContext, opts: { skipAdvanced?: boolean } = {}): Promise<PipelineOutcome> {
    const failures = await this.collect(
      ctx,
      this.checks.filter((c) => !(opts.skipAdvanced === true && c.advanced === true)),
    );
    if (ctx.token.isCancellationRequested) return { proceed: false, cancelled: true, failures };
    if (failures.length === 0) return { proceed: true, cancelled: false, failures };

    const decision = await presentFailures(failures);
    return { proceed: decision === 'commit-anyway', cancelled: decision === 'cancel', failures };
  }

  /**
   * P11-T5: the post-commit half of deferred mode. Runs only the advanced,
   * setting-enabled checks and *reports* — no modal, no gate, the commit has
   * already happened.
   */
  async runAdvanced(ctx: CheckContext): Promise<PipelineOutcome['failures']> {
    return this.collect(
      ctx,
      this.checks.filter((c) => c.advanced === true),
    );
  }

  private async collect(
    ctx: CheckContext,
    checks: readonly CommitCheck[],
  ): Promise<PipelineOutcome['failures']> {
    const failures: PipelineOutcome['failures'] = [];
    for (const check of checks) {
      if (ctx.token.isCancellationRequested) return failures;
      if (!checksEnabled(check.configKey)) continue;
      ctx.progress(check.label);
      try {
        const result = await check.run(ctx);
        if (!result.ok) failures.push({ check, result });
      } catch (err) {
        failures.push({
          check,
          result: {
            ok: false,
            blocking: false,
            message: vscode.l10n.t('{0} failed: {1}', check.label, err instanceof Error ? err.message : String(err)),
          },
        });
      }
    }
    return failures;
  }
}

type Decision = 'review' | 'commit-anyway' | 'cancel';

async function presentFailures(
  failures: PipelineOutcome['failures'],
): Promise<Decision> {
  const anyBlocking = failures.some((f) => f.result.blocking);
  const detail = failures.map((f) => `• ${f.check.label}: ${f.result.message}`).join('\n');
  const review = vscode.l10n.t('Review…');
  const anyway = vscode.l10n.t('Commit Anyway');

  const testChoice = process.env['GEET_TEST_CHECKS_CHOICE'];
  let picked: string | undefined;
  if (testChoice === 'review') picked = review;
  else if (testChoice === 'anyway') picked = anyway;
  else if (testChoice === 'cancel') picked = undefined;
  else {
    picked = await vscode.window.showWarningMessage(
      vscode.l10n.t('Pre-commit checks found problems ({0}).', failures.length),
      { modal: true, detail },
      review,
      ...(anyBlocking ? [] : [anyway]),
    );
  }

  if (picked === review) {
    const first = failures.find((f) => f.result.reveal !== undefined);
    await first?.result.reveal?.();
    return 'review';
  }
  if (picked === anyway && !anyBlocking) return 'commit-anyway';
  return 'cancel';
}

/** Gear UI (P3-T7 step 7): multi-select QuickPick persisted to settings. */
export async function configureChecks(pipeline: CheckPipeline): Promise<void> {
  const config = vscode.workspace.getConfiguration('geet.commit.checks');
  const items = pipeline.all.map((check) => ({
    label: check.label,
    check,
    picked: config.get<boolean>(check.configKey, false),
  }));
  const picked = await vscode.window.showQuickPick(items, {
    canPickMany: true,
    placeHolder: vscode.l10n.t('Pre-commit checks to run'),
  });
  if (picked === undefined) return;
  const enabled = new Set(picked.map((p) => p.check.id));
  for (const check of pipeline.all) {
    await writeSetting('geet.commit.checks', check.configKey, enabled.has(check.id));
  }
}
