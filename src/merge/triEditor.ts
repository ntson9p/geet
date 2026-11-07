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
import { countMerge, mergeStatusText, type ApplySide } from './applyNonConflicting';
import { sideRef } from './conflictKinds';
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
  /** The user typed into the result (accepting a block counts through `resolvedCount`). */
  private edited = false;
  /** A pane was closed and the editor is going: said at most once. */
  private closing = false;
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

  /**
   * P13-T8 · §2A: the live toolbar string —
   * `No changes. 2 conflicts.` / `3 changes, 1 conflict.`
   */
  statusText(): string {
    return mergeStatusText(
      countMerge(
        this.blocks.map((t) => t.block),
        {
          whitespace: vscode.workspace
            .getConfiguration('gittree.merge')
            .get<boolean>('autoResolveWhitespace', true),
        },
      ),
    );
  }

  /**
   * P13-T8 · §2A per-side `Show Details`: the revision behind one pane —
   * hash, author and date, which the pane title alone cannot carry.
   */
  async sideDetails(side: 'left' | 'right'): Promise<string> {
    const label = side === 'left' ? vscode.l10n.t('Yours') : vscode.l10n.t('Theirs');
    const ref = sideRef(side, this.session.reversed, this.repo.model.snapshot.inProgressOp?.kind);
    if (ref === undefined) {
      return side === 'left'
        ? vscode.l10n.t('{0}: your working copy.', label)
        : vscode.l10n.t('{0}: the changes being applied (stash or shelf), which have no commit of their own.', label);
    }
    const res = await this.repo.queue.enqueue({
      label: 'merge side details',
      kind: 'read',
      run: (git, token) =>
        git.exec(
          this.repo.root,
          ['log', '-1', '--format=%H%x00%an%x00%ad%x00%s', '--date=short', ref],
          { allowNonZeroExit: true, structured: true, noOptionalLocks: true, token },
        ),
    });
    if (res.exitCode !== 0) {
      return vscode.l10n.t('{0}: revision unavailable ({1} not found).', label, ref);
    }
    const [sha, author, date, subject] = res.stdout.trim().split('\0');
    return vscode.l10n.t(
      '{0} — {1} · {2} · {3} · {4}',
      label,
      (sha ?? '').slice(0, 7),
      author ?? '',
      date ?? '',
      subject ?? '',
    );
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

    // Yours on the left is the user's side: git's stage 3 mid-rebase (POST-QA F7).
    const [yoursStage, theirsStage] = this.session.reversed ? [':3', ':2'] : [':2', ':3'];
    this.leftUri = makeRevUri(this.repo.root, labeledRel(this.rel, 'Yours'), yoursStage);
    // The provider reads only the query — repoint rel at the real path.
    this.leftUri = this.leftUri.with({
      query: JSON.stringify({ repo: this.repo.root, rel: this.rel, ref: yoursStage }),
    });
    this.rightUri = makeRevUri(this.repo.root, labeledRel(this.rel, 'Theirs'), theirsStage).with({
      query: JSON.stringify({ repo: this.repo.root, rel: this.rel, ref: theirsStage }),
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
    this.edited = true;
    const touched = new Set<TrackedBlock>();
    for (const change of e.contentChanges) {
      const delta =
        splitKeepEol(change.text).filter((l) => l.endsWith('\n')).length -
        (change.range.end.line - change.range.start.line);
      for (const tracked of this.blocks) {
        if (change.range.end.line < tracked.startLine) {
          tracked.startLine += delta;
          tracked.endLine += delta;
        } else if (change.range.start.line < tracked.endLine) {
          // Intersects the block region — reconcile below.
          tracked.endLine = Math.max(tracked.startLine, tracked.endLine + delta);
          touched.add(tracked);
        }
        // Entirely after the block: nothing moves.
      }
    }
    // Reconciliation (undo restores prior state): classify the region's text
    // back to a known resolution instead of blindly calling it manual.
    for (const tracked of touched) this.reconcileBlock(tracked);
    this.paint();
    this._onDidChangeState.fire();
  }

  /** Compare a block's live region against its known side texts. */
  private reconcileBlock(tracked: TrackedBlock): void {
    const b = tracked.block;
    const text = this.centerDoc.getText(
      new vscode.Range(tracked.startLine, 0, tracked.endLine, 0),
    );
    const joined = (lines: string[]): string => lines.join('');
    if (text === joined(b.base)) {
      b.resolution = undefined; // undo of a chevron → back to unresolved
      b.resolvedLines = undefined;
    } else if (text === joined(b.ours)) {
      b.resolution = 'ours';
    } else if (text === joined(b.theirs)) {
      b.resolution = 'theirs';
    } else if (text === joined([...b.ours, ...b.theirs])) {
      b.resolution = 'both';
    } else {
      b.resolution = 'manual';
      b.resolvedLines = splitKeepEol(text);
    }
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

  /** Magic Wand application: arbitrary woven lines, tagged 'auto' (T5). */
  async applyAutoResolution(blockId: number, lines: string[]): Promise<void> {
    const tracked = this.blocks.find((t) => t.block.id === blockId);
    if (!tracked) return;
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
    const oldEnd = tracked.endLine;
    const shift = lines.length - (tracked.endLine - tracked.startLine);
    tracked.endLine = tracked.startLine + lines.length;
    for (const other of this.blocks) {
      if (other !== tracked && other.startLine >= oldEnd) {
        other.startLine += shift;
        other.endLine += shift;
      }
    }
    tracked.block.resolution = 'auto';
    tracked.block.resolvedLines = [...lines];
    this.paint();
    this._onDidChangeState.fire();
  }

  /** "Ignore (keep base)": resolves the block without changing its text. */
  ignoreBlock(blockId: number): void {
    const tracked = this.blocks.find((t) => t.block.id === blockId);
    if (!tracked) return;
    tracked.block.resolution = 'manual';
    tracked.block.resolvedLines = [...tracked.block.base];
    this.paint();
    this._onDidChangeState.fire();
  }

  /** Revert Block: back to base text and the unresolved state. */
  async revertBlock(blockId: number): Promise<void> {
    const tracked = this.blocks.find((t) => t.block.id === blockId);
    if (!tracked) return;
    const edit = new vscode.WorkspaceEdit();
    edit.replace(
      this.centerUri,
      new vscode.Range(tracked.startLine, 0, tracked.endLine, 0),
      tracked.block.base.join(''),
    );
    this.selfEdit = true;
    try {
      await vscode.workspace.applyEdit(edit);
    } finally {
      this.selfEdit = false;
    }
    const shift = tracked.block.base.length - (tracked.endLine - tracked.startLine);
    const oldEnd = tracked.endLine;
    tracked.endLine = tracked.startLine + tracked.block.base.length;
    for (const other of this.blocks) {
      if (other !== tracked && other.startLine >= oldEnd) {
        other.startLine += shift;
        other.endLine += shift;
      }
    }
    tracked.block.resolution = undefined;
    tracked.block.resolvedLines = undefined;
    this.paint();
    this._onDidChangeState.fire();
  }

  /** The block whose region in `pane` contains (or starts at) `line`. */
  blockAt(pane: 'left' | 'center' | 'right', line: number): TrackedBlock | undefined {
    for (const t of this.blocks) {
      const start = this.anchorLine(t, pane);
      const len =
        pane === 'left'
          ? t.block.ours.length
          : pane === 'right'
            ? t.block.theirs.length
            : t.endLine - t.startLine;
      if (len === 0) {
        if (line === start) return t;
        continue;
      }
      if (line >= start && line < start + len) return t;
    }
    return undefined;
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
        this.unresolvedCount === 1
          ? vscode.l10n.t('1 conflict still unresolved in this file.')
          : vscode.l10n.t('{0} conflicts still unresolved in this file.', this.unresolvedCount),
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

  /** Brings an open editor's result pane to the front (a second open of its file). */
  async reveal(): Promise<void> {
    if (this.closed) return;
    await vscode.window.showTextDocument(this.centerDoc, { viewColumn: vscode.ViewColumn.Two, preview: false });
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
    // Closing all three panes fires a change per tab: one answer is enough.
    if (this.closed || this.closing || e.closed.length === 0) return;
    const ours = new Set(
      [this.leftUri, this.rightUri, this.centerUri].map((u) => u.toString()),
    );
    const hit = e.closed.some(
      (tab) => tab.input instanceof vscode.TabInputText && ours.has(tab.input.uri.toString()),
    );
    if (!hit) return;
    this.closing = true;
    void this.closedByUser();
  }

  /**
   * The user closed a pane (POST-QA): the editor cannot stay half open, so it
   * goes, and the file stays conflicted — nothing was written. It used to ask
   * "Resolve Later / Abort File" in a modal per closed tab (six in a row for a
   * double-clicked file), and both answers did the same thing, the first
   * promising a partial result it then threw away. Now it says so once, and
   * only when there was work to lose, with a way back in.
   */
  private async closedByUser(): Promise<void> {
    const lost = this.edited || this.resolvedCount > 0;
    await this.close();
    if (!lost || process.env['GITTREE_TEST'] === '1') return;
    const reopen = vscode.l10n.t('Reopen');
    const choice = await vscode.window.showWarningMessage(
      vscode.l10n.t(
        '{0} is still conflicted: the merge editor was closed before Apply, and the conflicts resolved in it were discarded.',
        this.rel,
      ),
      reopen,
    );
    if (choice !== reopen) return;
    const file = this.session.files().find((f) => f.path === this.rel);
    if (file) await vscode.commands.executeCommand('gittree.merge.open', { session: this.session, path: file.path, kind: file.kind });
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
  /** Editors still opening, so a second open of the same file waits for the first. */
  private readonly opening = new Map<string, Promise<TriMergeEditor>>();
  private readonly statusBar: vscode.StatusBarItem;
  readonly decorations: TriEditorDecorations;
  private readonly _onDidChangeState = new vscode.EventEmitter<void>();
  /** Any open tri-editor changed (open/close/resolution) — CodeLens refresh. */
  readonly onDidChangeState = this._onDidChangeState.event;
  /**
   * P13-T8 test seam: the Left/All/Right toolbar action, returning the status
   * string it reported — which is what the acceptance line asserts on.
   * Installed by `registerResolutionActions`.
   */
  applyNonConflictingForTest?: (side: ApplySide) => Promise<string>;

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
    if (existing) {
      await existing.reveal();
      return existing;
    }
    // A double-click opens twice before the first open has finished: one
    // editor per file, or the second's panes close under the first (POST-QA).
    const pending = this.opening.get(key);
    if (pending) return pending;
    const opened = TriMergeEditor.open(repo, rel, session, merge, {
      mergeFs: this.mergeFs,
      decorations: this.decorations,
    });
    this.opening.set(key, opened);
    let editor: TriMergeEditor;
    try {
      editor = await opened;
    } finally {
      this.opening.delete(key);
    }
    this.open.set(key, editor);
    editor.onDidClose(() => {
      this.open.delete(key);
      this.refreshUi();
      this._onDidChangeState.fire();
    });
    editor.onDidChangeState(() => {
      this.refreshUi();
      this._onDidChangeState.fire();
    });
    this.refreshUi();
    this._onDidChangeState.fire();
    return editor;
  }

  /** The tri-editor owning `uri` as one of its panes. */
  owner(uri: vscode.Uri): { editor: TriMergeEditor; pane: 'left' | 'center' | 'right' } | undefined {
    for (const t of this.open.values()) {
      const pane = t.paneOf(uri);
      if (pane) return { editor: t, pane };
    }
    return undefined;
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
    // P13-T8: the live IntelliJ counter rides along with the file position.
    this.statusBar.text = vscode.l10n.t(
      '$(git-merge) {0} · {1}/{2} resolved · file {3}/{4}',
      active.statusText(),
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
    this._onDidChangeState.dispose();
    const d = this.decorations;
    for (const type of [d.unresolved, d.ours, d.theirs, d.both, d.manual]) type.dispose();
  }
}
