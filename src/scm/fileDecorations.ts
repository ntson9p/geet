/**
 * Explorer file decorations (P1-T6): IntelliJ-style colored filenames +
 * letter badges, propagated to parent folders. Registered only while
 * `gittree.decorations.fileExplorer` is on, which it is not by default
 * (POST-P14bz): the built-in Git extension draws its own, and VS Code shows
 * both everywhere, its own Source Control view included.
 */
import * as vscode from 'vscode';
import type { Core } from '../core/core';
import { shortCode, type StatusEntry } from '../core/model/statusEntry';
import { repoRelative } from '../core/util/paths';
import { EXPLORER_DECORATIONS_DEFAULT } from './fileDecorationsDefault';

function decorationFor(entry: StatusEntry): vscode.FileDecoration {
  let badge: string;
  let color: string;
  switch (entry.kind) {
    case 'untracked':
      badge = 'U';
      color = 'gittree.color.untracked';
      break;
    case 'ignored':
      badge = '!';
      color = 'gittree.color.ignored';
      break;
    case 'unmerged':
      badge = '!';
      color = 'gittree.color.conflicted';
      break;
    case 'renamed':
    case 'copied':
      badge = 'R';
      color = 'gittree.color.renamed';
      break;
    case 'ordinary': {
      const code = entry.x !== '.' ? entry.x : entry.y;
      if (code === 'A') {
        badge = 'A';
        color = 'gittree.color.added';
      } else if (code === 'D') {
        badge = 'D';
        color = 'gittree.color.deleted';
      } else {
        badge = 'M';
        color = 'gittree.color.modified';
      }
    }
  }
  const deco = new vscode.FileDecoration(badge, shortCode(entry), new vscode.ThemeColor(color));
  deco.propagate = entry.kind !== 'ignored';
  return deco;
}

export class GeetFileDecorationProvider implements vscode.FileDecorationProvider {
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

/**
 * P14-T6: registered only while `gittree.decorations.fileExplorer` is on. The
 * old gate was the takeover/companion mode — Geet skipped explorer
 * decorations in companion mode so it would not double up with the built-in
 * git extension's. That is now a plain user setting: Geet does not change
 * its own behaviour based on what another extension is doing (D22).
 *
 * POST-P14bz: off by default. A decoration is VS Code's, not a view's: no API
 * keeps it out of VS Code's own Source Control view, its Explorer or its tabs,
 * and VS Code joins two providers' badges for one file (`U, U`). With the
 * built-in Git extension running, as it does by default, Geet's badges were
 * a second copy of its own in every one of them. Off, Geet adds nothing to
 * VS Code's views; someone who disables the built-in extension turns it on.
 */
export function wireFileDecorations(context: vscode.ExtensionContext, core: Core): void {
  let registration: vscode.Disposable | undefined;
  let provider: GeetFileDecorationProvider | undefined;

  const apply = (): void => {
    const wantOn = vscode.workspace
      .getConfiguration('gittree')
      .get<boolean>('decorations.fileExplorer', EXPLORER_DECORATIONS_DEFAULT);
    if (wantOn && !registration) {
      provider = new GeetFileDecorationProvider(core);
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
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('gittree.decorations.fileExplorer')) apply();
    }),
    new vscode.Disposable(() => {
      registration?.dispose();
    }),
  );
}
