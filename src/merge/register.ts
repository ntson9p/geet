/**
 * Phase 6 registration (T1 slice — conflict sessions + Conflicts view;
 * T2..T7 extend this file with the merge computation, tri-editor, chevrons,
 * magic wand, native bridge and lifecycle routing).
 */
import * as vscode from 'vscode';
import { filesCount } from '../ui/counts';
import type { Core, RepoHandle } from '../core/core';
import { MERGE_SCHEME, MergeFsProvider } from '../core/vdocs/mergeFs';
import { confirmModal } from '../ui/confirm';
import { isSpecialConflict, type ConflictSession } from './conflictSession';
import { ConflictsViewProvider, type ConflictNode } from './conflictsView';
import { MergeLifecycle } from './lifecycle';
import { MergeComputer, serializeResult, type MergeExec } from './mergeCompute';
import { registerResolutionActions, wandOptions } from './resolutionActions';
import { resolveAllBlocks } from './resolver/autoResolver';
import { TriEditorManager } from './triEditor';
import { showInfo } from '../ui/notices';

export function registerPhase06MergeEngine(context: vscode.ExtensionContext, core: Core): void {
  const viewProvider = new ConflictsViewProvider();
  const mergeFs = new MergeFsProvider();
  context.subscriptions.push(
    vscode.workspace.registerFileSystemProvider(MERGE_SCHEME, mergeFs, { isCaseSensitive: true }),
    mergeFs,
  );
  const triEditors = new TriEditorManager(mergeFs);
  context.subscriptions.push(triEditors);
  registerResolutionActions(context, triEditors);
  const trace = (l: string): void => core.output.appendLine(`[merge] ${l}`);
  const view = vscode.window.createTreeView('geet.conflicts', {
    treeDataProvider: viewProvider,
  });
  context.subscriptions.push(view);

  // T7: session creation, lane holds, producer hints and completion CTAs
  // live in the lifecycle; this file keeps the view + command surfaces.
  const lifecycle = new MergeLifecycle(core, trace);
  context.subscriptions.push(lifecycle);
  const pushSessions = (): void => {
    const all = lifecycle.all();
    viewProvider.setSessions(all);
    const any = all.some((s) => s.remaining > 0);
    const canContinue = all.some((s) => s.remaining === 0);
    void vscode.commands.executeCommand('setContext', 'geet.hasConflicts', any || all.length > 0);
    void vscode.commands.executeCommand('setContext', 'geet.conflicts.canContinue', canContinue);
  };
  context.subscriptions.push(lifecycle.onDidChangeSessions(() => pushSessions()));
  pushSessions();

  // ---- commands -------------------------------------------------------------
  const register = (id: string, fn: (...args: unknown[]) => Promise<void> | void): void => {
    context.subscriptions.push(vscode.commands.registerCommand(id, fn));
  };
  const sessionFor = (arg?: unknown): ConflictSession | undefined => {
    if (typeof arg === 'string') return lifecycle.get(arg);
    if (typeof arg === 'object' && arg !== null && 'session' in arg) {
      return (arg as ConflictNode).session;
    }
    return lifecycle.all()[0];
  };

  /** Delete/mode conflicts: tailored QuickPick instead of the tri-editor. */
  const resolveSpecial = async (node: ConflictNode): Promise<void> => {
    interface Choice extends vscode.QuickPickItem {
      keep: 'deleted' | 'file';
      side?: 'ours' | 'theirs';
    }
    const choices: Choice[] = [];
    if (node.kind === 'deleted-by-us') {
      choices.push(
        { label: vscode.l10n.t('$(trash) Keep deleted (your side)'), keep: 'deleted' },
        { label: vscode.l10n.t('$(file) Keep their file'), keep: 'file', side: 'theirs' },
      );
    } else if (node.kind === 'deleted-by-them') {
      choices.push(
        { label: vscode.l10n.t('$(file) Keep your file'), keep: 'file', side: 'ours' },
        { label: vscode.l10n.t('$(trash) Keep deleted (their side)'), keep: 'deleted' },
      );
    } else if (node.kind === 'both-deleted') {
      choices.push({ label: vscode.l10n.t('$(trash) Confirm deletion'), keep: 'deleted' });
    } else {
      choices.push(
        { label: vscode.l10n.t('$(arrow-left) Keep yours (mode/content)'), keep: 'file', side: 'ours' },
        { label: vscode.l10n.t('$(arrow-right) Keep theirs (mode/content)'), keep: 'file', side: 'theirs' },
      );
    }
    const seeded = process.env['GEET_TEST_SPECIAL_CHOICE'];
    const picked =
      seeded !== undefined
        ? choices[Number.parseInt(seeded, 10)]
        : await vscode.window.showQuickPick(choices, {
            placeHolder: vscode.l10n.t('Resolve {0}', node.path),
          });
    if (picked) await node.session.resolveSpecial(node.path, picked.keep, picked.side);
  };

  /** Queue-routed read seam for the merge computer (P6-T2). */
  const mergeExecFor = (repo: RepoHandle): MergeExec => (args) =>
    repo.queue.enqueue({
      label: 'merge compute read',
      kind: 'read',
      run: (git, token) =>
        git.exec(repo.root, args, {
          structured: true,
          noOptionalLocks: true,
          allowNonZeroExit: true,
          token,
        }),
    });

  /** Binary / oversized conflicts: whole-file side pick instead of an editor. */
  const resolveBinary = async (node: ConflictNode, why: 'binary' | 'too-large'): Promise<void> => {
    interface Choice extends vscode.QuickPickItem {
      side: 'ours' | 'theirs';
    }
    const choices: Choice[] = [
      { label: vscode.l10n.t('$(arrow-left) Keep your version'), side: 'ours' },
      { label: vscode.l10n.t('$(arrow-right) Keep their version'), side: 'theirs' },
    ];
    const seeded = process.env['GEET_TEST_SPECIAL_CHOICE'];
    const picked =
      seeded !== undefined
        ? choices[Number.parseInt(seeded, 10)]
        : await vscode.window.showQuickPick(choices, {
            placeHolder:
              why === 'binary'
                ? vscode.l10n.t('{0} is binary — pick the version to keep', node.path)
                : vscode.l10n.t('{0} is too large to merge in the editor — pick a version', node.path),
          });
    if (picked) await node.session.acceptSide([node.path], picked.side);
  };

  register('geet.merge.open', async (arg) => {
    const node = arg as ConflictNode | undefined;
    if (!node || !('path' in node)) return;
    if (isSpecialConflict(node.kind)) {
      await resolveSpecial(node);
      return;
    }
    const computer = new MergeComputer(mergeExecFor(node.session.repo));
    const input = await computer.compute(node.path, { reversed: node.session.reversed });
    if (input.kind === 'binary' || input.kind === 'too-large') {
      await resolveBinary(node, input.kind);
      return;
    }
    // P14-T5 removed the optional `_open.mergeEditor` bridge: an internal,
    // underscore-prefixed VS Code command was the single least stable API this
    // extension touched, and the tri-editor it fell back to has been the
    // default throughout.
    await triEditors.openEditor(node.session.repo, node.path, node.session, input.merge);
  });
  register('geet.merge.apply', async () => {
    await triEditors.active()?.apply();
  });
  register('geet.merge.nextConflict', () => {
    triEditors.active()?.jumpToConflict(1);
  });
  register('geet.merge.prevConflict', () => {
    triEditors.active()?.jumpToConflict(-1);
  });
  register('geet.merge.toggleSyncScroll', () => {
    triEditors.active()?.toggleSyncScroll();
  });
  register('geet.merge.acceptYoursFile', async (arg) => {
    const node = arg as ConflictNode | undefined;
    if (!node || !('path' in node)) return;
    if (isSpecialConflict(node.kind)) return resolveSpecial(node);
    await node.session.acceptSide([node.path], 'ours');
  });
  register('geet.merge.acceptTheirsFile', async (arg) => {
    const node = arg as ConflictNode | undefined;
    if (!node || !('path' in node)) return;
    if (isSpecialConflict(node.kind)) return resolveSpecial(node);
    await node.session.acceptSide([node.path], 'theirs');
  });
  register('geet.merge.acceptAllYours', async (arg) => {
    const session = sessionFor(arg);
    if (!session) return;
    const paths = session.files().filter((f) => !isSpecialConflict(f.kind)).map((f) => f.path);
    const ok = await confirmModal(
      vscode.l10n.t('Accept YOUR version for {0}?', filesCount(paths.length)),
      vscode.l10n.t('Their changes to these files are discarded (Local History keeps a snapshot).'),
      vscode.l10n.t('Accept All Yours'),
    );
    if (ok) await session.acceptSide(paths, 'ours');
  });
  register('geet.merge.acceptAllTheirs', async (arg) => {
    const session = sessionFor(arg);
    if (!session) return;
    const paths = session.files().filter((f) => !isSpecialConflict(f.kind)).map((f) => f.path);
    const ok = await confirmModal(
      vscode.l10n.t('Accept THEIR version for {0}?', filesCount(paths.length)),
      vscode.l10n.t('Your changes to these files are discarded (Local History keeps a snapshot).'),
      vscode.l10n.t('Accept All Theirs'),
    );
    if (ok) await session.acceptSide(paths, 'theirs');
  });
  /**
   * Session-wide Magic Wand (Conflicts-view title): auto-resolve every text
   * conflict whose blocks ALL fall to the cascade; partially resolvable
   * files stay untouched for the tri-editor.
   */
  register('geet.merge.magicWandSession', async (arg) => {
    const session = sessionFor(arg);
    if (!session) return;
    const computer = new MergeComputer(mergeExecFor(session.repo));
    const opts = wandOptions();
    let filesResolved = 0;
    let blocksResolved = 0;
    let blocksTotal = 0;
    for (const file of session.files()) {
      if (isSpecialConflict(file.kind)) continue;
      const input = await computer.compute(file.path, { reversed: session.reversed });
      if (input.kind !== 'text') continue;
      const blocks = input.merge.blocks;
      blocksTotal += blocks.length;
      const resolved = resolveAllBlocks(blocks, opts, (block, lines) => {
        block.resolution = 'auto';
        block.resolvedLines = lines;
      });
      if (resolved === blocks.length && blocks.length > 0) {
        const text = serializeResult(input.merge.segments);
        await vscode.workspace.fs.writeFile(
          vscode.Uri.joinPath(vscode.Uri.file(session.repo.root), file.path),
          new TextEncoder().encode(text),
        );
        await session.markResolved(file.path);
        filesResolved++;
        blocksResolved += resolved;
      }
    }
    showInfo(
      blocksTotal === 1
        ? vscode.l10n.t(
            'Resolved {0} of 1 conflict automatically ({1} completed).',
            blocksResolved,
            filesCount(filesResolved),
          )
        : vscode.l10n.t(
            'Resolved {0} of {1} conflicts automatically ({2} completed).',
            blocksResolved,
            blocksTotal,
            filesCount(filesResolved),
          ),
    );
  });

  register('geet.merge.continueOp', async (arg) => {
    await sessionFor(arg)?.continueOp();
  });
  register('geet.merge.abortOp', async (arg) => {
    await sessionFor(arg)?.abortOp();
  });

  core.debugRegistry.set('phase06', {
    getSession: (repoRoot: string) => lifecycle.get(repoRoot),
    viewProvider,
    triEditors,
    lifecycle,
  });
}
