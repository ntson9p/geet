/**
 * Changed Files pane (P12-T3): a real FileTree over the selection's change
 * set — repo row (name + dim path, §2A's `demo-git  1 file  demo-git`) →
 * folder rows with `N files` counts → status-colored files. A multi-commit
 * selection shows the aggregate (`git diff <oldest>^..<newest>`), which is
 * how IntelliJ's "Compare Versions" reads; a file click opens the
 * range-scoped diff through the existing `geet-rev:` provider.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { CommitFileDto, LogChangedFilesDto } from '../../../src/shared/protocol';
import { FileTree } from '../lib/FileTree';
import {
  dirStatusColor,
  kindOf,
  statusColor,
  statusIcon,
  type StatusColorOverrides,
  type StatusKind,
} from '../lib/status';
import { ancestorDirs, buildTree, countFiles, selectionFollowing, type TreeNode } from '../lib/treeModel';
import { useElementSize } from '../lib/useElementSize';
import { diffChain } from './changedFilesChain';

const REPO_ROOT_PATH = '@repo';

export interface ChangedFilesPaneProps {
  data: LogChangedFilesDto | undefined;
  loading: boolean;
  repoLabel: string;
  repoRoot: string;
  /** true = folder tree, false = flat list. */
  grouped: boolean;
  colors?: StatusColorOverrides;
  /** Single-click preview mode (the pane toolbar's toggle). */
  previewOnClick: boolean;
  /**
   * `files` is what the diff walks through. `browsing`: the file came up because
   * the selection moved onto it, so the list keeps the keyboard.
   */
  onOpenFile: (file: CommitFileDto, files: readonly CommitFileDto[], browsing: boolean) => void;
  onSelectedFileChange: (file: CommitFileDto | undefined) => void;
  /** The diff moved to another file: the selection follows, without opening it again. */
  follow?: { readonly path: string };
  /** The file a diff opened from the pane is showing, whose row is marked. */
  onScreen?: string;
}

