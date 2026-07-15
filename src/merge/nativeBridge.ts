/**
 * P6-T6 — optional native merge editor path (`gittree.merge.ui: 'native'`).
 *
 * WHY THE PARANOIA (master risk register): `_open.mergeEditor` is an
 * INTERNAL VS Code command — it is not part of the stable API surface, has
 * no compatibility guarantee, and may vanish or change its payload shape in
 * any release. This bridge therefore (1) probes command existence through
 * `getCommands()` before every open, (2) wraps the invocation in try/catch,
 * and (3) reports failure to the caller, which falls back to the T3
 * tri-editor silently — a per-session flag records the fallback for the
 * trace log only. The tri-editor remains the default and the only path the
 * extension depends on.
 *
 * Inputs ride on `gittree-rev:` index-stage URIs (:1 base, :2 ours,
 * :3 theirs); the output is the real worktree file. Saving the output
 * (the native editor's "Complete Merge") makes the file stageable — the
 * bridge watches that save and stages it via the session, which is what
 * marks the file resolved.
 */
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { RepoHandle } from '../core/core';
import { makeRevUri } from '../core/vdocs/revContentProvider';
import type { ConflictSession } from './conflictSession';

export type MergeUi = 'triEditor' | 'native';

export function mergeUiSetting(): MergeUi {
  return vscode.workspace
    .getConfiguration('gittree.merge')
    .get<MergeUi>('ui', 'triEditor');
}

const NATIVE_COMMAND = '_open.mergeEditor';

interface PendingResolve {
  session: ConflictSession;
  rel: string;
}

export class NativeMergeBridge implements vscode.Disposable {
  /** Output uri → the session/file a save should mark resolved. */
  private readonly pending = new Map<string, PendingResolve>();
  private readonly saveSub: vscode.Disposable;

  constructor(private readonly trace: (line: string) => void) {
    this.saveSub = vscode.workspace.onDidSaveTextDocument((doc) => {
      const entry = this.pending.get(doc.uri.toString());
      if (!entry) return;
      this.pending.delete(doc.uri.toString());
      this.trace(`native merge output saved — staging ${entry.rel}`);
      void entry.session.markResolved(entry.rel);
    });
  }

  /**
   * Try the native editor. Returns false (never throws) when the internal
   * command is missing or rejects — the caller then uses the tri-editor.
   */
  async open(repo: RepoHandle, rel: string, session: ConflictSession): Promise<boolean> {
    // Test seam: simulate the command being removed from the product.
    if (process.env['GITTREE_TEST_NATIVE_UNAVAILABLE'] === '1') {
      this.trace(`native merge probe: ${NATIVE_COMMAND} unavailable (test seam)`);
      return false;
    }
    // getCommands(false) — internal (underscore) commands must be included.
    const commands = await vscode.commands.getCommands(false);
    if (!commands.includes(NATIVE_COMMAND)) {
      this.trace(`native merge probe: ${NATIVE_COMMAND} not present in this build`);
      return false;
    }
    const output = vscode.Uri.file(path.join(repo.root, rel));
    const base = path.posix.basename(rel.replace(/\\/g, '/'));
    try {
      await vscode.commands.executeCommand(NATIVE_COMMAND, {
        base: makeRevUri(repo.root, rel, ':1'),
        input1: {
          uri: makeRevUri(repo.root, rel, ':2'),
          title: vscode.l10n.t('Yours ({0})', base),
        },
        input2: {
          uri: makeRevUri(repo.root, rel, ':3'),
          title: vscode.l10n.t('Theirs ({0})', base),
        },
        output,
      });
    } catch (err) {
      this.trace(`native merge open failed for ${rel}: ${String(err)}`);
      return false;
    }
    this.pending.set(output.toString(), { session, rel });
    return true;
  }

  dispose(): void {
    this.saveSub.dispose();
    this.pending.clear();
  }
}
