/**
 * Stash tab (POST-P14l) — the `Commit | Shelf | Stash` strip's third tab.
 * JetBrains keeps stashes in a `Stash` tab of the Commit tool window beside
 * `Shelf` (Settings | Version Control | Git | Stash · *Combine stashes and
 * shelves in one tab* merges the two, off by default), which is why this
 * replaces the `gittree.stashes` sidebar pane rather than extending it.
 *
 * Rows are `stash@{N} · message`, expanding to the stashed files; activating a
 * file diffs it against the working tree, which is what the tree view did.
 * Every action dispatches through `commit/stashAction` to the SAME
 * `gittree.stash.*` commands, so the two surfaces cannot drift.
 *
 * Actions carry the stash **sha**, never `stash@{N}`: the index shifts under
 * the list whenever a stash is pushed or dropped, so a row acted on after the
 * list moved would otherwise hit a different stash.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  COMMIT_METHODS,
  type CommitStashActionParamsDto,
  type CommitStashEntryDto,
  type CommitStashFileDto,
  type CommitStashStateDto,
  type LogDateFormat,
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

/** Placeholder child: `expandable` needs one, and the fetch runs on expand. */
const PENDING = '\u0000pending';

interface StashRef {
  repoRoot: string;
  entry: CommitStashEntryDto;
  relPath?: string;
}

export interface StashTabProps {
  rpc: RpcClient;
  send: (method: string, params?: unknown) => void;
  colors?: StatusColorOverrides;
  /** Rendered inside the Shelf tab when `combineWithShelf` is on. */
  embedded?: boolean;
  /** `gittree.log.dateFormat`: an entry older than a day gives its date as the log does. */
  dateFormat?: LogDateFormat | undefined;
}

export const EMPTY_STASH: CommitStashStateDto = { repos: [], combined: false };

