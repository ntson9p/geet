/**
 * Progress adapter (master P0-T5 step 4): mutations run under the SCM
 * progress location; if still running after 2 s the same operation also
 * surfaces as a cancellable notification whose Cancel flows into the
 * operation's token.
 */
import * as vscode from 'vscode';
import type { CancelToken, RepoId } from '../core/git/executor';
import type { ProgressAdapter } from '../core/ops/operationQueue';
import { CancellationSource } from '../core/util/cancellation';

const ESCALATE_AFTER_MS = 2000;

export function vscodeProgressAdapter(): ProgressAdapter {
  return async <T>(
    info: { label: string; repo: RepoId },
    run: (token: CancelToken) => Promise<T>,
  ): Promise<T> => {
    const source = new CancellationSource();
    let settled = false;
    const promise = run(source.token).finally(() => {
      settled = true;
    });
    // Swallowed copy for the progress UIs (errors surface to the enqueue caller).
    const uiPromise = promise.then(
      () => undefined,
      () => undefined,
    );

    // P14-T4: `ProgressLocation.SourceControl` renders inside VS Code's Source
    // Control view, which GitTree no longer contributes a provider to — the
    // spinner would have nowhere to appear. `Window` puts it in the status bar,
    // beside GitTree's own branch and sync items.
    void vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: info.label },
      () => uiPromise,
    );

    const timer = setTimeout(() => {
      if (settled) return;
      void vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: info.label,
          cancellable: true,
        },
        (_progress, token) => {
          const sub = token.onCancellationRequested(() => source.cancel());
          return uiPromise.finally(() => {
            sub.dispose();
          });
        },
      );
    }, ESCALATE_AFTER_MS);

    try {
      return await promise;
    } finally {
      clearTimeout(timer);
      source.dispose();
    }
  };
}

/** The progress of an operation made of several queued steps. */
export interface OperationProgress {
  /** Cancelled from the notification's Cancel; link it into each step. */
  readonly token: CancelToken;
  /** What it is doing now — `Fetching…`, `Merging origin/main…`. */
  report(message: string): void;
  /** Takes the progress down. */
  done(): void;
}

/**
 * One progress for an operation made of several queued steps — an update's
 * fetch and then its merge or rebase. Each step, queued on its own, would get
 * its own spinner and, past two seconds, its own notification: the
 * notification closed between the steps and opened again. The steps run
 * `quietProgress` under this one instead, which looks exactly as a single
 * step does: the status-bar spinner at once, the cancellable notification if
 * it is still going after two seconds.
 */
export function beginOperationProgress(title: string): OperationProgress {
  const source = new CancellationSource();
  let message: string | undefined;
  const reporters: Array<(m: string) => void> = [];
  let finish: () => void = () => undefined;
  const finished = new Promise<void>((resolve) => {
    finish = resolve;
  });

  void vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title }, (progress) => {
    reporters.push((m) => progress.report({ message: m }));
    if (message !== undefined) progress.report({ message });
    return finished;
  });
  const timer = setTimeout(() => {
    void vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title, cancellable: true },
      (progress, token) => {
        const sub = token.onCancellationRequested(() => source.cancel());
        reporters.push((m) => progress.report({ message: m }));
        if (message !== undefined) progress.report({ message });
        return finished.finally(() => {
          sub.dispose();
        });
      },
    );
  }, ESCALATE_AFTER_MS);

  let ended = false;
  return {
    token: source.token,
    report: (m) => {
      message = m;
      for (const report of reporters) report(m);
    },
    done: () => {
      if (ended) return;
      ended = true;
      clearTimeout(timer);
      finish();
      source.dispose();
    },
  };
}
