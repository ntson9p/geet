/**
 * Blame UI (P4-T7): the IntelliJ "Annotate" gutter column — fixed-width
 * before-decorations on *every* line, each cell's background shaded by the
 * commit's age on a five-step gradient, hover commit card with trusted command
 * links (Show in Log / Copy / Show Diff), cursor-line status-bar item,
 * per-document toggle from the gutter context menu.
 */
import * as vscode from 'vscode';
import type { Core, RepoHandle } from '../../core/core';
import { canonicalKey } from '../../core/repoDiscovery';
import { makeRevUri } from '../../core/vdocs/revContentProvider';
import { BlameService, type FileBlame, type LineBlame } from './blameService';
import {
  AGE_STEPS,
  ageStep,
  formatBlameLabel,
  relativeDate,
  toDecorationText,
} from './blameLabel';

export { ageStep, formatBlameLabel } from './blameLabel';

const LARGE_FILE_LINES = 20_000;

/**
 * Per-line attachment options.
 *
 * A decoration *type* cannot vary per line, so whatever differs between lines
 * — the label and the age shade — has to travel in each range's own
 * `renderOptions`. That path is also the unrestricted one: the extension host
 * forwards `renderOptions` verbatim to `$trySetDecorations`, whereas the
 * *type* converter rebuilds the object against a fixed whitelist. A
 * single-edge rule is only expressible here, which is why the column
 * separator rides along instead of living on the type.
 *
 * The editor de-duplicates these structurally (`hash(renderOptions)` → one
 * registered sub-type and one CSS rule, unused ones dropped on the next
 * `setDecorations`). Both fields that vary are derived from the commit, so
 * that is one rule per *commit* in the file, not one per line.
 */
type Attachment = vscode.ThemableDecorationAttachmentRenderOptions & {
  borderStyle?: string;
  borderWidth?: string;
};

/**
 * The age gradient, newest first.
 *
 * IntelliJ's annotation colours are theme data — five anchors a colour scheme
 * or the user can replace — so these are contributed colours rather than
 * literals. Themable also means self-updating: the renderer flags any rule
 * built from a `ThemeColor` and rebuilds its CSS on `onDidColorThemeChange`,
 * so nothing here has to listen for a theme switch.
 */
const AGE_BACKGROUNDS: readonly vscode.ThemeColor[] = Array.from(
  { length: AGE_STEPS },
  (_, step) => new vscode.ThemeColor(`geet.blame.age${step + 1}Background`),
);

/** Outside the gradient: a line nobody has committed yet has no age to rank. */
const UNCOMMITTED_BACKGROUND = new vscode.ThemeColor('geet.blame.uncommittedBackground');

/**
 * One legible foreground for every line. The age lives in the background now;
 * fading the text as well would stack two ramps on top of each other and leave
 * the oldest lines unreadable, which is why IntelliJ only shades the cell.
 */
const FOREGROUND = new vscode.ThemeColor('geet.blame.foreground');

/** Right edge of the annotation column, echoing IntelliJ's gutter separator. */
const RULE_COLOR = new vscode.ThemeColor('editorLineNumber.foreground');

function attachment(contentText: string, background: vscode.ThemeColor | undefined): Attachment {
  return {
    contentText,
    ...(background ? { backgroundColor: background } : {}),
    borderColor: RULE_COLOR,
    borderStyle: 'solid',
    borderWidth: '0 1px 0 0',
    // Fill the row so the shading is a solid block rather than a stripe: an
    // inline box would only paint behind the glyphs. `height` also flips the
    // generated rule to `display: inline-block`, and every `.view-line` is
    // laid out with a definite pixel height *and* a matching `line-height`
    // (`ViewLine.layoutLine`), so the box is exactly one row tall and its
    // baseline still lines up with the code.
    height: '100%',
  };
}

