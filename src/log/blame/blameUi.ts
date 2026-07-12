/**
 * Blame UI (P4-T7): the IntelliJ "Annotate" gutter column — fixed-width
 * before-decorations with per-age heat buckets, hover commit card with
 * trusted command links (Show in Log / Copy / Show Diff), cursor-line
 * status-bar item, per-document toggle from the gutter context menu.
 */
import * as vscode from 'vscode';
import type { Core, RepoHandle } from '../../core/core';
import { canonicalKey } from '../../core/repoDiscovery';
import { makeRevUri } from '../../core/vdocs/revContentProvider';
import { BlameService, type FileBlame, type LineBlame } from './blameService';

const BUCKETS = 10;
const LARGE_FILE_LINES = 20_000;

export function formatBlameLabel(
  format: string,
  blame: LineBlame,
  now: number = Date.now(),
): string {
  const date = blame.isUncommitted ? '' : relativeDate(blame.authorTime, now);
  return format
    .replace(/\$\{author(?:\|(\d+))?\}/g, (_, w) => fit(blame.author, w ? Number(w) : 12))
    .replace(/\$\{date(?:\|relative)?\}/g, () => fit(date, 10))
    .replace(/\$\{sha(?:\|(\d+))?\}/g, (_, w) => blame.isUncommitted ? fit('*', w ? Number(w) : 7) : blame.sha.slice(0, w ? Number(w) : 7));
}

function fit(s: string, width: number): string {
  return s.length > width ? s.slice(0, width - 1) + '…' : s.padEnd(width);
}

