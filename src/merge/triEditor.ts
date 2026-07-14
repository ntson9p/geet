/**
 * P6-T3 — Tri-Editor composition: three REAL VS Code editors (master
 * architecture decision) — Left "Yours" (:2, read-only), Center "Result"
 * (writable `gittree-merge:` doc, full language features), Right "Theirs"
 * (:3, read-only). Block ranges in the result are the anchor source of
 * truth, maintained by mapping text-change deltas (the stable API cannot
 * read adjusted decoration ranges back — decorations render state only).
 */
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { RepoHandle } from '../core/core';
import { makeMergeUri, MERGE_SCHEME, type MergeFsProvider } from '../core/vdocs/mergeFs';
import { makeRevUri, REV_SCHEME } from '../core/vdocs/revContentProvider';
import type { ConflictSession } from './conflictSession';
import { splitKeepEol, type ConflictBlock, type MergeComputation } from './mergeCompute';

export type BlockSide = 'ours' | 'theirs' | 'both';

interface TrackedBlock {
  block: ConflictBlock;
  /** Live whole-line region [startLine, endLine) in the result document. */
  startLine: number;
  endLine: number;
  /** Static line starts inside the immutable side documents. */
  leftStart: number;
  rightStart: number;
}

/** Bake the pane role into the tab title while keeping the extension last. */
function labeledRel(rel: string, label: string): string {
  const ext = path.posix.extname(rel);
  const stem = rel.slice(0, rel.length - ext.length);
  return `${stem} (${label})${ext}`;
}

const SCROLL_GUARD_MS = 80;

export class TriMergeEditor {
  readonly blocks: TrackedBlock[] = [];
  private readonly disposables: vscode.Disposable[] = [];
  private savedLayout: unknown;
  private centerUri!: vscode.Uri;
  private leftUri!: vscode.Uri;
  private rightUri!: vscode.Uri;
  private centerDoc!: vscode.TextDocument;
  private selfEdit = false;
  private scrollGuard = new Map<string, number>();
  private syncScroll = true;
  private closed = false;
  private readonly _onDidClose = new vscode.EventEmitter<void>();
  readonly onDidClose = this._onDidClose.event;
  private readonly _onDidChangeState = new vscode.EventEmitter<void>();
  readonly onDidChangeState = this._onDidChangeState.event;

  private constructor(
    readonly repo: RepoHandle,
    readonly rel: string,
    readonly session: ConflictSession,
    private readonly merge: MergeComputation,
    private readonly deps: TriEditorDeps,
  ) {
    let left = 0;
    let right = 0;
    for (const seg of merge.segments) {
      if (seg.kind === 'common') {
        left += seg.lines.length;
        right += seg.lines.length;
        continue;
      }
      const range = merge.initialRanges.find((r) => r.blockId === seg.block.id);
      this.blocks.push({
        block: seg.block,
        startLine: range?.startLine ?? 0,
        endLine: range?.endLine ?? 0,
        leftStart: left,
        rightStart: right,
      });
      left += seg.block.ours.length;
      right += seg.block.theirs.length;
    }
  }

  get resolvedCount(): number {
    return this.blocks.filter((b) => b.block.resolution !== undefined).length;
  }

  get unresolvedCount(): number {
    return this.blocks.length - this.resolvedCount;
  }

  static async open(
    repo: RepoHandle,
    rel: string,
    session: ConflictSession,
    merge: MergeComputation,
    deps: TriEditorDeps,
  ): Promise<TriMergeEditor> {
    const editor = new TriMergeEditor(repo, rel, session, merge, deps);
    await editor.openPanes();
    return editor;
  }

