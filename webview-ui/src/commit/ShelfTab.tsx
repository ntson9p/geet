/**
 * Shelf tab (P11-T6) — the `Commit | Shelf` strip's second tab (gap analysis
 * S13), hosting what the `gittree.shelf` tree view renders in native mode:
 * entries (name · time · N files · origin branch) expanding to their files.
 *
 * Every action dispatches through `commit/shelfAction` to the SAME
 * `gittree.shelf.*` commands the tree view runs, so the two surfaces cannot
 * drift. Context menus are VS Code-native (`data-vscode-context` +
 * `webview/context` contributions) — the labels are static, which is exactly
 * the case master §9 reserves native menus for.
 *
 * Integrity failures render inline on the row (warning icon + `damaged`),
 * never as a modal; the host refuses to unshelve a damaged entry.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  COMMIT_METHODS,
  type CommitShelfActionParamsDto,
  type CommitShelfEntryDto,
  type CommitShelfStateDto,
} from '../../../src/shared/protocol';
import { FileTree } from '../lib/FileTree';
import type { RpcClient } from '../lib/rpc';
import { statusColor, statusIcon, type StatusColorOverrides } from '../lib/status';
import { ToolbarButton } from '../lib/Toolbar';
import { ToolbarSeparator, ToolbarSpacer, ToolbarStrip } from '../lib/ToolbarStrip';
import type { TreeNode } from '../lib/treeModel';
import { useElementSize } from '../lib/useElementSize';
import { relativeTime } from './format';

/** NUL never appears in paths, so it makes an unambiguous identity separator. */
const SEP = '\u0000';

interface ShelfRef {
  repoRoot: string;
  entry: CommitShelfEntryDto;
  relPath?: string;
}

export interface ShelfTabProps {
  rpc: RpcClient;
  send: (method: string, params?: unknown) => void;
  /** P11-T8: status color overrides from the commit state. */
  colors?: StatusColorOverrides;
}

const EMPTY: CommitShelfStateDto = { repos: [], showUnshelved: false };

