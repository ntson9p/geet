/**
 * `gittree-snap:` — read-only Local History snapshot content (master §2
 * virtual documents; P9-T3). URIs carry the repo root, snapshot id and
 * repo-relative path; content is served from the SnapshotStore.
 */
import * as vscode from 'vscode';
import type { SnapshotStore } from '../../localHistory/snapshotStore';

export const SNAP_SCHEME = 'gittree-snap';

export interface SnapQuery {
  repo: string;
  id: string;
  rel: string;
}

export function makeSnapUri(repoRoot: string, snapshotId: string, relPath: string): vscode.Uri {
  const rel = relPath.replace(/\\/g, '/');
  const query: SnapQuery = { repo: repoRoot, id: snapshotId, rel };
  return vscode.Uri.from({
    scheme: SNAP_SCHEME,
    path: '/' + rel,
    query: JSON.stringify(query),
  });
}

export function parseSnapUri(uri: vscode.Uri): SnapQuery | undefined {
  if (uri.scheme !== SNAP_SCHEME) return undefined;
  try {
    const q = JSON.parse(uri.query) as SnapQuery;
    if (typeof q.repo !== 'string' || typeof q.id !== 'string' || typeof q.rel !== 'string') {
      return undefined;
    }
    return q;
  } catch {
    return undefined;
  }
}

export class SnapContentProvider implements vscode.TextDocumentContentProvider {
  constructor(private readonly storeFor: (repoRoot: string) => SnapshotStore | undefined) {}

  provideTextDocumentContent(uri: vscode.Uri): string {
    const q = parseSnapUri(uri);
    if (!q) return '';
    const store = this.storeFor(q.repo);
    const bytes = store?.read(q.id, q.rel);
    return bytes ? bytes.toString('utf8') : '';
  }
}
