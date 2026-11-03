/**
 * The diff sequence registry (P14-T7).
 *
 * VS Code's diff editor knows two documents and nothing else, which is exactly
 * why its "next change" wraps to the top of the same file when you run off the
 * end. GitTree opens the diffs, so it knows the *sequence* they belong to — a
 * commit's changed files, a comparison, a stash's contents. Registering that
 * sequence here is the entire trick behind cross-file navigation.
 *
 * A sequence is recovered from whatever diff is on screen rather than tracked
 * as "current": `TabInputTextDiff` exposes both URIs, so the open tab
 * identifies itself and nothing has to stay in sync with the user's clicking.
 */
import * as vscode from 'vscode';
import { positionedTitle } from './navigationStep';

export interface DiffEntry {
  readonly original: vscode.Uri;
  readonly modified: vscode.Uri;
  readonly title: string;
  /** What the hint calls this file: its path. The title, without one. */
  readonly label?: string;
  /** Known from the list to have no text change, so nothing has to be read to skip it. */
  readonly identical?: boolean;
  /** Which file this is, for an entry whose sides can change. Its two URIs, without one. */
  readonly key?: string;
  /**
   * What to show for this file now, for a side that can change under a list read
   * earlier: a file in the working tree can be gone, or not be text.
   */
  readonly settle?: () => Promise<DiffEntry>;
  /** Navigation brought this file up, so the list it came from can follow. */
  readonly onShown?: () => void;
  /**
   * Its diff came on screen (`true`) or left it, so the list it came from can mark
   * the file: by navigation, by a click in the list, or by a tab brought forward.
   * The entry leaving is told before the one coming.
   */
  readonly onScreen?: (showing: boolean) => void;
}

export interface OpenDiffOptions {
  /** Leave focus where it is: the list is being browsed, not left. */
  readonly preserveFocus?: boolean;
  /**
   * Names a sequence that stands for a list which goes on changing. Opening under
   * the same name replaces it, and `update` keeps it current.
   */
  readonly id?: string;
}

interface DiffSequence {
  readonly id?: string;
  entries: DiffEntry[];
  /** `pairKey` → position; a commit can hold thousands of files, and this runs on every tab change. */
  positions: Map<string, number>;
}

export interface ActiveDiff {
  readonly sequence: DiffSequence;
  readonly entries: readonly DiffEntry[];
  readonly index: number;
}

/** Bounded: a session is only interesting while its tabs are reachable. */
const MAX_SEQUENCES = 8;

export class DiffSessionRegistry implements vscode.Disposable {
  private readonly sequences: DiffSequence[] = [];
  private readonly subs: vscode.Disposable[] = [];
  private readonly changed = new vscode.EventEmitter<void>();
  /** Fires when the diff on screen becomes, or stops being, another position of a sequence. */
  readonly onDidChangeActive = this.changed.event;
  private lastActive: string | undefined;
  /** The entry whose diff is on screen, as its list was last told. */
  private onScreen: DiffEntry | undefined;
  /** When a diff was last brought up, since VS Code computes it after showing it. */
  private shownAt = 0;

  constructor() {
    // The toolbar controls are scoped to GitTree's own diffs, so the context
    // keys have to follow the active tab rather than the last command.
    this.subs.push(
      vscode.window.tabGroups.onDidChangeTabs(() => this.sync()),
      vscode.window.tabGroups.onDidChangeTabGroups(() => this.sync()),
      vscode.window.onDidChangeActiveTextEditor(() => this.sync()),
    );
    this.sync();
  }

  private sync(): void {
    const active = this.active();
    this.mark(active ? entryAt(active) : undefined);
    const key = active ? `${active.index}/${active.entries.length} ${pairKey(entryAt(active))}` : undefined;
    if (key === this.lastActive) return;
    this.lastActive = key;
    const setContext = (name: string, value: boolean): void => {
      void vscode.commands.executeCommand('setContext', name, value);
    };
    setContext('gittree.diff.active', active !== undefined);
    setContext('gittree.diff.hasPrevFile', active !== undefined && active.index > 0);
    setContext(
      'gittree.diff.hasNextFile',
      active !== undefined && active.index < active.entries.length - 1,
    );
    this.changed.fire();
  }

  /**
   * The diff the arrows act on is the one on screen. A list read again, or a file
   * opened again, hands over a new entry for the same file: its list is told that
   * one left and the other came, and ends where it was.
   */
  private mark(entry: DiffEntry | undefined): void {
    if (entry === this.onScreen) return;
    const before = this.onScreen;
    this.onScreen = entry;
    before?.onScreen?.(false);
    entry?.onScreen?.(true);
  }

  /** Opens `entries[index]` and remembers the sequence it came from. */
  async open(
    entries: readonly DiffEntry[],
    index: number,
    options: OpenDiffOptions = {},
  ): Promise<void> {
    if (!entries[index]) return;
    const sequence = this.remember(entries, options.id);
    const entry = await this.settled(sequence, sequence.entries[index]!);
    await this.show(entry, index, sequence.entries.length, options.preserveFocus === true);
    // Reopening the file already on screen changes no tab, and a list that has
    // since changed may still have moved it.
    this.sync();
  }