function relativeDate(unixSeconds: number, now: number): string {
  const days = Math.floor((now / 1000 - unixSeconds) / 86_400);
  if (days < 1) return 'today';
  if (days < 30) return `${days}d ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

/** Decile bucket of a commit time across the file's blame span (0 = newest). */
export function heatBucket(time: number, sortedTimes: readonly number[]): number {
  if (sortedTimes.length === 0) return BUCKETS - 1;
  let idx = sortedTimes.findIndex((t) => t >= time);
  if (idx === -1) idx = sortedTimes.length - 1;
  const percentileFromNewest = 1 - idx / Math.max(1, sortedTimes.length - 1 || 1);
  return Math.min(BUCKETS - 1, Math.floor(percentileFromNewest * BUCKETS));
}

export class BlameUi implements vscode.Disposable {
  private readonly services = new Map<string, BlameService>();
  private readonly enabled = new Set<string>(); // doc uri strings
  private decorationTypes: vscode.TextEditorDecorationType[] = [];
  private readonly subs: vscode.Disposable[] = [];
  private readonly statusItem: vscode.StatusBarItem;
  private recomputeTimer: NodeJS.Timeout | undefined;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly core: Core,
  ) {
    this.buildDecorationTypes();
    this.statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
    this.statusItem.command = 'gittree.blame.revealCursorCommit';
    this.subs.push(
      this.statusItem,
      vscode.window.onDidChangeActiveTextEditor(() => void this.refresh()),
      vscode.window.onDidChangeTextEditorSelection((e) => this.updateStatusBar(e.textEditor)),
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (this.enabled.has(e.document.uri.toString())) {
          if (this.recomputeTimer) clearTimeout(this.recomputeTimer);
          this.recomputeTimer = setTimeout(() => void this.refresh(), 300);
        }
      }),
      vscode.window.onDidChangeActiveColorTheme(() => {
        this.buildDecorationTypes();
        void this.refresh();
      }),
      vscode.languages.registerHoverProvider({ scheme: 'file' }, { provideHover: (doc, pos) => this.hover(doc, pos) }),
    );
  }

  private serviceFor(repo: RepoHandle): BlameService {
    const key = canonicalKey(repo.root);
    let s = this.services.get(key);
    if (!s) {
      s = new BlameService(repo);
      this.services.set(key, s);
      repo.disposables.add({ dispose: () => this.services.delete(key) });
    }
    return s;
  }

  private buildDecorationTypes(): void {
    for (const t of this.decorationTypes) t.dispose();
    const dark = [vscode.ColorThemeKind.Dark, vscode.ColorThemeKind.HighContrast].includes(
      vscode.window.activeColorTheme.kind,
    );
    this.decorationTypes = Array.from({ length: BUCKETS + 1 }, (_, bucket) => {
      // bucket BUCKETS = "uncommitted" (brightest).
      const alpha = bucket === BUCKETS ? 1 : 0.35 + (bucket / BUCKETS) * 0.6;
      const color = dark ? `rgba(140, 180, 255, ${alpha})` : `rgba(30, 80, 180, ${alpha})`;
      return vscode.window.createTextEditorDecorationType({
        isWholeLine: false,
        before: {
          color,
          margin: '0 1ch 0 0',
          borderColor: new vscode.ThemeColor('editorLineNumber.foreground'),
        },
      });
    });
  }

  async toggle(editor: vscode.TextEditor | undefined = vscode.window.activeTextEditor): Promise<void> {
    if (!editor || editor.document.uri.scheme !== 'file') return;
    const key = editor.document.uri.toString();
    if (this.enabled.has(key)) {
      this.enabled.delete(key);
      this.clear(editor);
    } else {
      if (editor.document.lineCount > LARGE_FILE_LINES) {
        const proceed = await vscode.window.showWarningMessage(
          vscode.l10n.t('Annotate {0} lines? This can be slow.', editor.document.lineCount),
          vscode.l10n.t('Annotate'),
        );
        if (proceed === undefined) return;
      }
      this.enabled.add(key);
    }
    await vscode.commands.executeCommand('setContext', 'gittree.blameOn', this.enabled.has(key));
    await this.refresh();
  }

  isEnabled(doc: vscode.TextDocument): boolean {
    return this.enabled.has(doc.uri.toString());
  }

  private clear(editor: vscode.TextEditor): void {
    for (const t of this.decorationTypes) editor.setDecorations(t, []);
    this.statusItem.hide();
  }

  async refresh(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;
    const doc = editor.document;
    await vscode.commands.executeCommand('setContext', 'gittree.blameOn', this.isEnabled(doc));
    if (!this.isEnabled(doc)) {
      this.clear(editor);
      return;
    }
    const repo = this.core.repoForUri(doc.uri);
    if (!repo) return;
    const blame = await this.serviceFor(repo).blameFile(
      doc.uri.fsPath,
      doc.getText(),
      doc.isDirty,
      doc.version,
      doc.lineCount,
    );
    if (!blame || vscode.window.activeTextEditor !== editor || doc.version !== editor.document.version) {
      if (!blame) this.clear(editor);
      return;
    }
    this.apply(editor, blame);
    this.updateStatusBar(editor);
  }

  private apply(editor: vscode.TextEditor, blame: FileBlame): void {
    const format = vscode.workspace
      .getConfiguration('gittree')
      .get<string>('blame.format', '${author|12} ${date|relative} ${sha|7}');
    const heatmapOn = vscode.workspace.getConfiguration('gittree').get<boolean>('blame.heatmap', true);
    const now = Date.now();
    const byBucket: vscode.DecorationOptions[][] = Array.from({ length: BUCKETS + 1 }, () => []);

    let prevSha: string | undefined;
    for (let line = 0; line < blame.lines.length && line < editor.document.lineCount; line++) {
      const lb = blame.lines[line] as LineBlame;
      const firstOfRun = lb.sha !== prevSha;
      prevSha = lb.sha;
      const text = firstOfRun ? formatBlameLabel(format, lb, now) : ' '.repeat(formatBlameLabel(format, lb, now).length);
      const bucket = lb.isUncommitted ? BUCKETS : heatmapOn ? heatBucket(lb.authorTime, blame.times) : 0;
      byBucket[bucket]!.push({
        range: new vscode.Range(line, 0, line, 0),
        renderOptions: { before: { contentText: text } },
      });
    }
    this.decorationTypes.forEach((type, bucket) => {
      editor.setDecorations(type, byBucket[bucket] ?? []);
    });
  }

  private updateStatusBar(editor: vscode.TextEditor): void {
    if (!this.isEnabled(editor.document)) {
      this.statusItem.hide();
      return;
    }
    const repo = this.core.repoForUri(editor.document.uri);
    if (!repo) return;
    const line = editor.selection.active.line;
    const lb = this.serviceFor(repo).getCommitForLine(editor.document.uri.fsPath, line);
    if (!lb) {
      this.statusItem.hide();
      return;
    }
    this.statusItem.text = `$(git-commit) ${lb.author}, ${lb.isUncommitted ? vscode.l10n.t('uncommitted') : relativeDate(lb.authorTime, Date.now())} · ${lb.summary.slice(0, 40)}`;
    this.statusItem.tooltip = vscode.l10n.t('Reveal commit in the Git log');
    this.statusItem.show();
  }

  cursorCommit(): LineBlame | undefined {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return undefined;
    const repo = this.core.repoForUri(editor.document.uri);
    if (!repo) return undefined;
    return this.serviceFor(repo).getCommitForLine(editor.document.uri.fsPath, editor.selection.active.line);
  }

  private hover(doc: vscode.TextDocument, pos: vscode.Position): vscode.Hover | undefined {
    if (!this.isEnabled(doc)) return undefined;
    const repo = this.core.repoForUri(doc.uri);
    if (!repo) return undefined;
    const lb = this.serviceFor(repo).getCommitForLine(doc.uri.fsPath, pos.line);
    if (!lb || lb.isUncommitted) return undefined;
    const md = new vscode.MarkdownString(undefined, true);
    md.isTrusted = true;
    const shaArg = encodeURIComponent(JSON.stringify([lb.sha]));
    const diffArg = encodeURIComponent(JSON.stringify([lb.sha, doc.uri.fsPath]));
    md.appendMarkdown(
      `**${lb.author}** · ${new Date(lb.authorTime * 1000).toLocaleString()}\n\n` +
        `\`${lb.sha.slice(0, 12)}\` ${escapeMd(lb.summary)}\n\n` +
        `[$(git-commit) Show in Log](command:gittree.log.revealCommit?${shaArg}) · ` +
        `[$(copy) Copy sha](command:gittree.log.copySha?${shaArg}) · ` +
        `[$(diff) Show Diff](command:gittree.blame.showDiff?${diffArg})`,
    );
    return new vscode.Hover(md, new vscode.Range(pos.line, 0, pos.line, 0));
  }

  /** `gittree.blame.showDiff` target — commit vs its parent for this file. */
  async showDiff(sha: string, fsPath: string): Promise<void> {
    const repo = this.core.repoForPath(fsPath);
    if (!repo) return;
    const rel = fsPath.startsWith(repo.root)
      ? fsPath.slice(repo.root.length + 1).replace(/\\/g, '/')
      : fsPath.replace(/\\/g, '/');
    await vscode.commands.executeCommand(
      'vscode.diff',
      makeRevUri(repo.root, rel, `${sha}^`),
      makeRevUri(repo.root, rel, sha),
      `${rel} (${sha.slice(0, 7)})`,
    );
  }

  dispose(): void {
    for (const t of this.decorationTypes) t.dispose();
    for (const s of this.subs) s.dispose();
    if (this.recomputeTimer) clearTimeout(this.recomputeTimer);
  }
}

function escapeMd(s: string): string {
  return s.replace(/[\\`*_{}[\]()#+\-.!]/g, '\\$&');
}
