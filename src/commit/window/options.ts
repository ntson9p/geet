/**
 * Commit options behind the gear popup (P11-T5): the per-repo author override,
 * sign-off, check toggles and the deferred-advanced-checks mode.
 *
 * The author override is per-repo `workspaceState` (plan step 2) — the phase
 * doc's contributions list also names a `gittree.commit.author` *setting*, but
 * a setting cannot be per-repository in a multi-root workspace, so the step
 * wins; recorded as a deviation.
 */
import * as vscode from 'vscode';
import type { Core, RepoHandle } from '../../core/core';
import { CancellationSource } from '../../core/util/cancellation';
import { canonicalKey } from '../../core/repoDiscovery';
import {
  isValidAuthor,
  type CommitOptionChangeDto,
  type CommitOptionsDto,
} from '../../shared/protocol';
import { CHECK_DEFAULTS } from '../checks/checkDefaults';
import type { CheckPipeline } from '../checks/pipeline';

const AUTHOR_KEY_PREFIX = 'gittree.commit.author.';

function config(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration('gittree.commit');
}

export class CommitOptionsStore {
  constructor(private readonly workspaceState: vscode.Memento) {}

  getAuthor(repo: RepoHandle): string | undefined {
    const value = this.workspaceState.get<string>(`${AUTHOR_KEY_PREFIX}${canonicalKey(repo.root)}`);
    return value !== undefined && value.length > 0 ? value : undefined;
  }

  async setAuthor(repo: RepoHandle, value: string | undefined): Promise<void> {
    await this.workspaceState.update(
      `${AUTHOR_KEY_PREFIX}${canonicalKey(repo.root)}`,
      value !== undefined && value.length > 0 ? value : undefined,
    );
  }

  isSignoffEnabled(): boolean {
    return config().get<boolean>('signoff', false);
  }

  isDeferAdvancedEnabled(): boolean {
    return config().get<boolean>('checks.deferAdvanced', true);
  }
}

/** Deduped `Name <email>` completion list from recent history (plan step 2). */
export async function authorSuggestions(repo: RepoHandle, limit = 200): Promise<string[]> {
  const result = await repo.queue.enqueue({
    label: 'read author suggestions',
    kind: 'read',
    run: (git, token) =>
      git.exec(repo.root, ['log', `-${limit}`, '--format=%an <%ae>'], {
        structured: true,
        noOptionalLocks: true,
        allowNonZeroExit: true, // unborn HEAD → no suggestions
        token,
      }),
  });
  if (result.exitCode !== 0) return [];
  const seen = new Set<string>();
  const authors: string[] = [];
  for (const line of result.stdout.split('\n')) {
    const author = line.trim();
    if (author.length === 0 || seen.has(author)) continue;
    seen.add(author);
    authors.push(author);
  }
  return authors;
}

export async function readOptions(
  store: CommitOptionsStore,
  repo: RepoHandle,
): Promise<CommitOptionsDto> {
  const checks = vscode.workspace.getConfiguration('gittree.commit.checks');
  return {
    repoRoot: repo.root,
    author: store.getAuthor(repo) ?? '',
    authorSuggestions: await authorSuggestions(repo),
    signoff: store.isSignoffEnabled(),
    checks: {
      reformat: checks.get<boolean>('reformat', CHECK_DEFAULTS.reformat),
      optimizeImports: checks.get<boolean>('optimizeImports', CHECK_DEFAULTS.optimizeImports),
      cleanup: checks.get<boolean>('cleanup', CHECK_DEFAULTS.cleanup),
      analyze: checks.get<boolean>('analyze', CHECK_DEFAULTS.analyze),
      todo: checks.get<boolean>('todo', CHECK_DEFAULTS.todo),
    },
    analyzeSeverity: checks.get<string>('analyzeSeverity', 'error') === 'warning' ? 'warning' : 'error',
    todoPattern: checks.get<string>('todoPattern', '\\b(TODO|FIXME)\\b'),
    cleanupKind: checks.get<string>('cleanupKind', 'source.fixAll'),
    deferAdvanced: store.isDeferAdvancedEnabled(),
  };
}