  private async openPanes(): Promise<void> {
    this.savedLayout = await vscode.commands.executeCommand('vscode.getEditorLayout');
    await vscode.commands.executeCommand('vscode.setEditorLayout', {
      orientation: 0,
      groups: [{ size: 0.29 }, { size: 0.42 }, { size: 0.29 }],
    });

    this.leftUri = makeRevUri(this.repo.root, labeledRel(this.rel, 'Yours'), ':2');
    // The provider reads only the query — repoint rel at the real path.
    this.leftUri = this.leftUri.with({
      query: JSON.stringify({ repo: this.repo.root, rel: this.rel, ref: ':2' }),
    });
    this.rightUri = makeRevUri(this.repo.root, labeledRel(this.rel, 'Theirs'), ':3').with({
      query: JSON.stringify({ repo: this.repo.root, rel: this.rel, ref: ':3' }),
    });

    const mode = vscode.workspace
      .getConfiguration('gittree.merge')
      .get<'virtual' | 'markers'>('resultMode', 'virtual');
    if (mode === 'markers') {
      // Fallback for language servers that require on-disk files: edit the
      // real conflicted file in place, seeded with the canonical initial
      // result (undoable WorkspaceEdit; the index stages stay authoritative).
      this.centerUri = vscode.Uri.file(path.join(this.repo.root, this.rel));
      this.centerDoc = await vscode.workspace.openTextDocument(this.centerUri);
      const whole = this.centerDoc.validateRange(
        new vscode.Range(0, 0, Number.MAX_SAFE_INTEGER, 0),
      );
      const edit = new vscode.WorkspaceEdit();
      edit.replace(this.centerUri, whole, this.merge.initialText);
      this.selfEdit = true;
      try {
        await vscode.workspace.applyEdit(edit);
      } finally {
        this.selfEdit = false;
      }
    } else {
      this.centerUri = makeMergeUri(this.repo.root, this.rel);
      this.deps.mergeFs.seed(this.centerUri, this.merge.initialText);
      this.centerDoc = await vscode.workspace.openTextDocument(this.centerUri);
    }

    const leftDoc = await vscode.workspace.openTextDocument(this.leftUri);
    const rightDoc = await vscode.workspace.openTextDocument(this.rightUri);
    await vscode.window.showTextDocument(leftDoc, {
      viewColumn: vscode.ViewColumn.One,
      preview: false,
      preserveFocus: true,
    });
    await vscode.window.showTextDocument(rightDoc, {
      viewColumn: vscode.ViewColumn.Three,
      preview: false,
      preserveFocus: true,
    });
    await vscode.window.showTextDocument(this.centerDoc, {
      viewColumn: vscode.ViewColumn.Two,
      preview: false,
    });

    this.disposables.push(
      vscode.workspace.onDidChangeTextDocument((e) => this.onCenterEdit(e)),
      vscode.window.onDidChangeTextEditorVisibleRanges((e) => this.onScroll(e)),
      vscode.window.tabGroups.onDidChangeTabs((e) => this.onTabsClosed(e)),
    );
    this.paint();
  }

  // ---- anchors ---------------------------------------------------------------

  /** Map result-doc content changes onto the tracked block regions. */
  private onCenterEdit(e: vscode.TextDocumentChangeEvent): void {
    if (e.document.uri.toString() !== this.centerUri.toString()) return;
    if (this.selfEdit || e.contentChanges.length === 0) return;
    for (const change of e.contentChanges) {
      const delta =
        splitKeepEol(change.text).filter((l) => l.endsWith('\n')).length -
        (change.range.end.line - change.range.start.line);
      for (const tracked of this.blocks) {
        if (change.range.end.line < tracked.startLine) {
          tracked.startLine += delta;
          tracked.endLine += delta;
        } else if (change.range.start.line < tracked.endLine) {
          // Intersects the block region → the user rewrote it by hand.
          tracked.endLine = Math.max(tracked.startLine, tracked.endLine + delta);
          tracked.block.resolution = 'manual';
        }
        // Entirely after the block: nothing moves.
      }
    }
    this.paint();
    this._onDidChangeState.fire();
  }

  /** Chevron primitive (T4 puts CodeLenses on it): resolve one block. */
  async applyBlockResolution(blockId: number, side: BlockSide): Promise<void> {
    const tracked = this.blocks.find((t) => t.block.id === blockId);
    if (!tracked) return;
    const b = tracked.block;
    const lines =
      side === 'ours' ? b.ours : side === 'theirs' ? b.theirs : [...b.ours, ...b.theirs];
    const edit = new vscode.WorkspaceEdit();
    edit.replace(
      this.centerUri,
      new vscode.Range(tracked.startLine, 0, tracked.endLine, 0),
      lines.join(''),
    );
    this.selfEdit = true;
    try {
      await vscode.workspace.applyEdit(edit);
    } finally {
      this.selfEdit = false;
    }
    const oldLen = tracked.endLine - tracked.startLine;
    const shift = lines.length - oldLen;
    tracked.endLine = tracked.startLine + lines.length;
    for (const other of this.blocks) {
      if (other !== tracked && other.startLine >= tracked.startLine + oldLen) {
        other.startLine += shift;
        other.endLine += shift;
      }
    }
    b.resolution = side;
    this.paint();
    this._onDidChangeState.fire();
  }

  // ---- rendering ---------------------------------------------------------------

  private editorsFor(uri: vscode.Uri): vscode.TextEditor[] {
    return vscode.window.visibleTextEditors.filter(
      (ed) => ed.document.uri.toString() === uri.toString(),
    );
  }