export class BlameUi implements vscode.Disposable {
  private readonly services = new Map<string, BlameService>();
  private readonly enabled = new Set<string>(); // doc uri strings
  private readonly decorationType: vscode.TextEditorDecorationType;
  private readonly subs: vscode.Disposable[] = [];
  private readonly statusItem: vscode.StatusBarItem;
  private recomputeTimer: NodeJS.Timeout | undefined;
  /** P4-T7 history watch: per-repo model subscriptions, and their coalescer. */
  private readonly repoSubs = new Map<string, vscode.Disposable>();
  private readonly lastHeadSha = new Map<string, string | undefined>();
  /**
   * Repositories whose HEAD moved since the last flush. The timer is shared —
   * one re-blame serves them all, since only the active editor is annotated —
   * but the set is not: a second repository moving must not cancel the first
   * one's invalidation, which a bare `clearTimeout` on a single pending repo
   * would do in any multi-root workspace.
   */
  private readonly pendingHeadMoves = new Map<string, RepoHandle>();
  private headMoveTimer: NodeJS.Timeout | undefined;
  /** Re-blames caused by history moving (integration-test observability). */
  headRefreshCount = 0;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly core: Core,
  ) {
    // Only the static half of the attachment lives on the type; the label
    // and the age shade vary per line and travel in each range instead.
    this.decorationType = vscode.window.createTextEditorDecorationType({
      isWholeLine: false,
      before: {
        color: FOREGROUND,
        // Outside the shaded cell, so the column reads as a gutter next to the code.
        margin: '0 1ch 0 0',
      },
    });
    this.statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
    this.statusItem.command = 'geet.blame.revealCursorCommit';
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
      vscode.languages.registerHoverProvider({ scheme: 'file' }, { provideHover: (doc, pos) => this.hover(doc, pos) }),
      // Annotations are a view of history, so they have to follow it. Every
      // event above is about the *editor*; none of them fires when a commit,
      // amend, reset or rebase changes what the lines are attributed to.
      this.core.onDidAddRepo((repo) => this.watchHead(repo)),
      this.core.onDidRemoveRepo((repo) => this.unwatchHead(repo)),
    );
    for (const repo of this.core.repos) this.watchHead(repo);
  }

  /**
   * Re-blame the annotated file when this repository's HEAD moves.
   *
   * Gated on the sha rather than `sections.has('head')`, which also fires for
   * ahead/behind and `lastFetchAt` — neither changes a single attribution. A
   * ref moving without HEAD (a branch or tag created elsewhere, a fetch) is
   * likewise irrelevant: blame walks HEAD's ancestry and nothing else.
   */
  private watchHead(repo: RepoHandle): void {
    const key = canonicalKey(repo.root);
    if (this.repoSubs.has(key)) return;
    this.lastHeadSha.set(key, repo.model.snapshot.headSha);
    const sub = repo.model.onDidChange(() => {
      const head = repo.model.snapshot.headSha;
      if (this.lastHeadSha.get(key) === head) return;
      this.lastHeadSha.set(key, head);
      this.pendingHeadMoves.set(key, repo);
      // A rebase moves HEAD once per step and a cold blame is a §13 300 ms
      // budget, so a burst costs one re-blame rather than one per step.
      if (this.headMoveTimer) clearTimeout(this.headMoveTimer);
      this.headMoveTimer = setTimeout(() => {
        this.headMoveTimer = undefined;
        // The stamped cache key already stops a superseded blame being
        // *served*; dropping it here is what makes the column repaint rather
        // than wait for the next editor switch.
        for (const moved of this.pendingHeadMoves.values()) this.serviceFor(moved).invalidate();
        this.pendingHeadMoves.clear();
        const editor = vscode.window.activeTextEditor;
        if (!editor || !this.isEnabled(editor.document)) return;
        this.headRefreshCount++;
        void this.refresh();
      }, 300);
      this.headMoveTimer.unref?.();
    });
    this.repoSubs.set(key, sub);
  }

  private unwatchHead(repo: RepoHandle): void {
    const key = canonicalKey(repo.root);
    this.repoSubs.get(key)?.dispose();
    this.repoSubs.delete(key);
    this.lastHeadSha.delete(key);
    this.pendingHeadMoves.delete(key);
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
    await vscode.commands.executeCommand('setContext', 'geet.blameOn', this.enabled.has(key));
    await this.refresh();
  }

  isEnabled(doc: vscode.TextDocument): boolean {
    return this.enabled.has(doc.uri.toString());
  }

  private clear(editor: vscode.TextEditor): void {
    editor.setDecorations(this.decorationType, []);
    this.statusItem.hide();
  }

  async refresh(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;
    const doc = editor.document;
    await vscode.commands.executeCommand('setContext', 'geet.blameOn', this.isEnabled(doc));
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
    const cfg = vscode.workspace.getConfiguration('geet');
    const format = cfg.get<string>('blame.format', '${author|12} ${date|relative} ${sha|7}');
    const shadeByAge = cfg.get<boolean>('blame.heatmap', true);
    const now = Date.now();
    const options: vscode.DecorationOptions[] = [];

    // Every line carries its own label — IntelliJ repeats the annotation and
    // lets the cell's shade, not a blank gap, carry how old the commit is.
    // Blanking the interior of a run left the reader unable to say who wrote
    // a line without scrolling to the head of the group.
    for (let line = 0; line < blame.lines.length && line < editor.document.lineCount; line++) {
      const lb = blame.lines[line] as LineBlame;
      // Spaces collapse inside the decoration's CSS `content`; nbsp does not.
      const text = toDecorationText(formatBlameLabel(format, lb, now));
      const background = !shadeByAge
        ? undefined
        : lb.isUncommitted
          ? UNCOMMITTED_BACKGROUND
          : AGE_BACKGROUNDS[ageStep(lb.authorTime, blame.times)];
      options.push({
        range: new vscode.Range(line, 0, line, 0),
        renderOptions: { before: attachment(text, background) },
      });
    }
    editor.setDecorations(this.decorationType, options);
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
    // The log shows one repository at a time and no longer re-picks it from
    // the focused editor, so the blamed line has to name its own — otherwise
    // "Show in Log" pages a repository that never had this commit.
    const revealArg = encodeURIComponent(JSON.stringify([lb.sha, repo.root]));
    const diffArg = encodeURIComponent(JSON.stringify([lb.sha, doc.uri.fsPath]));
    md.appendMarkdown(
      `**${lb.author}** · ${new Date(lb.authorTime * 1000).toLocaleString()}\n\n` +
        `\`${lb.sha.slice(0, 12)}\` ${escapeMd(lb.summary)}\n\n` +
        `[$(git-commit) Show in Log](command:geet.log.revealCommit?${revealArg}) · ` +
        `[$(copy) Copy sha](command:geet.log.copySha?${shaArg}) · ` +
        `[$(diff) Show Diff](command:geet.blame.showDiff?${diffArg})`,
    );
    return new vscode.Hover(md, new vscode.Range(pos.line, 0, pos.line, 0));
  }

  /** `geet.blame.showDiff` target — commit vs its parent for this file. */
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
    this.decorationType.dispose();
    for (const s of this.subs) s.dispose();
    for (const s of this.repoSubs.values()) s.dispose();
    this.repoSubs.clear();
    if (this.recomputeTimer) clearTimeout(this.recomputeTimer);
    if (this.headMoveTimer) clearTimeout(this.headMoveTimer);
  }
}

function escapeMd(s: string): string {
  return s.replace(/[\\`*_{}[\]()#+\-.!]/g, '\\$&');
}