/**
 * Applies one gear-popup change. Settings go to the Workspace target (the
 * P3-T7 QuickPick precedent); the author goes to per-repo workspaceState.
 * Throws on an invalid author so the RPC layer surfaces it to the popup.
 */
export async function applyOption(
  store: CommitOptionsStore,
  repo: RepoHandle,
  change: CommitOptionChangeDto,
): Promise<void> {
  const checks = vscode.workspace.getConfiguration('gittree.commit.checks');
  const target = vscode.ConfigurationTarget.Workspace;
  switch (change.kind) {
    case 'author': {
      const value = change.value.trim();
      if (value.length > 0 && !isValidAuthor(value)) {
        throw new Error(vscode.l10n.t('Author must look like: Name <email@example.com>'));
      }
      await store.setAuthor(repo, value.length > 0 ? value : undefined);
      return;
    }
    case 'signoff':
      await config().update('signoff', change.value, target);
      return;
    case 'check':
      await checks.update(change.id, change.value, target);
      return;
    case 'analyzeSeverity':
      await checks.update('analyzeSeverity', change.value, target);
      return;
    case 'todoPattern':
      await checks.update('todoPattern', change.value, target);
      return;
    case 'cleanupKind':
      await checks.update('cleanupKind', change.value, target);
      return;
    case 'deferAdvanced':
      await checks.update('deferAdvanced', change.value, target);
      return;
  }
}

export interface DeferredChecksOutcome {
  /** HEAD when the checks ran — proof the commit landed first. */
  headSha: string;
  failures: Array<{ label: string; message: string }>;
}

/**
 * The post-commit half of deferred mode (plan step 4): run Analyze/TODO after
 * the commit and report via a non-modal notification. "Failed checks will not
 * prevent a commit" — there is nothing left to prevent.
 *
 * Skipped under the integration harness unless a test opts in — Analyze waits
 * for diagnostics to quiesce for seconds, and firing that after every one of a
 * hundred test commits would be pure drag on a shared window.
 */
export async function runDeferredChecks(
  pipeline: CheckPipeline,
  core: Core,
  repo: RepoHandle,
  files: vscode.Uri[],
): Promise<DeferredChecksOutcome | undefined> {
  if (process.env['GITTREE_TEST'] === '1' && process.env['GITTREE_TEST_DEFERRED_CHECKS'] !== '1') {
    return undefined;
  }
  const head = await repo.queue.enqueue({
    label: 'read HEAD for deferred checks',
    kind: 'read',
    run: (git, token) =>
      git.exec(repo.root, ['rev-parse', 'HEAD'], {
        structured: true,
        noOptionalLocks: true,
        allowNonZeroExit: true,
        token,
      }),
  });
  const source = new CancellationSource();
  try {
    const sha = head.exitCode === 0 ? head.stdout.trim() : '';
    const failures = await pipeline.runAdvanced({
      repo,
      files,
      token: source.token,
      progress: () => {},
      // The commit landed; what there is to scan is what it introduced. A root
      // commit has no parent — `sha^` then reads as absent, i.e. all-added.
      ...(sha.length > 0 ? { baseRev: `${sha}^` } : {}),
    });
    const outcome: DeferredChecksOutcome = {
      headSha: head.exitCode === 0 ? head.stdout.trim() : '',
      failures: failures.map((f) => ({ label: f.check.label, message: f.result.message })),
    };
    if (failures.length > 0) {
      const review = vscode.l10n.t('Review…');
      void vscode.window
        .showWarningMessage(
          vscode.l10n.t('Post-commit checks found problems ({0}).', failures.length),
          review,
        )
        .then(async (picked) => {
          if (picked === review) {
            const first = failures.find((f) => f.result.reveal !== undefined);
            await first?.result.reveal?.();
          }
        });
      core.output.appendLine(
        `[deferred-checks] ${failures.length} finding(s) after commit: ${failures
          .map((f) => f.check.label)
          .join(', ')}`,
      );
    }
    return outcome;
  } finally {
    source.dispose();
  }
}