  private paint(): void {
    const d = this.deps.decorations;
    const byState = {
      unresolved: [] as vscode.Range[],
      ours: [] as vscode.Range[],
      theirs: [] as vscode.Range[],
      both: [] as vscode.Range[],
      auto: [] as vscode.Range[],
      manual: [] as vscode.Range[],
    };
    for (const t of this.blocks) {
      const line = Math.min(t.startLine, Math.max(0, this.centerDoc.lineCount - 1));
      const range =
        t.endLine > t.startLine
          ? new vscode.Range(t.startLine, 0, t.endLine - 1, Number.MAX_SAFE_INTEGER)
          : new vscode.Range(line, 0, line, 0);
      byState[t.block.resolution ?? 'unresolved'].push(range);
    }
    for (const ed of this.editorsFor(this.centerUri)) {
      ed.setDecorations(d.unresolved, byState.unresolved);
      ed.setDecorations(d.ours, byState.ours);
      ed.setDecorations(d.theirs, byState.theirs);
      ed.setDecorations(d.both, byState.both);
      // T5 gives auto-resolutions their own tag; until then style as manual.
      ed.setDecorations(d.manual, [...byState.manual, ...byState.auto]);
    }
    // Side panes: each highlights its contribution ranges (static).
    const left: vscode.Range[] = [];
    const right: vscode.Range[] = [];
    for (const t of this.blocks) {
      if (t.block.ours.length > 0) {
        left.push(new vscode.Range(t.leftStart, 0, t.leftStart + t.block.ours.length - 1, Number.MAX_SAFE_INTEGER));
      }
      if (t.block.theirs.length > 0) {
        right.push(new vscode.Range(t.rightStart, 0, t.rightStart + t.block.theirs.length - 1, Number.MAX_SAFE_INTEGER));
      }
    }
    for (const ed of this.editorsFor(this.leftUri)) ed.setDecorations(d.ours, left);
    for (const ed of this.editorsFor(this.rightUri)) ed.setDecorations(d.theirs, right);
  }

  // ---- synchronized scrolling ---------------------------------------------------

  toggleSyncScroll(): void {
    this.syncScroll = !this.syncScroll;
  }

  paneOf(uri: vscode.Uri): 'left' | 'center' | 'right' | undefined {
    const s = uri.toString();
    if (s === this.leftUri.toString()) return 'left';
    if (s === this.centerUri.toString()) return 'center';
    if (s === this.rightUri.toString()) return 'right';
    return undefined;
  }

  private anchorLine(t: TrackedBlock, pane: 'left' | 'center' | 'right'): number {
    return pane === 'left' ? t.leftStart : pane === 'right' ? t.rightStart : t.startLine;
  }

  private onScroll(e: vscode.TextEditorVisibleRangesChangeEvent): void {
    if (!this.syncScroll || this.closed) return;
    const pane = this.paneOf(e.textEditor.document.uri);
    if (!pane || e.visibleRanges.length === 0) return;
    if (vscode.window.activeTextEditor !== e.textEditor) return; // leader only
    const guard = this.scrollGuard.get(pane);
    if (guard !== undefined && Date.now() < guard) return;

    const top = (e.visibleRanges[0] as vscode.Range).start.line;
    // Last anchor at or above the leader's top line (file start = anchor 0/0/0).
    let src = 0;
    let anchors: { left: number; center: number; right: number } = { left: 0, center: 0, right: 0 };
    for (const t of this.blocks) {
      const line = this.anchorLine(t, pane);
      if (line <= top) {
        src = line;
        anchors = { left: t.leftStart, center: t.startLine, right: t.rightStart };
      }
    }
    const offset = top - src;
    for (const target of ['left', 'center', 'right'] as const) {
      if (target === pane) continue;
      const uri = target === 'left' ? this.leftUri : target === 'right' ? this.rightUri : this.centerUri;
      for (const ed of this.editorsFor(uri)) {
        const line = Math.max(0, Math.min(anchors[target] + offset, ed.document.lineCount - 1));
        this.scrollGuard.set(target, Date.now() + SCROLL_GUARD_MS);
        ed.revealRange(new vscode.Range(line, 0, line, 0), vscode.TextEditorRevealType.AtTop);
      }
    }
  }

  // ---- navigation ---------------------------------------------------------------

