/**
 * The Push dialog's changes — IntelliJ's `PushLogChangesBrowser`: the merged
 * changes of the commits selected on the left (`zipChanges`), under a row per
 * repository with its `N files`, in folders (`Group By › Directory`) or flat.
 * IntelliJ's empty texts: `No commits selected`, and `No differences` when
 * the selected commits change nothing.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { CommitFileDto } from '../../../src/shared/protocol';
import { FileTree } from '../lib/FileTree';
import {
  dirStatusColor,
  kindOf,
  statusColor,
  statusIcon,
  type StatusColorOverrides,
  type StatusKind,
} from '../lib/status';
import { allDirPaths, buildTree, countFiles, type TreeNode } from '../lib/treeModel';
import { useElementSize } from '../lib/useElementSize';

/** One repository's part of the change set. */
export interface RepoChanges {
  readonly root: string;
  readonly label: string;
  readonly files: readonly CommitFileDto[];
}

/** A file row: which repository, and which of its files. */
export interface ChangedFileRef {
  readonly root: string;
  readonly file: CommitFileDto;
  /** Its place in that repository's list — where the diff sequence opens. */
  readonly index: number;
}

export interface PushChangesProps {
  repos: readonly RepoChanges[];
  /** Commits are selected on the left. */
  anySelected: boolean;
  loading: boolean;
  grouped: boolean;
  /** Bumped by Expand All / Collapse All. */
  expandRequest: { readonly all: boolean; readonly seq: number };
  colors?: StatusColorOverrides | undefined;
  onSelectedFilesChange: (files: ChangedFileRef[]) => void;
  onOpen: (file: ChangedFileRef) => void;
}

const prefixOf = (i: number): string => `@repo${i}`;

export function PushChanges({
  repos,
  anySelected,
  loading,
  grouped,
  expandRequest,
  colors,
  onSelectedFilesChange,
  onOpen,
}: PushChangesProps) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [selection, setSelection] = useState<ReadonlySet<string>>(() => new Set());
  const [paneRef, paneSize] = useElementSize<HTMLDivElement>();

  /** Node path → the file it is, for every file row. */
  const byPath = useMemo(() => {
    const map = new Map<string, ChangedFileRef>();
    repos.forEach((repo, i) => {
      repo.files.forEach((file, index) => {
        map.set(`${prefixOf(i)}/${file.path}`, { root: repo.root, file, index });
      });
    });
    return map;
  }, [repos]);

  const nodes = useMemo((): TreeNode[] => {
    const out: TreeNode[] = [];
    repos.forEach((repo, i) => {
      if (repo.files.length === 0) return;
      const prefix = prefixOf(i);
      if (grouped) {
        out.push(
          ...buildTree(
            repo.files.map((f) => f.path),
            { root: { path: prefix, name: repo.label }, pathPrefix: prefix },
          ),
        );
        return;
      }
      out.push({
        kind: 'dir',
        path: prefix,
        name: repo.label,
        depth: 0,
        fileCount: repo.files.length,
        children: [...repo.files]
          .sort((a, b) => a.path.localeCompare(b.path))
          .map((f) => ({ kind: 'file' as const, path: `${prefix}/${f.path}`, name: f.path, depth: 1 })),
      });
    });
    return out;
  }, [grouped, repos]);

  // A new change set opens fully expanded, as IntelliJ's does.
  useEffect(() => {
    setExpanded(new Set(allDirPaths(nodes)));
    setSelection(new Set());
    onSelectedFilesChange([]);
  }, [nodes, onSelectedFilesChange]);

  useEffect(() => {
    if (expandRequest.seq === 0) return;
    setExpanded(new Set(expandRequest.all ? allDirPaths(nodes) : []));
    // Only a new request expands or collapses; a new change set has its own rule.
  }, [expandRequest.seq]);

  const filesUnder = useCallback(
    (node: TreeNode): CommitFileDto[] => {
      if (node.kind !== 'dir') return [];
      const prefix = `${node.path}/`;
      const out: CommitFileDto[] = [];
      for (const [path, ref] of byPath) if (path.startsWith(prefix)) out.push(ref.file);
      return out;
    },
    [byPath],
  );

  const dirKinds = useCallback(
    (node: TreeNode): ReadonlySet<StatusKind> =>
      new Set(filesUnder(node).map((f) => kindOf(f.status))),
    [filesUnder],
  );

  const isRepoNode = (node: TreeNode): boolean => /^@repo\d+$/.test(node.path);

  if (!anySelected) {
    return (
      <div className="gt-pane-empty gt-muted" data-testid="push-changes-empty">
        No commits selected
      </div>
    );
  }
  if (loading && nodes.length === 0) return <div className="gt-pane-empty gt-muted">Loading…</div>;
  if (nodes.length === 0) {
    return (
      <div className="gt-pane-empty gt-muted" data-testid="push-changes-empty">
        No differences
      </div>
    );
  }

  return (
    <div className="gt-changed-files" ref={paneRef} data-testid="push-files">
      <FileTree
        nodes={nodes}
        height={Math.max(0, paneSize.height)}
        ariaLabel="Changes"
        expanded={expanded}
        onToggleExpand={(path, open) => {
          setExpanded((prev) => {
            const next = new Set(prev);
            if (open) next.add(path);
            else next.delete(path);
            return next;
          });
        }}
        selection={selection}
        onSelectionChange={(paths) => {
          setSelection(new Set(paths));
          onSelectedFilesChange(
            paths.map((p) => byPath.get(p)).filter((f): f is ChangedFileRef => f !== undefined),
          );
        }}
        onActivate={(node) => {
          const ref = byPath.get(node.path);
          if (ref) onOpen(ref);
        }}
        description={(node) => {
          if (node.kind === 'dir') {
            const n = countFiles(node);
            return `${n} file${n === 1 ? '' : 's'}`;
          }
          const ref = byPath.get(node.path);
          return ref?.file.origPath !== undefined ? `← ${ref.file.origPath}` : undefined;
        }}
        icon={(node) => {
          if (node.kind === 'dir') {
            if (isRepoNode(node)) return { codicon: 'repo' };
            const color = dirStatusColor(dirKinds(node), colors);
            return color !== undefined ? { codicon: 'folder', color } : { codicon: 'folder' };
          }
          const ref = byPath.get(node.path);
          if (!ref) return { codicon: 'file' };
          const kind = kindOf(ref.file.status);
          return { codicon: statusIcon(kind), color: statusColor(kind, colors) };
        }}
        nameColor={(node) => {
          if (node.kind === 'dir') return isRepoNode(node) ? undefined : dirStatusColor(dirKinds(node), colors);
          const ref = byPath.get(node.path);
          return ref ? statusColor(kindOf(ref.file.status), colors) : undefined;
        }}
      />
    </div>
  );
}
