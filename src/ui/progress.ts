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