  jumpToConflict(direction: 1 | -1): void {
    const editor = this.editorsFor(this.centerUri)[0];
    if (!editor) return;
    const unresolved = this.blocks.filter((t) => t.block.resolution === undefined);
    const pool = unresolved.length > 0 ? unresolved : this.blocks;
    if (pool.length === 0) return;
    const cur = editor.selection.active.line;
    const sorted = [...pool].sort((a, b) => a.startLine - b.startLine);
    let target = direction === 1 ? sorted.find((t) => t.startLine > cur) : undefined;
    if (direction === -1) {
      for (const t of sorted) if (t.startLine < cur) target = t;
    }
    target ??= direction === 1 ? sorted[0] : sorted[sorted.length - 1];
    if (!target) return;
    const pos = new vscode.Position(target.startLine, 0);
    editor.selection = new vscode.Selection(pos, pos);
    editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
  }

  // ---- lifecycle ---------------------------------------------------------------

  /** Serialize = the live result document (it IS the merge being built). */
  resultText(): string {
    return this.centerDoc.getText();
  }

  /** Apply: write the result to the worktree, `git add`, close, restore. */
  async apply(): Promise<boolean> {
    if (this.unresolvedCount > 0) {
      this.jumpToConflict(1);
      void vscode.window.showWarningMessage(
        vscode.l10n.t('{0} conflict(s) still unresolved in this file.', this.unresolvedCount),
      );
      return false;
    }
    if (this.centerDoc.isDirty) await this.centerDoc.save();
    const text = this.resultText();
    const abs = path.join(this.repo.root, this.rel);
    await vscode.workspace.fs.writeFile(vscode.Uri.file(abs), new TextEncoder().encode(text));
    await this.session.markResolved(this.rel);
    await this.close();
    return true;
  }

  /** Resolve-later / user closed a pane: tear down without writing. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const d of this.disposables) d.dispose();
    if (this.centerDoc.isDirty) {
      // Revert before closing tabs — a dirty document would otherwise pop a
      // save prompt (and in markers mode saving would write an abandoned
      // partial result over the conflicted file).
      await vscode.window.showTextDocument(this.centerDoc, {
        viewColumn: vscode.ViewColumn.Two,
        preview: false,
      });
      await vscode.commands.executeCommand('workbench.action.files.revert');
    }
    const ours = new Set(
      [this.leftUri, this.rightUri, this.centerUri].map((u) => u.toString()),
    );
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        const input = tab.input;
        if (
          input instanceof vscode.TabInputText &&
          ours.has(input.uri.toString())
        ) {
          await vscode.window.tabGroups.close(tab, true);
        }
      }
    }
    if (this.centerUri.scheme === MERGE_SCHEME) this.deps.mergeFs.drop(this.centerUri);
    if (this.savedLayout !== undefined) {
      await vscode.commands.executeCommand('vscode.setEditorLayout', this.savedLayout);
    }
    this._onDidClose.fire();
    this._onDidClose.dispose();
    this._onDidChangeState.dispose();
  }

  private onTabsClosed(e: vscode.TabChangeEvent): void {
    if (this.closed || e.closed.length === 0) return;
    const ours = new Set(
      [this.leftUri, this.rightUri, this.centerUri].map((u) => u.toString()),
    );
    const hit = e.closed.some(
      (tab) => tab.input instanceof vscode.TabInputText && ours.has(tab.input.uri.toString()),
    );
    if (!hit) return;
    void this.promptOnClose();
  }

  private async promptOnClose(): Promise<void> {
    const later = vscode.l10n.t('Resolve Later');
    const seeded = process.env['GITTREE_TEST_TRIEDITOR_CLOSE'];
    const choice =
      seeded !== undefined
        ? seeded === 'abort'
          ? vscode.l10n.t('Abort File')
          : later
        : await vscode.window.showWarningMessage(
            vscode.l10n.t('{0} is not resolved yet.', this.rel),
            { modal: true, detail: vscode.l10n.t('The file stays conflicted either way; Resolve Later keeps your partial result for this session.') },
            later,
            vscode.l10n.t('Abort File'),
          );
    // Both choices keep the file unmerged (nothing was written to the
    // worktree); the partial result document is discarded with the session
    // either way — "Resolve Later" simply names the safe default.
    void choice;
    await this.close();
  }
}

// ---- shared per-window plumbing -------------------------------------------------

export interface TriEditorDecorations {
  unresolved: vscode.TextEditorDecorationType;
  ours: vscode.TextEditorDecorationType;
  theirs: vscode.TextEditorDecorationType;
  both: vscode.TextEditorDecorationType;
  manual: vscode.TextEditorDecorationType;
}

export interface TriEditorDeps {
  mergeFs: MergeFsProvider;
  decorations: TriEditorDecorations;
}

export function createTriEditorDecorations(): TriEditorDecorations {
  const whole = { isWholeLine: true };
  return {
    unresolved: vscode.window.createTextEditorDecorationType({
      ...whole,
      backgroundColor: new vscode.ThemeColor('merge.commonContentBackground'),
      border: '1px solid',
      borderColor: new vscode.ThemeColor('editorError.foreground'),
      overviewRulerColor: new vscode.ThemeColor('editorError.foreground'),
      overviewRulerLane: vscode.OverviewRulerLane.Full,
    }),
    ours: vscode.window.createTextEditorDecorationType({
      ...whole,
      backgroundColor: new vscode.ThemeColor('merge.currentContentBackground'),
      overviewRulerColor: new vscode.ThemeColor('merge.currentContentBackground'),
      overviewRulerLane: vscode.OverviewRulerLane.Full,
    }),
    theirs: vscode.window.createTextEditorDecorationType({
      ...whole,
      backgroundColor: new vscode.ThemeColor('merge.incomingContentBackground'),
      overviewRulerColor: new vscode.ThemeColor('merge.incomingContentBackground'),
      overviewRulerLane: vscode.OverviewRulerLane.Full,
    }),
    both: vscode.window.createTextEditorDecorationType({
      ...whole,
      backgroundColor: new vscode.ThemeColor('merge.incomingContentBackground'),
      border: '1px solid',
      borderColor: new vscode.ThemeColor('merge.currentContentBackground'),
    }),
    manual: vscode.window.createTextEditorDecorationType({
      ...whole,
      border: '1px dashed',
      borderColor: new vscode.ThemeColor('editorInfo.foreground'),
    }),
  };
}

/**
 * Window-level manager: one tri-editor per (repo, rel); owns the status-bar
 * segment `Conflicts: k/n resolved · file i/m` and the F7 navigation targets.
 */
export class TriEditorManager implements vscode.Disposable {
  private readonly open = new Map<string, TriMergeEditor>();
  private readonly statusBar: vscode.StatusBarItem;
  readonly decorations: TriEditorDecorations;