export function ShelfTab({ rpc, send, colors }: ShelfTabProps) {
  const [shelf, setShelf] = useState<CommitShelfStateDto>(EMPTY);
  const [ready, setReady] = useState(false);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [selection, setSelection] = useState<ReadonlySet<string>>(() => new Set());
  const [paneRef, paneSize] = useElementSize<HTMLDivElement>();

  useEffect(() => {
    const off = rpc.onEvent(COMMIT_METHODS.evtShelf, (p) => setShelf(p as CommitShelfStateDto));
    rpc.request<CommitShelfStateDto>(COMMIT_METHODS.shelfState).then(
      (next) => {
        setShelf(next ?? EMPTY);
        setReady(true);
      },
      () => setReady(true),
    );
    return off;
  }, [rpc]);

  const multiRepo = shelf.repos.length > 1;

  const { nodes, refs } = useMemo(() => {
    const out: TreeNode[] = [];
    const lookup = new Map<string, ShelfRef>();
    for (const repo of shelf.repos) {
      for (const entry of repo.entries) {
        const entryPath = `${repo.root}${SEP}${entry.id}`;
        lookup.set(entryPath, { repoRoot: repo.root, entry });
        const children: TreeNode[] = entry.files.map((f) => {
          const filePath = `${entryPath}${SEP}${f.relPath}`;
          lookup.set(filePath, { repoRoot: repo.root, entry, relPath: f.relPath });
          return {
            kind: 'file',
            path: filePath,
            name: f.relPath.split('/').pop() ?? f.relPath,
            depth: 1,
          };
        });
        out.push({
          kind: 'dir',
          path: entryPath,
          name: entry.name,
          depth: 0,
          children,
          fileCount: entry.files.length,
        });
      }
    }
    return { nodes: out, refs: lookup };
  }, [shelf]);

  /** The entry the toolbar acts on — a selected file row resolves to its entry. */
  const selectedRef = useMemo((): ShelfRef | undefined => {
    if (selection.size !== 1) return undefined;
    const [only] = [...selection];
    return only === undefined ? undefined : refs.get(only);
  }, [refs, selection]);

  const act = useCallback(
    (action: CommitShelfActionParamsDto['action'], ref?: ShelfRef) => {
      const params: CommitShelfActionParamsDto = {
        action,
        ...(ref !== undefined ? { repoRoot: ref.repoRoot, id: ref.entry.id } : {}),
        ...(ref?.relPath !== undefined ? { relPath: ref.relPath } : {}),
      };
      send(COMMIT_METHODS.shelfAction, params);
    },
    [send],
  );

  const description = useCallback(
    (node: TreeNode): string | undefined => {
      const ref = refs.get(node.path);
      if (!ref) return undefined;
      if (ref.relPath === undefined) {
        const e = ref.entry;
        const repo = multiRepo
          ? ` · ${shelf.repos.find((r) => r.root === ref.repoRoot)?.label ?? ''}`
          : '';
        const flags = `${e.unshelved ? ' · unshelved' : ''}${e.valid ? '' : ' · damaged'}`;
        const files = `${e.files.length} file${e.files.length === 1 ? '' : 's'}`;
        return `${relativeTime(e.createdAt, Date.now())} · ${files} · from ${e.branch}${repo}${flags}`;
      }
      const file = ref.entry.files.find((f) => f.relPath === ref.relPath);
      if (!file) return undefined;
      const dir = ref.relPath.includes('/')
        ? ref.relPath.slice(0, ref.relPath.lastIndexOf('/'))
        : '';
      return `${dir.length > 0 ? `${dir} · ` : ''}${file.status}${file.isBinary ? ' · binary' : ''}`;
    },
    [multiRepo, refs, shelf.repos],
  );

  const icon = useCallback(
    (node: TreeNode) => {
      const ref = refs.get(node.path);
      if (!ref) return undefined;
      if (ref.relPath === undefined) {
        if (!ref.entry.valid) {
          return { codicon: 'warning', color: 'var(--vscode-errorForeground)' };
        }
        return { codicon: ref.entry.unshelved ? 'check' : 'package' };
      }
      const file = ref.entry.files.find((f) => f.relPath === ref.relPath);
      if (!file) return { codicon: 'file' };
      return { codicon: statusIcon(file.status), color: statusColor(file.status, colors) };
    },
    [colors, refs],
  );

  const nameColor = useCallback(
    (node: TreeNode): string | undefined => {
      const ref = refs.get(node.path);
      const file = ref?.entry.files.find((f) => f.relPath === ref.relPath);
      return file ? statusColor(file.status, colors) : undefined;
    },
    [colors, refs],
  );

  const rowContext = useCallback(
    (node: TreeNode): Record<string, unknown> | undefined => {
      const ref = refs.get(node.path);
      if (!ref) return undefined;
      return {
        preventDefaultContextMenuItems: true,
        webviewSection: ref.relPath === undefined ? 'shelfEntry' : 'shelfFile',
        repoRoot: ref.repoRoot,
        shelfId: ref.entry.id,
        ...(ref.relPath !== undefined ? { relPath: ref.relPath } : {}),
      };
    },
    [refs],
  );

  const entrySelected = selectedRef !== undefined;

  return (
    <>
      <ToolbarStrip ariaLabel="Shelf actions">
        <ToolbarButton
          icon="cloud-upload"
          label="Unshelve…"
          disabled={!entrySelected}
          onClick={() => act('unshelve', selectedRef)}
        />
        <ToolbarButton
          icon="zap"
          label="Unshelve Silently"
          disabled={!entrySelected}
          onClick={() => act('unshelveSilently', selectedRef)}
        />
        <ToolbarButton
          icon="checklist"
          label="Unshelve Files…"
          disabled={!entrySelected}
          onClick={() => act('unshelveFiles', selectedRef)}
        />
        <ToolbarSeparator />
        <ToolbarButton
          icon="edit"
          label="Rename…"
          disabled={!entrySelected}
          onClick={() => act('rename', selectedRef)}
        />
        <ToolbarButton
          icon="trash"
          label="Delete"
          disabled={!entrySelected}
          onClick={() => act('delete', selectedRef)}
        />
        <ToolbarSeparator />
        <ToolbarButton icon="cloud-download" label="Import Patch…" onClick={() => act('import')} />
        <ToolbarSpacer />
        <ToolbarButton
          icon="eye"
          label="Show already unshelved"
          toggled={shelf.showUnshelved}
          onClick={() => act('toggleShowUnshelved')}
        />
      </ToolbarStrip>

      <div className="gt-commit-body" data-testid="shelf-tab">
        <div className="gt-commit-pane" ref={paneRef}>
          {ready && nodes.length === 0 ? (
            <div className="gt-commit-empty" data-testid="shelf-empty">
              No shelved changes. Use the Shelve Changes toolbar action on the Commit tab.
            </div>
          ) : (
            <FileTree
              nodes={nodes}
              height={Math.max(0, paneSize.height)}
              ariaLabel="Shelved changes"
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
              onSelectionChange={(paths) => setSelection(new Set(paths))}
              onActivate={(node) => {
                const ref = refs.get(node.path);
                if (ref?.relPath !== undefined) act('openDiff', ref);
              }}
              description={description}
              icon={icon}
              nameColor={nameColor}
              rowContext={rowContext}
            />
          )}
        </div>
      </div>
    </>
  );
}