export function ChangedFilesPane({
  data,
  loading,
  repoLabel,
  repoRoot,
  grouped,
  colors,
  previewOnClick,
  onOpenFile,
  onSelectedFileChange,
  follow,
  onScreen,
}: ChangedFilesPaneProps) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [selection, setSelection] = useState<ReadonlySet<string>>(() => new Set());
  const [reveal, setReveal] = useState<{ readonly path: string } | undefined>(undefined);
  const [paneRef, paneSize] = useElementSize<HTMLDivElement>();

  const files = useMemo(() => data?.files ?? [], [data]);
  const byPath = useMemo(() => new Map(files.map((f) => [f.path, f])), [files]);

  const nodes = useMemo((): TreeNode[] => {
    if (files.length === 0) return [];
    if (!grouped) {
      // Flat: the repo row, then every file with its full path as the label.
      return [
        {
          kind: 'dir',
          path: REPO_ROOT_PATH,
          name: repoLabel,
          depth: 0,
          fileCount: files.length,
          children: files.map((f) => ({
            kind: 'file' as const,
            path: f.path,
            name: f.path,
            depth: 1,
          })),
        },
      ];
    }
    return buildTree(
      files.map((f) => f.path),
      { root: { path: REPO_ROOT_PATH, name: repoLabel } },
    );
  }, [files, grouped, repoLabel]);

  // Fully expanded on every new change set, like IntelliJ.
  useEffect(() => {
    const all = new Set<string>();
    const walk = (node: TreeNode): void => {
      if (node.kind !== 'dir') return;
      all.add(node.path);
      for (const c of node.children) walk(c);
    };
    for (const n of nodes) walk(n);
    setExpanded(all);
    setSelection(new Set());
    onSelectedFileChange(undefined);
  }, [nodes, onSelectedFileChange]);

  useEffect(() => {
    if (follow === undefined) return;
    const file = byPath.get(follow.path);
    if (!file) return;
    setExpanded((prev) => new Set([...prev, ...ancestorDirs(nodes, follow.path)]));
    const next = selectionFollowing(nodes, selection, follow.path);
    setSelection(next);
    setReveal({ path: follow.path });
    if (next.size === 1) onSelectedFileChange(file);
    // Only a move of the diff: `nodes` changing is a new change set, which starts unselected.
  }, [follow]);

  const dirKinds = useCallback(
    (node: TreeNode): ReadonlySet<StatusKind> => {
      const out = new Set<StatusKind>();
      if (node.kind !== 'dir') return out;
      if (node.path === REPO_ROOT_PATH) {
        for (const f of files) out.add(kindOf(f.status));
        return out;
      }
      const prefix = `${node.path}/`;
      for (const f of files) if (f.path.startsWith(prefix)) out.add(kindOf(f.status));
      return out;
    },
    [files],
  );

  const description = useCallback(
    (node: TreeNode): string | undefined => {
      if (node.kind === 'dir') {
        const n = node.path === REPO_ROOT_PATH ? files.length : countFiles(node);
        const count = `${n} file${n === 1 ? '' : 's'}`;
        // The §2A repo row: `demo-git  1 file  demo-git` — path as dim suffix.
        return node.path === REPO_ROOT_PATH ? `${count} · ${repoRoot}` : count;
      }
      const file = byPath.get(node.path);
      if (!file) return undefined;
      return file.origPath !== undefined ? `← ${file.origPath}` : undefined;
    },
    [byPath, files.length, repoRoot],
  );

  const icon = useCallback(
    (node: TreeNode) => {
      if (node.kind === 'dir') {
        if (node.path === REPO_ROOT_PATH) return { codicon: 'repo' };
        const color = dirStatusColor(dirKinds(node), colors);
        return color !== undefined ? { codicon: 'folder', color } : { codicon: 'folder' };
      }
      const file = byPath.get(node.path);
      if (!file) return { codicon: 'file' };
      const kind = kindOf(file.status);
      return { codicon: statusIcon(kind), color: statusColor(kind, colors) };
    },
    [byPath, colors, dirKinds],
  );

  const nameColor = useCallback(
    (node: TreeNode): string | undefined => {
      if (node.kind === 'dir') {
        if (node.path === REPO_ROOT_PATH) return undefined;
        return dirStatusColor(dirKinds(node), colors);
      }
      const file = byPath.get(node.path);
      return file ? statusColor(kindOf(file.status), colors) : undefined;
    },
    [byPath, colors, dirKinds],
  );

  if (loading) return <div className="gt-pane-empty gt-muted">Loading…</div>;
  if (!data) return <div className="gt-pane-empty gt-muted">Select a commit to see its files.</div>;
  if (files.length === 0) {
    return <div className="gt-pane-empty gt-muted" data-testid="changed-files-empty">No changed files.</div>;
  }

  return (
    <div className="gt-changed-files" ref={paneRef} data-testid="changed-files">
      <FileTree
        nodes={nodes}
        height={Math.max(0, paneSize.height)}
        ariaLabel="Changed files"
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
          const next = new Set(paths);
          setSelection(next);
          const only = paths.length === 1 ? byPath.get(paths[0] ?? '') : undefined;
          onSelectedFileChange(only);
          if (previewOnClick && only) onOpenFile(only, diffChain(nodes, byPath, next, only), true);
        }}
        onActivate={(node) => {
          const file = byPath.get(node.path);
          if (!file) return;
          onOpenFile(file, diffChain(nodes, byPath, selection, file), false);
          // Enter opens the keyboard's row, which the arrows moved without
          // selecting: the selection goes with the diff, as it does on a walk.
          const next = selectionFollowing(nodes, selection, file.path);
          if (next !== selection && !(selection.size === 1 && selection.has(file.path))) {
            setSelection(next);
            onSelectedFileChange(file);
          }
        }}
        description={description}
        icon={icon}
        nameColor={nameColor}
        {...(reveal !== undefined ? { reveal } : {})}
        {...(onScreen !== undefined ? { current: onScreen } : {})}
      />
    </div>
  );
}

/** `1 file` / `12 files` for the pane header. */
export function changedFilesLabel(data: LogChangedFilesDto | undefined): string {
  const n = data?.files.length ?? 0;
  return `${n} ${n === 1 ? 'file' : 'files'}`;
}
