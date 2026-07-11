/**
 * Explorer file decorations (P1-T6): IntelliJ-style colored filenames +
 * letter badges, propagated to parent folders. Registered only in takeover
 * mode — the built-in git extension owns explorer decorations in companion
 * mode (§3).
 */
import * as vscode from 'vscode';
import type { Core } from '../core/core';
import { shortCode, type StatusEntry } from '../core/model/statusEntry';
import { repoRelative } from '../core/util/paths';

function decorationFor(entry: StatusEntry): vscode.FileDecoration {
  let badge: string;
  let color: string;
  switch (entry.kind) {
    case 'untracked':
      badge = 'U';
      color = 'gitDecoration.untrackedResourceForeground';
      break;
    case 'ignored':
      badge = '!';
      color = 'gitDecoration.ignoredResourceForeground';
      break;
    case 'unmerged':
      badge = '!';
      color = 'gitDecoration.conflictingResourceForeground';
      break;
    case 'renamed':
    case 'copied':
      badge = 'R';
      color = 'gitDecoration.renamedResourceForeground';
      break;
    case 'ordinary': {
      const code = entry.x !== '.' ? entry.x : entry.y;
      if (code === 'A') {
        badge = 'A';
        color = 'gitDecoration.addedResourceForeground';
      } else if (code === 'D') {
        badge = 'D';
        color = 'gitDecoration.deletedResourceForeground';
      } else {
        badge = 'M';
        color = 'gitDecoration.modifiedResourceForeground';
      }
    }
  }
  const deco = new vscode.FileDecoration(badge, shortCode(entry), new vscode.ThemeColor(color));
  deco.propagate = entry.kind !== 'ignored';
  return deco;
}

export class GitTreeFileDecorationProvider implements vscode.FileDecorationProvider {
  private readonly _onDidChange = new vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined>();
  readonly onDidChangeFileDecorations = this._onDidChange.event;
  private readonly subs: Array<{ dispose(): void }> = [];

  constructor(private readonly core: Core) {
    for (const repo of core.repos) this.watch(repo.root, repo.model.onDidChange.bind(repo.model));
    this.subs.push(
      core.onDidAddRepo((repo) => this.watch(repo.root, repo.model.onDidChange.bind(repo.model))),
    );
  }

  private watch(
    _root: string,
    onDidChange: (l: (s: ReadonlySet<string>) => void) => { dispose(): void },
  ): void {
    this.subs.push(
      onDidChange((sections) => {
        if (sections.has('status')) this._onDidChange.fire(undefined); // refresh all
      }),
    );
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (uri.scheme !== 'file') return undefined;
    const repo = this.core.repoForUri(uri);
    if (!repo) return undefined;
    const rel = repoRelative(repo.root, uri.fsPath);
    if (rel === undefined) return undefined;
    const entry = repo.model.snapshot.statusEntries.find(
      (e) => e.path === rel || e.origPath === rel,
    );
    return entry ? decorationFor(entry) : undefined;
  }

  dispose(): void {
    for (const s of this.subs) s.dispose();
    this._onDidChange.dispose();
  }
}

/** Registers in takeover mode; toggling the mode adds/removes live. */
export function wireFileDecorations(context: vscode.ExtensionContext, core: Core): void {
  let registration: vscode.Disposable | undefined;
  let provider: GitTreeFileDecorationProvider | undefined;

  const apply = (): void => {
    const wantOn = core.mode.effectiveMode === 'takeover';
    if (wantOn && !registration) {
      provider = new GitTreeFileDecorationProvider(core);
      registration = vscode.Disposable.from(
        vscode.window.registerFileDecorationProvider(provider),
        provider,
      );
    } else if (!wantOn && registration) {
      registration.dispose();
      registration = undefined;
      provider = undefined;
    }
  };

  apply();
  const modeSub = core.mode.onDidChangeMode(() => apply());
  context.subscriptions.push(
    new vscode.Disposable(() => {
      modeSub.dispose();
      registration?.dispose();
    }),
  );
}