export function StashTab({ rpc, send, colors, embedded, dateFormat }: StashTabProps) {
  const [stash, setStash] = useState<CommitStashStateDto>(EMPTY_STASH);
  const [ready, setReady] = useState(false);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [selection, setSelection] = useState<ReadonlySet<string>>(() => new Set());
  /** `${root}\0${sha}` → its files, once read. */
  const [files, setFiles] = useState<ReadonlyMap<string, CommitStashFileDto[]>>(() => new Map());
  const [paneRef, paneSize] = useElementSize<HTMLDivElement>();

  useEffect(() => {
    const off = rpc.onEvent(COMMIT_METHODS.evtStash, (p) => {
      setStash(p as CommitStashStateDto);
      // The list moved, so every cached file list may describe a stash that no
      // longer sits where it did. Re-read on the next expand rather than
      // rendering a stale one.
      setFiles(new Map());
    });
    rpc.request<CommitStashStateDto>(COMMIT_METHODS.stashState).then(
      (next) => {
        setStash(next ?? EMPTY_STASH);
        setReady(true);
      },
      () => setReady(true),
    );
    return off;
  }, [rpc]);

  const multiRepo = stash.repos.length > 1;

  const { nodes, refs } = useMemo(() => {
    const out: TreeNode[] = [];
    const lookup = new Map<string, StashRef>();
    for (const repo of stash.repos) {
      for (const entry of repo.entries) {
        const entryPath = `${repo.root}${SEP}${entry.sha}`;
        lookup.set(entryPath, { repoRoot: repo.root, entry });
        const known = files.get(entryPath);
        const children: TreeNode[] =
          known === undefined
            ? [{ kind: 'file', path: `${entryPath}${PENDING}`, name: 'Loading…', depth: 1 }]
            : known.map((f) => {
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
          name: `${entry.selector} · ${entry.message}`,
          depth: 0,
          children,
          fileCount: known?.length ?? 0,
        });
      }
    }
    return { nodes: out, refs: lookup };
  }, [files, stash]);

  /** The entry the toolbar acts on — a selected file row resolves to its entry. */
  const selectedRef = useMemo((): StashRef | undefined => {
    if (selection.size !== 1) return undefined;
    const [only] = [...selection];
    return only === undefined ? undefined : refs.get(only);
  }, [refs, selection]);

  const act = useCallback(
    (action: CommitStashActionParamsDto['action'], ref?: StashRef) => {
      const params: CommitStashActionParamsDto = {
        action,
        ...(ref !== undefined ? { repoRoot: ref.repoRoot, sha: ref.entry.sha } : {}),
        ...(ref?.relPath !== undefined ? { relPath: ref.relPath } : {}),
      };
      send(COMMIT_METHODS.stashAction, params);
    },
    [send],
  );

  /** Files are read on expand — `git stash show` costs a git run per stash. */
  const loadFiles = useCallback(
    (entryPath: string) => {
      const ref = refs.get(entryPath);
      if (!ref || files.has(entryPath)) return;
      void rpc
        .request<{ files: CommitStashFileDto[] }>(COMMIT_METHODS.stashFiles, {
          repoRoot: ref.repoRoot,
          sha: ref.entry.sha,
        })
        .then((res) => {
          setFiles((prev) => new Map(prev).set(entryPath, res?.files ?? []));
        });
    },
    [files, refs, rpc],
  );

  const description = useCallback(
    (node: TreeNode): string | undefined => {
      const ref = refs.get(node.path);
      if (!ref) return undefined;
      if (ref.relPath === undefined) {
        const e = ref.entry;
        const repo = multiRepo
          ? ` · ${stash.repos.find((r) => r.root === ref.repoRoot)?.label ?? ''}`
          : '';
        const from = e.branch !== undefined ? ` · from ${e.branch}` : '';
        return `${relativeTime(e.createdAt, Date.now(), dateFormat)}${from}${repo}`;
      }
      const file = files.get(`${ref.repoRoot}${SEP}${ref.entry.sha}`)?.find(
        (f) => f.relPath === ref.relPath,
      );
      if (!file) return undefined;
      const dir = ref.relPath.includes('/')
        ? ref.relPath.slice(0, ref.relPath.lastIndexOf('/'))
        : '';
      return `${dir.length > 0 ? `${dir} · ` : ''}${file.status}`;
    },
    [files, multiRepo, refs, stash.repos],
  );

  const icon = useCallback(
    (node: TreeNode) => {
      const ref = refs.get(node.path);
      if (!ref) return undefined;
      if (ref.relPath === undefined) return { codicon: 'archive' };
      const file = files
        .get(`${ref.repoRoot}${SEP}${ref.entry.sha}`)
        ?.find((f) => f.relPath === ref.relPath);
      if (!file) return { codicon: 'file' };
      return { codicon: statusIcon(file.status), color: statusColor(file.status, colors) };
    },
    [colors, files, refs],
  );

  const rowContext = useCallback(
    (node: TreeNode): Record<string, unknown> | undefined => {
      const ref = refs.get(node.path);
      if (!ref) return undefined;
      return {
        preventDefaultContextMenuItems: true,
        webviewSection: ref.relPath === undefined ? 'stashEntry' : 'stashFile',
        repoRoot: ref.repoRoot,
        stashSha: ref.entry.sha,
        ...(ref.relPath !== undefined ? { relPath: ref.relPath } : {}),
      };
    },
    [refs],
  );

  const entrySelected = selectedRef !== undefined;

  return (
    <>
      <ToolbarStrip ariaLabel="Stash actions">
        <ToolbarButton icon="add" label="Stash Changes…" onClick={() => act('push')} />
        <ToolbarSeparator />
        <ToolbarButton
          icon="cloud-download"
          label="Apply Stash"
          disabled={!entrySelected}
          onClick={() => act('apply', selectedRef)}
        />
        <ToolbarButton
          icon="zap"
          label="Pop Stash"
          disabled={!entrySelected}
          onClick={() => act('pop', selectedRef)}
        />
        <ToolbarButton
          icon="git-branch"
          label="Unstash to New Branch…"
          disabled={!entrySelected}
          onClick={() => act('branch', selectedRef)}
        />
        <ToolbarSeparator />
        <ToolbarButton
          icon="diff"
          label="Show Diff"
          disabled={!entrySelected}
          onClick={() => act('diffAll', selectedRef)}
        />
        <ToolbarButton
          icon="trash"
          label="Drop Stash"
          disabled={!entrySelected}
          onClick={() => act('drop', selectedRef)}
        />
        <ToolbarSpacer />
        <ToolbarButton icon="clear-all" label="Clear Stashes" onClick={() => act('clear')} />
      </ToolbarStrip>

      <div className={embedded ? 'gt-commit-subpane' : 'gt-commit-body'} data-testid="stash-tab">
        <div className="gt-commit-pane" ref={paneRef}>
          {ready && nodes.length === 0 ? (
            <div className="gt-commit-empty" data-testid="stash-empty">
              No stashes. Use Stash Changes… to create one.
            </div>
          ) : (
            <FileTree
              nodes={nodes}
              height={Math.max(0, paneSize.height)}
              ariaLabel="Stashes"
              expanded={expanded}
              onToggleExpand={(path, open) => {
                if (open) loadFiles(path);
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
                if (ref?.relPath !== undefined) act('openFileDiff', ref);
              }}
              description={description}
              icon={icon}
              rowContext={rowContext}
            />
          )}
        </div>
      </div>
    </>
  );
}
