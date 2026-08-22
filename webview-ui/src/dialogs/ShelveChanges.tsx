/**
 * Shelve Changes dialog (P11-T7) — the §2A layout: toolbar (expand/collapse,
 * refresh, preview) → `Changelist: [ ▾]` → checkbox FileTree → `N modified` →
 * commit message → collapsible `∨ Diff` with per-change include checkboxes →
 * `[Shelve Changes] [Cancel]`, plus the remove-from-worktree footer option
 * (the store capability IntelliJ puts behind the same dialog).
 *
 * Per-change semantics mirror the commit window (P11-T3): a selection covering
 * everything is no selection, excluding the last change unticks the file, and
 * every selection carries the signature the host re-checks at accept time.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  SHELVE_DIALOG_METHODS,
  type ShelveDialogParamsDto,
  type ShelveDialogPartialDto,
  type ShelveDialogResultDto,
  type ShelveFileDiffDto,
} from '../../../src/shared/protocol';
import { Dialog } from '../lib/Dialog';
import { FileTree } from '../lib/FileTree';
import { InlineDiff } from '../lib/InlineDiff';
import { ToolbarButton } from '../lib/Toolbar';
import { ToolbarSeparator, ToolbarSpacer, ToolbarStrip } from '../lib/ToolbarStrip';
import { buildTree, allDirPaths, countFiles, type ToggleDelta, type TreeNode } from '../lib/treeModel';
import { useDialog } from '../lib/useDialog';
import { useElementSize } from '../lib/useElementSize';
import { getVsCodeApi } from '../lib/vscodeApi';

interface Selection {
  included: number[];
  total: number;
  signature: string;
}

interface Persisted {
  diffOpen?: boolean;
}

export function ShelveChanges() {
  const { init, error, accept, cancel, rpc } = useDialog<ShelveDialogParamsDto, ShelveDialogResultDto>();
  const api = useMemo(() => getVsCodeApi(), []);
  const saved = (api.getState() as Persisted | undefined) ?? {};

  const [params, setParams] = useState<ShelveDialogParamsDto | undefined>(undefined);
  const [listId, setListId] = useState<string>('');
  const [checked, setChecked] = useState<ReadonlySet<string>>(() => new Set());
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [selection, setSelection] = useState<ReadonlySet<string>>(() => new Set());
  const [selections, setSelections] = useState<ReadonlyMap<string, Selection>>(() => new Map());
  const [message, setMessage] = useState('');
  const [diffOpen, setDiffOpen] = useState(saved.diffOpen ?? false);
  const [diff, setDiff] = useState<ShelveFileDiffDto | undefined>(undefined);
  const [removeFromWorktree, setRemoveFromWorktree] = useState(true);
  const [treeRef, treeSize] = useElementSize<HTMLDivElement>();
  const [diffRef, diffSize] = useElementSize<HTMLDivElement>();

  /** Adopt fresh params: reset everything to all-ticked, keep the message. */
  const adopt = useCallback((next: ShelveDialogParamsDto, keepMessage?: string) => {
    setParams(next);
    setListId(next.listId);
    const list = next.lists.find((l) => l.id === next.listId);
    setChecked(new Set((list?.files ?? []).map((f) => f.path)));
    setSelections(new Map());
    setSelection(new Set());
    setMessage(keepMessage !== undefined && keepMessage.length > 0 ? keepMessage : next.message);
  }, []);

  useEffect(() => {
    if (init) adopt(init.params);
  }, [adopt, init]);

  useEffect(() => {
    api.setState({ diffOpen } satisfies Persisted);
  }, [api, diffOpen]);

  const list = params?.lists.find((l) => l.id === listId);
  const files = useMemo(() => list?.files ?? [], [list]);
  const byPath = useMemo(() => new Map(files.map((f) => [f.path, f])), [files]);
  const nodes = useMemo(() => buildTree(files.map((f) => f.path)), [files]);

  // Open with every folder expanded, like the commit window.
  useEffect(() => {
    setExpanded(new Set(allDirPaths(nodes)));
  }, [nodes]);

  const pickList = useCallback(
    (nextId: string) => {
      if (!params) return;
      setListId(nextId);
      const next = params.lists.find((l) => l.id === nextId);
      setChecked(new Set((next?.files ?? []).map((f) => f.path)));
      setSelections(new Map());
      setSelection(new Set());
      setDiff(undefined);
    },
    [params],
  );

  const onToggleCheck = useCallback((delta: ToggleDelta) => {
    setChecked((prev) => {
      const next = new Set(prev);
      for (const p of delta.paths) {
        if (delta.next) next.add(p);
        else next.delete(p);
      }
      return next;
    });
    // Unticking a file discards its per-change selection (commit-window rule).
    if (!delta.next) {
      setSelections((prev) => {
        const next = new Map(prev);
        for (const p of delta.paths) next.delete(p);
        return next;
      });
    }
  }, []);

  // ---- diff section ---------------------------------------------------------

  const selectedPath = useMemo(() => {
    if (selection.size !== 1) return undefined;
    const [only] = [...selection];
    return only !== undefined && byPath.has(only) ? only : undefined;
  }, [byPath, selection]);

  useEffect(() => {
    if (!diffOpen || selectedPath === undefined) {
      setDiff(undefined);
      return;
    }
    let cancelled = false;
    rpc
      .request<ShelveFileDiffDto>(SHELVE_DIALOG_METHODS.fileDiff, { relPath: selectedPath })
      .then(
        (next) => {
          if (!cancelled) setDiff(next);
        },
        () => {
          if (!cancelled) setDiff(undefined);
        },
      );
    return () => {
      cancelled = true;
    };
  }, [diffOpen, rpc, selectedPath]);

  const includedSet = useMemo(() => {
    if (!diff) return new Set<number>();
    if (!checked.has(diff.path)) return new Set<number>();
    const sel = selections.get(diff.path);
    return new Set(sel ? sel.included : diff.changes.map((_, i) => i));
  }, [checked, diff, selections]);

  const onToggleInclude = useCallback(
    (index: number, nextOn: boolean) => {
      if (!diff) return;
      const next = new Set(includedSet);
      if (nextOn) next.add(index);
      else next.delete(index);
      const included = [...next].sort((a, b) => a - b);
      setSelections((prev) => {
        const out = new Map(prev);
        if (included.length === 0 || included.length >= diff.changes.length) {
          out.delete(diff.path);
        } else {
          out.set(diff.path, { included, total: diff.changes.length, signature: diff.signature });
        }
        return out;
      });
      setChecked((prev) => {
        const out = new Set(prev);
        if (included.length === 0) out.delete(diff.path);
        else out.add(diff.path);
        return out;
      });
    },
    [diff, includedSet],
  );

  // ---- assemble the result --------------------------------------------------

  const checkedPaths = files.map((f) => f.path).filter((p) => checked.has(p));
  const partials: ShelveDialogPartialDto[] = [...selections.entries()]
    .filter(([p, sel]) => checked.has(p) && sel.included.length < sel.total)
    .map(([p, sel]) => ({ relPath: p, included: sel.included, signature: sel.signature }));
  const partialPaths = new Set(partials.map((p) => p.relPath));
  const wholePaths = checkedPaths.filter((p) => !partialPaths.has(p));

  const canShelve = checkedPaths.length > 0 && message.trim().length > 0;

  const description = useCallback(
    (node: TreeNode): string | undefined => {
      if (node.kind === 'dir') {
        const n = countFiles(node);
        return `${n} file${n === 1 ? '' : 's'}`;
      }
      const sel = selections.get(node.path);
      if (sel) return `${sel.included.length} of ${sel.total} changes`;
      const file = byPath.get(node.path);
      const dir = node.path.includes('/') ? node.path.slice(0, node.path.lastIndexOf('/')) : '';
      return file ? `${dir.length > 0 ? `${dir} · ` : ''}${file.kind}` : dir;
    },
    [byPath, selections],
  );

  const icon = useCallback(
    (node: TreeNode) => {
      if (node.kind === 'dir') return { codicon: 'folder' };
      const file = byPath.get(node.path);
      return {
        codicon:
          file?.kind === 'deleted'
            ? 'diff-removed'
            : file?.kind === 'added' || file?.kind === 'untracked'
              ? 'diff-added'
              : 'diff-modified',
      };
    },
    [byPath],
  );

  if (error !== undefined) {
    return <div className="gt-dialog-unknown">{error}</div>;
  }
  if (!params || !list) {
    return <div className="gt-dialog-unknown">Loading…</div>;
  }

  return (
    <Dialog
      title={`Shelve Changes — ${params.repoLabel}`}
      onCancel={cancel}
      onAction={(id) => {
        if (id === 'cancel') {
          cancel();
          return;
        }
        if (id !== 'shelve' || !canShelve) return;
        accept({
          listId,
          message,
          paths: wholePaths,
          partials,
          removeFromWorktree,
        });
      }}
      buttons={[
        { id: 'shelve', label: 'Shelve Changes', variant: 'default', disabled: !canShelve },
        { id: 'cancel', label: 'Cancel', variant: 'secondary' },
      ]}
      footerLeft={
        <label className="gt-checkbox">
          <input
            type="checkbox"
            data-testid="shelve-remove"
            checked={removeFromWorktree}
            onChange={(e) => setRemoveFromWorktree(e.currentTarget.checked)}
          />
          <span className="gt-checkbox-body">Remove shelved changes from the worktree</span>
        </label>
      }
      className="gt-shelve-dialog"
    >
      <ToolbarStrip ariaLabel="Shelve toolbar">
        <ToolbarButton
          icon="expand-all"
          label="Expand all"
          onClick={() => setExpanded(new Set(allDirPaths(nodes)))}
        />
        <ToolbarButton icon="collapse-all" label="Collapse all" onClick={() => setExpanded(new Set())} />
        <ToolbarSeparator />
        <ToolbarButton
          icon="refresh"
          label="Refresh"
          onClick={() => {
            void rpc
              .request<ShelveDialogParamsDto>(SHELVE_DIALOG_METHODS.refresh)
              .then((next) => adopt(next, message));
          }}
        />
        <ToolbarButton
          icon="split-horizontal"
          label="Preview Diff"
          toggled={diffOpen}
          onClick={() => setDiffOpen((on) => !on)}
        />
        <ToolbarSpacer />
      </ToolbarStrip>

      <div className="gt-shelve-row">
        <label htmlFor="gt-shelve-list">Changelist:</label>
        <select
          id="gt-shelve-list"
          className="gt-input gt-shelve-list-select"
          data-testid="shelve-list"
          value={listId}
          onChange={(e) => pickList(e.currentTarget.value)}
        >
          {params.lists.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name} ({l.files.length})
            </option>
          ))}
        </select>
      </div>

      <div className="gt-shelve-tree" ref={treeRef} data-testid="shelve-tree">
        <FileTree
          nodes={nodes}
          height={Math.max(0, treeSize.height)}
          ariaLabel="Files to shelve"
          expanded={expanded}
          onToggleExpand={(path, open) => {
            setExpanded((prev) => {
              const next = new Set(prev);
              if (open) next.add(path);
              else next.delete(path);
              return next;
            });
          }}
          checked={checked}
          onToggleCheck={onToggleCheck}
          selection={selection}
          onSelectionChange={(paths) => setSelection(new Set(paths))}
          description={description}
          icon={icon}
        />
      </div>
      <div className="gt-shelve-count" data-testid="shelve-count">
        {checkedPaths.length} of {files.length} modified
      </div>

      <label htmlFor="gt-shelve-message" className="gt-visually-hidden">
        Commit message
      </label>
      <textarea
        id="gt-shelve-message"
        className="gt-input gt-shelve-message"
        data-testid="shelve-message"
        rows={4}
        placeholder="Shelf name (first line) and description"
        value={message}
        onChange={(e) => setMessage(e.currentTarget.value)}
      />

      <button
        type="button"
        className="gt-shelve-diff-header"
        aria-expanded={diffOpen}
        data-testid="shelve-diff-toggle"
        onClick={() => setDiffOpen((on) => !on)}
      >
        <span
          className={`codicon codicon-chevron-${diffOpen ? 'down' : 'right'}`}
          aria-hidden="true"
        />
        Diff
      </button>
      {diffOpen ? (
        <div className="gt-shelve-diff" ref={diffRef} data-testid="shelve-diff">
          {selectedPath === undefined ? (
            <div className="gt-shelve-diff-empty">Select one file to preview its changes.</div>
          ) : !diff ? (
            <div className="gt-shelve-diff-empty">Loading changes…</div>
          ) : diff.wholeFileOnly ? (
            <div className="gt-shelve-diff-empty" data-testid="shelve-whole-file">
              {selectedPath} shelves as a whole file.
            </div>
          ) : (
            <InlineDiff
              originalText={diff.originalText}
              modifiedText={diff.modifiedText}
              changes={diff.changes}
              leftLabel="HEAD"
              rightLabel={selectedPath}
              height={Math.max(0, diffSize.height)}
              included={includedSet}
              onToggleInclude={onToggleInclude}
            />
          )}
        </div>
      ) : null}
    </Dialog>
  );
}