  /**
   * Another position of the sequence on screen, in the same preview tab, with the
   * cursor on `line` whatever the file's view state says.
   */
  async moveTo(active: ActiveDiff, entry: DiffEntry, index: number, line = 0): Promise<void> {
    await this.show(entry, index, active.entries.length, false, new vscode.Range(line, 0, line, 0));
    entry.onShown?.();
  }

  /** What to show for an entry now. A diff of it found on screen stays this sequence's. */
  async settled(sequence: DiffSequence, entry: DiffEntry): Promise<DiffEntry> {
    if (entry.settle === undefined) return entry;
    const now = await entry.settle();
    const at = sequence.entries.findIndex((e) => entryKey(e) === entryKey(now));
    if (at >= 0) {
      sequence.entries[at] = now;
      sequence.positions.set(pairKey(now), at);
    }
    return now;
  }

  /**
   * The list behind a named sequence changed. A file on screen that has left the
   * list stays in it where it was, since a file nobody can walk away from is no
   * use to anyone reverting its last change: IntelliJ keeps it up too.
   */
  update(id: string, entries: readonly DiffEntry[]): void {
    const sequence = this.sequences.find((s) => s.id === id);
    if (!sequence) return;
    const active = this.active();
    const shown = active?.sequence === sequence ? entryAt(active) : undefined;
    const next = entries.map((e) => (shown && entryKey(e) === entryKey(shown) ? shown : e));
    if (active && shown && !next.includes(shown)) {
      next.splice(Math.min(active.index, next.length), 0, shown);
    }
    sequence.entries = next;
    sequence.positions = positionsOf(next);
    this.sync();
  }

  /** How long ago a diff was brought up. */
  msSinceShown(): number {
    return Date.now() - this.shownAt;
  }

  private async show(
    entry: DiffEntry,
    index: number,
    total: number,
    preserveFocus: boolean,
    selection?: vscode.Range,
  ): Promise<void> {
    this.shownAt = Date.now();
    await vscode.commands.executeCommand(
      'vscode.diff',
      entry.original,
      entry.modified,
      positionedTitle(entry.title, index, total),
      {
        // Walking a commit replaces the one tab, as IntelliJ's viewer does,
        // rather than leaving one behind per file. Pinning it keeps it.
        preview: true,
        preserveFocus,
        ...(selection !== undefined ? { selection } : {}),
        // The text diff, whatever the file. By its name a `.png` would go to the
        // image viewer, which cannot read `gittree-rev:` and shows an error page
        // with no toolbar, and that would be the end of the walk. Not in the
        // public typings; VS Code's own `TextEditorOpenOptions` reads it.
        override: true,
      } satisfies vscode.TextDocumentShowOptions & { override: boolean },
    );
  }

  private remember(entries: readonly DiffEntry[], id: string | undefined): DiffSequence {
    const key = sequenceKey(entries);
    const existing = this.sequences.findIndex((s) =>
      id !== undefined ? s.id === id : s.id === undefined && sequenceKey(s.entries) === key,
    );
    if (existing >= 0) this.sequences.splice(existing, 1);
    const sequence: DiffSequence = {
      entries: [...entries],
      positions: positionsOf(entries),
      ...(id !== undefined ? { id } : {}),
    };
    this.sequences.unshift(sequence);
    while (this.sequences.length > MAX_SEQUENCES) this.sequences.pop();
    return sequence;
  }

  /** The sequence and position of the diff currently on screen, if it is ours. */
  active(): ActiveDiff | undefined {
    const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
    if (!tab || !(tab.input instanceof vscode.TabInputTextDiff)) return undefined;
    const pair = pairKey(tab.input);
    for (const sequence of this.sequences) {
      const index = sequence.positions.get(pair);
      if (index !== undefined) return { sequence, entries: sequence.entries, index };
    }
    return undefined;
  }

  dispose(): void {
    for (const s of this.subs) s.dispose();
    this.changed.dispose();
    this.sequences.length = 0;
  }
}

export function entryAt(active: ActiveDiff): DiffEntry {
  return active.entries[active.index]!;
}

/**
 * A URI as VS Code identifies a file. Paths are case-insensitive on Windows and
 * macOS, where it keeps the casing it saw first, so a tab can hold a working-tree
 * file under another casing than the one git reported and the entry was built with.
 */
export function uriKey(uri: vscode.Uri): string {
  const text = uri.toString();
  return uri.scheme === 'file' && process.platform !== 'linux' ? text.toLowerCase() : text;
}

function pairKey(pair: { readonly original: vscode.Uri; readonly modified: vscode.Uri }): string {
  return `${uriKey(pair.original)}\n${uriKey(pair.modified)}`;
}

function entryKey(entry: DiffEntry): string {
  return entry.key ?? pairKey(entry);
}

function positionsOf(entries: readonly DiffEntry[]): Map<string, number> {
  return new Map(entries.map((e, i) => [pairKey(e), i]));
}

function sequenceKey(entries: readonly DiffEntry[]): string {
  return entries.map(pairKey).join('\n');
}
