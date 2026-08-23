/**
 * Rollback dialog (P13-T3) — IntelliJ's rollback is a dialog with a file list,
 * not a silent action: a checkbox `FileTree` with `N files` counts and status
 * colors, `[x] Delete local copies of added files`, and an `InlineDiff` preview
 * of what is about to be reverted.
 *
 * The checkbox is a real switch, not decoration: unticked, a newly added file is
 * unstaged but stays on disk. The "will run" line shows the restore/unstage
 * commands and the deletion count, because deletions have no git command to
 * show.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ROLLBACK_DIALOG_METHODS,
  type RollbackDialogParamsDto,
  type RollbackDialogResultDto,
  type RollbackFileDiffDto,
  type RollbackFileDto,
} from '../../../src/shared/protocol';
import { formatGitCommands } from '../../../src/scm/dialogs/commandLine';
import {
  isEmptyRollbackPlan,
  planRollback,
  rollbackCommands,
} from '../../../src/scm/dialogs/rollbackPlan';
import { Dialog } from '../lib/Dialog';
import { FileTree } from '../lib/FileTree';
import { InlineDiff } from '../lib/InlineDiff';
import { dirStatusColor, kindOf, statusColor, statusIcon, type StatusKind } from '../lib/status';
import { allDirPaths, buildTree, countFiles, type ToggleDelta, type TreeNode } from '../lib/treeModel';
import { useDialog } from '../lib/useDialog';
import { useElementSize } from '../lib/useElementSize';

/** Rollback kinds map onto the shared status palette for the tree's colors. */
function statusKindOf(file: RollbackFileDto): StatusKind {
  if (file.kind === 'untracked') return 'untracked';
  if (file.kind === 'added') return 'added';
  return kindOf(file.code.replace(/\./g, '').charAt(0) || 'M');
}

