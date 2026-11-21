/**
 * `geet-merge:` — writable in-memory result documents for the Tri-Editor
 * (master §2 virtual documents; P6-T3). The center "Result" pane edits one
 * of these; the URI path mirrors the real file path so language detection
 * (and with it LSP features — the spec's hard requirement) works from the
 * extension alone. Content lives only for the duration of a merge session.
 */
import * as vscode from 'vscode';

export const MERGE_SCHEME = 'geet-merge';

export interface MergeQuery {
  repo: string;
  rel: string;
}

export function makeMergeUri(repoRoot: string, relPath: string): vscode.Uri {
  const rel = relPath.replace(/\\/g, '/');
  const query: MergeQuery = { repo: repoRoot, rel };
  return vscode.Uri.from({
    scheme: MERGE_SCHEME,
    path: '/' + rel,
    query: JSON.stringify(query),
  });
}

export function parseMergeUri(uri: vscode.Uri): MergeQuery | undefined {
  if (uri.scheme !== MERGE_SCHEME) return undefined;
  try {
    const q = JSON.parse(uri.query) as MergeQuery;
    if (typeof q.repo !== 'string' || typeof q.rel !== 'string') return undefined;
    return q;
  } catch {
    return undefined;
  }
}

interface Entry {
  bytes: Uint8Array;
  ctime: number;
  mtime: number;
}

export class MergeFsProvider implements vscode.FileSystemProvider {
  private readonly files = new Map<string, Entry>();
  private readonly _onDidChangeFile = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this._onDidChangeFile.event;

  /** Host API: create or replace a result document's content. */
  seed(uri: vscode.Uri, text: string): void {
    const key = uri.toString();
    const existed = this.files.has(key);
    const now = Date.now();
    this.files.set(key, {
      bytes: new TextEncoder().encode(text),
      ctime: this.files.get(key)?.ctime ?? now,
      mtime: now,
    });
    this._onDidChangeFile.fire([
      { type: existed ? vscode.FileChangeType.Changed : vscode.FileChangeType.Created, uri },
    ]);
  }

  /** Host API: drop a result document when its session ends. */
  drop(uri: vscode.Uri): void {
    if (this.files.delete(uri.toString())) {
      this._onDidChangeFile.fire([{ type: vscode.FileChangeType.Deleted, uri }]);
    }
  }

  watch(): vscode.Disposable {
    return new vscode.Disposable(() => undefined);
  }

  stat(uri: vscode.Uri): vscode.FileStat {
    const entry = this.files.get(uri.toString());
    if (!entry) throw vscode.FileSystemError.FileNotFound(uri);
    return {
      type: vscode.FileType.File,
      ctime: entry.ctime,
      mtime: entry.mtime,
      size: entry.bytes.byteLength,
    };
  }

  readFile(uri: vscode.Uri): Uint8Array {
    const entry = this.files.get(uri.toString());
    if (!entry) throw vscode.FileSystemError.FileNotFound(uri);
    return entry.bytes;
  }

  writeFile(
    uri: vscode.Uri,
    content: Uint8Array,
    options: { create: boolean; overwrite: boolean },
  ): void {
    const key = uri.toString();
    const existing = this.files.get(key);
    if (!existing && !options.create) throw vscode.FileSystemError.FileNotFound(uri);
    if (existing && options.create && !options.overwrite) {
      throw vscode.FileSystemError.FileExists(uri);
    }
    const now = Date.now();
    this.files.set(key, { bytes: content, ctime: existing?.ctime ?? now, mtime: now });
    this._onDidChangeFile.fire([
      { type: existing ? vscode.FileChangeType.Changed : vscode.FileChangeType.Created, uri },
    ]);
  }

  readDirectory(): [string, vscode.FileType][] {
    return [];
  }

  createDirectory(): void {
    // Directories are implicit — result docs are flat entries keyed by URI.
  }

  delete(uri: vscode.Uri): void {
    this.drop(uri);
  }

  rename(oldUri: vscode.Uri): void {
    throw vscode.FileSystemError.NoPermissions(oldUri);
  }

  dispose(): void {
    this._onDidChangeFile.dispose();
    this.files.clear();
  }
}