  constructor(private readonly mergeFs: MergeFsProvider) {
    this.decorations = createTriEditorDecorations();
    this.statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 40);
    this.statusBar.command = 'gittree.merge.nextConflict';
  }

  private key(repoRoot: string, rel: string): string {
    return `${repoRoot.toLowerCase()}::${rel}`;
  }

  get(repoRoot: string, rel: string): TriMergeEditor | undefined {
    return this.open.get(this.key(repoRoot, rel));
  }

  /** The tri-editor whose panes include the active editor (F7 target). */
  active(): TriMergeEditor | undefined {
    const uri = vscode.window.activeTextEditor?.document.uri;
    const first = [...this.open.values()][0];
    if (!uri) return first;
    if (uri.scheme === MERGE_SCHEME || uri.scheme === REV_SCHEME || uri.scheme === 'file') {
      for (const t of this.open.values()) {
        if (t.paneOf(uri) !== undefined) return t;
      }
    }
    return first;
  }

  async openEditor(
    repo: RepoHandle,
    rel: string,
    session: ConflictSession,
    merge: MergeComputation,
  ): Promise<TriMergeEditor> {
    const key = this.key(repo.root, rel);
    const existing = this.open.get(key);
    if (existing) return existing;
    const editor = await TriMergeEditor.open(repo, rel, session, merge, {
      mergeFs: this.mergeFs,
      decorations: this.decorations,
    });
    this.open.set(key, editor);
    editor.onDidClose(() => {
      this.open.delete(key);
      this.refreshUi();
    });
    editor.onDidChangeState(() => this.refreshUi());
    this.refreshUi();
    return editor;
  }

  private refreshUi(): void {
    const active = this.active();
    void vscode.commands.executeCommand(
      'setContext',
      'gittree.merge.triEditorActive',
      this.open.size > 0,
    );
    if (!active) {
      this.statusBar.hide();
      return;
    }
    const files = active.session.files();
    const fileIdx = Math.max(0, files.findIndex((f) => f.path === active.rel)) + 1;
    this.statusBar.text = vscode.l10n.t(
      '$(git-merge) Conflicts: {0}/{1} resolved · file {2}/{3}',
      active.resolvedCount,
      active.blocks.length,
      fileIdx,
      Math.max(files.length, fileIdx),
    );
    this.statusBar.tooltip = active.rel;
    this.statusBar.show();
  }

  dispose(): void {
    for (const t of this.open.values()) void t.close();
    this.open.clear();
    this.statusBar.dispose();
    const d = this.decorations;
    for (const type of [d.unresolved, d.ours, d.theirs, d.both, d.manual]) type.dispose();
  }
}