export function Rollback() {
  const { init, error, accept, cancel, help, rpc } = useDialog<
    RollbackDialogParamsDto,
    RollbackDialogResultDto
  >();
  const [params, setParams] = useState<RollbackDialogParamsDto | undefined>(undefined);
  const [checked, setChecked] = useState<ReadonlySet<string>>(() => new Set());
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [selection, setSelection] = useState<ReadonlySet<string>>(() => new Set());
  const [deleteAdded, setDeleteAdded] = useState(true);
  const [diff, setDiff] = useState<RollbackFileDiffDto | undefined>(undefined);
  const [treeRef, treeSize] = useElementSize<HTMLDivElement>();
  const [diffRef, diffSize] = useElementSize<HTMLDivElement>();

  useEffect(() => {
    if (!init) return;
    setParams(init.params);
    setChecked(new Set(init.params.checked));
    setDeleteAdded(init.params.deleteAddedLocalCopies);
  }, [init]);

  const files = useMemo(() => params?.files ?? [], [params]);
  const byPath = useMemo(() => new Map(files.map((f) => [f.path, f])), [files]);
  const nodes = useMemo(() => buildTree(files.map((f) => f.path)), [files]);

  useEffect(() => {
    setExpanded(new Set(allDirPaths(nodes)));
  }, [nodes]);

  const onToggleCheck = useCallback((delta: ToggleDelta) => {
    setChecked((prev) => {
      const next = new Set(prev);
      for (const p of delta.paths) {
        if (delta.next) next.add(p);
        else next.delete(p);
      }
      return next;
    });
  }, []);

  const selectedPath = useMemo(() => {
    if (selection.size !== 1) return undefined;
    const [only] = [...selection];
    return only !== undefined && byPath.has(only) ? only : undefined;
  }, [byPath, selection]);

  useEffect(() => {
    if (selectedPath === undefined) {
      setDiff(undefined);
      return;
    }
    let cancelled = false;
    rpc
      .request<RollbackFileDiffDto>(ROLLBACK_DIALOG_METHODS.fileDiff, { relPath: selectedPath })
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
  }, [rpc, selectedPath]);

  const checkedFiles = useMemo(
    () => files.filter((f) => checked.has(f.path)),
    [checked, files],
  );
  const plan = useMemo(
    () =>
      planRollback(
        checkedFiles.map((f) => ({
          path: f.path,
          kind: f.kind,
          ...(f.origPath !== undefined ? { origPath: f.origPath } : {}),
        })),
        deleteAdded,
      ),
    [checkedFiles, deleteAdded],
  );

  const dirKinds = useCallback(
    (node: TreeNode): ReadonlySet<StatusKind> => {
      const out = new Set<StatusKind>();
      if (node.kind !== 'dir') return out;
      const prefix = `${node.path}/`;
      for (const f of files) if (f.path.startsWith(prefix)) out.add(statusKindOf(f));
      return out;
    },
    [files],
  );

  const description = useCallback(
    (node: TreeNode): string | undefined => {
      if (node.kind === 'dir') {
        const n = countFiles(node);
        return `${n} file${n === 1 ? '' : 's'}`;
      }
      const file = byPath.get(node.path);
      if (!file) return undefined;
      return file.origPath !== undefined ? `${file.code} · ← ${file.origPath}` : file.code;
    },
    [byPath],
  );

  const icon = useCallback(
    (node: TreeNode) => {
      if (node.kind === 'dir') {
        const color = dirStatusColor(dirKinds(node), params?.colors);
        return color !== undefined ? { codicon: 'folder', color } : { codicon: 'folder' };
      }
      const file = byPath.get(node.path);
      if (!file) return { codicon: 'file' };
      const kind = statusKindOf(file);
      return { codicon: statusIcon(kind), color: statusColor(kind, params?.colors) };
    },
    [byPath, dirKinds, params?.colors],
  );

  const nameColor = useCallback(
    (node: TreeNode): string | undefined => {
      if (node.kind === 'dir') return dirStatusColor(dirKinds(node), params?.colors);
      const file = byPath.get(node.path);
      return file ? statusColor(statusKindOf(file), params?.colors) : undefined;
    },
    [byPath, dirKinds, params?.colors],
  );

  if (error !== undefined) return <div className="gt-dialog-unknown">{error}</div>;
  if (!params) return <div className="gt-dialog-unknown">Loading…</div>;

  const canRollback = !isEmptyRollbackPlan(plan);
  const commandText = formatGitCommands(rollbackCommands(plan));
  const deleteNote =
    plan.deletePaths.length > 0
      ? `${commandText.length > 0 ? ' · ' : ''}deletes ${plan.deletePaths.length} local file${
          plan.deletePaths.length === 1 ? '' : 's'
        }`
      : '';

  return (
    <Dialog
      title={`Rollback Changes — ${params.repoLabel}`}
      onCancel={cancel}
      onHelp={help}
      onAction={(id) => {
        if (id === 'cancel') cancel();
        else if (id === 'rollback' && canRollback) {
          accept({
            paths: checkedFiles.map((f) => f.path),
            deleteAddedLocalCopies: deleteAdded,
          });
        }
      }}
      buttons={[
        { id: 'rollback', label: 'Rollback', variant: 'default', disabled: !canRollback },
        { id: 'cancel', label: 'Cancel', variant: 'secondary' },
      ]}
      footerLeft={
        <label className="gt-checkbox">
          <input
            type="checkbox"
            data-testid="rollback-delete-added"
            checked={deleteAdded}
            onChange={(e) => setDeleteAdded(e.currentTarget.checked)}
          />
          <span className="gt-checkbox-body">Delete local copies of added files</span>
        </label>
      }
      className="gt-op-dialog gt-rollback-dialog"
    >
      <div className="gt-rollback-tree" ref={treeRef} data-testid="rollback-tree">
        <FileTree
          nodes={nodes}
          height={Math.max(0, treeSize.height)}
          ariaLabel="Files to roll back"
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
          nameColor={nameColor}
        />
      </div>
      <div className="gt-rollback-count" data-testid="rollback-count">
        {checkedFiles.length} of {files.length} file{files.length === 1 ? '' : 's'}
      </div>

      <div className="gt-rollback-diff" ref={diffRef} data-testid="rollback-diff">
        {selectedPath === undefined ? (
          <div className="gt-rollback-diff-empty gt-muted">
            Select one file to preview what rollback would revert.
          </div>
        ) : !diff ? (
          <div className="gt-rollback-diff-empty gt-muted">Loading changes…</div>
        ) : diff.wholeFileOnly ? (
          <div className="gt-rollback-diff-empty gt-muted" data-testid="rollback-whole-file">
            {selectedPath} has no line diff against HEAD — rollback reverts it whole.
          </div>
        ) : (
          <InlineDiff
            originalText={diff.originalText}
            modifiedText={diff.modifiedText}
            changes={diff.changes}
            leftLabel="HEAD"
            rightLabel={selectedPath}
            height={Math.max(0, diffSize.height)}
          />
        )}
      </div>

      {params.showCommandLine ? (
        <div className="gt-op-cmd" data-testid="will-run">
          <span className="gt-muted">will run:&nbsp;</span>
          <code>{commandText.length > 0 ? commandText : '(nothing)'}</code>
          <span className="gt-muted">{deleteNote}</span>
        </div>
      ) : null}
    </Dialog>
  );
}
