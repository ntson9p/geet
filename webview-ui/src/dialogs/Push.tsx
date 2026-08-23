/**
 * Push dialog (P13-T1) — the §2A layout: a left pane of outgoing commits under
 * an editable `<local> → <remote> : <remote-branch>` row, a right pane holding
 * the push's full changed-file tree with `N files` counts and status colors,
 * its own right-side toolbar, and the footer
 * `? · [ ] Push tags: [All | Current Branch] · [x] Run Git hooks · [Push ▾] [Cancel]`.
 *
 * The "will run" line is built with the same `buildPushArgs` the host executes
 * (`src/scm/dialogs/pushArgs.ts` is vscode-free precisely so both halves can
 * import it) — what the dialog shows is what runs, not a re-spelling of it.
 *
 * Multi-repo: one section per repository, each independently checkable, which
 * is why the result carries a list rather than a single destination.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  PUSH_DIALOG_METHODS,
  type PushDialogParamsDto,
  type PushDialogResultDto,
  type PushFileDto,
  type PushRepoSectionDto,
} from '../../../src/shared/protocol';
import {
  buildPushArgs,
  formatGitCommand,
  shouldSetUpstream,
  type PushTagsMode,
} from '../../../src/scm/dialogs/pushArgs';
import { Dialog } from '../lib/Dialog';
import { FileTree } from '../lib/FileTree';
import { dirStatusColor, kindOf, statusColor, statusIcon, type StatusKind } from '../lib/status';
import { ToolbarButton } from '../lib/Toolbar';
import { ToolbarSeparator, ToolbarStrip } from '../lib/ToolbarStrip';
import { allDirPaths, buildTree, countFiles, type TreeNode } from '../lib/treeModel';
import { useDialog } from '../lib/useDialog';
import { useElementSize } from '../lib/useElementSize';
import { getVsCodeApi } from '../lib/vscodeApi';

interface Persisted {
  grouped?: boolean;
  previewOnClick?: boolean;
}

function shortDate(unixSeconds: number): string {
  if (!Number.isFinite(unixSeconds) || unixSeconds <= 0) return '';
  return new Date(unixSeconds * 1000).toLocaleDateString();
}

function fileLabel(n: number): string {
  return `${n} file${n === 1 ? '' : 's'}`;
}

export function Push() {
  const { init, error, accept, cancel, help, rpc } = useDialog<
    PushDialogParamsDto,
    PushDialogResultDto
  >();
  const api = useMemo(() => getVsCodeApi(), []);
  const saved = (api.getState() as Persisted | undefined) ?? {};

  const [params, setParams] = useState<PushDialogParamsDto | undefined>(undefined);
  const [sections, setSections] = useState<readonly PushRepoSectionDto[]>([]);
  const [checkedRoots, setCheckedRoots] = useState<ReadonlySet<string>>(() => new Set());
  const [activeRoot, setActiveRoot] = useState('');
  const [editing, setEditing] = useState<string | undefined>(undefined);
  const [editRemote, setEditRemote] = useState('');
  const [editBranch, setEditBranch] = useState('');
  const [busy, setBusy] = useState(false);

  const [tagsOn, setTagsOn] = useState(false);
  const [tagsMode, setTagsMode] = useState<'all' | 'follow'>('all');
  const [runHooks, setRunHooks] = useState(true);

  const [grouped, setGrouped] = useState(saved.grouped ?? true);
  const [previewOnClick, setPreviewOnClick] = useState(saved.previewOnClick ?? false);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [selection, setSelection] = useState<ReadonlySet<string>>(() => new Set());
  const [treeRef, treeSize] = useElementSize<HTMLDivElement>();

  useEffect(() => {
    if (!init) return;
    const p = init.params;
    setParams(p);
    setSections(p.repos);
    setCheckedRoots(new Set(p.repos.filter((r) => r.checked).map((r) => r.root)));
    setActiveRoot(p.repos[0]?.root ?? '');
    setTagsOn(p.tags !== 'none');
    setTagsMode(p.tags === 'follow' ? 'follow' : 'all');
    setRunHooks(p.runHooks);
  }, [init]);

  useEffect(() => {
    api.setState({ grouped, previewOnClick } satisfies Persisted);
  }, [api, grouped, previewOnClick]);

  const active = useMemo(
    () => sections.find((s) => s.root === activeRoot) ?? sections[0],
    [activeRoot, sections],
  );
  const files = useMemo(() => active?.files ?? [], [active]);
  const byPath = useMemo(() => new Map(files.map((f) => [f.path, f])), [files]);

  const nodes = useMemo((): TreeNode[] => {
    if (files.length === 0) return [];
    const paths = files.map((f) => f.path);
    if (grouped) return buildTree(paths);
    return paths
      .slice()
      .sort((a, b) => a.localeCompare(b))
      .map((p) => ({ kind: 'file' as const, path: p, name: p, depth: 0 }));
  }, [files, grouped]);

  // A fresh change set opens fully expanded, like the log's Changed Files pane.
  useEffect(() => {
    setExpanded(new Set(allDirPaths(nodes)));
    setSelection(new Set());
  }, [nodes]);

  // ---- retargeting ----------------------------------------------------------

  const beginEdit = useCallback((s: PushRepoSectionDto) => {
    setEditing(s.root);
    setEditRemote(s.remote);
    setEditBranch(s.remoteBranch);
  }, []);

  const applyEdit = useCallback(
    (root: string, remote: string, remoteBranch: string) => {
      const trimmed = remoteBranch.trim();
      if (trimmed.length === 0) return;
      setBusy(true);
      rpc
        .request<PushRepoSectionDto | undefined>(PUSH_DIALOG_METHODS.retarget, {
          root,
          remote,
          remoteBranch: trimmed,
        })
        .then(
          (next) => {
            if (next) setSections((prev) => prev.map((s) => (s.root === root ? next : s)));
          },
          () => undefined,
        )
        .finally(() => {
          setBusy(false);
          setEditing(undefined);
        });
    },
    [rpc],
  );

  // ---- file pane ------------------------------------------------------------

  const selectedFile = useMemo((): PushFileDto | undefined => {
    if (selection.size !== 1) return undefined;
    const [only] = [...selection];
    return only === undefined ? undefined : byPath.get(only);
  }, [byPath, selection]);

  const openDiff = useCallback(
    (file: PushFileDto | undefined) => {
      if (!file || !active) return;
      void rpc.request(PUSH_DIALOG_METHODS.openDiff, {
        root: active.root,
        base: active.base,
        status: file.status,
        path: file.path,
        ...(file.origPath !== undefined ? { origPath: file.origPath } : {}),
      });
    },
    [active, rpc],
  );

  const dirKinds = useCallback(
    (node: TreeNode): ReadonlySet<StatusKind> => {
      const out = new Set<StatusKind>();
      if (node.kind !== 'dir') return out;
      const prefix = `${node.path}/`;
      for (const f of files) if (f.path.startsWith(prefix)) out.add(kindOf(f.status));
      return out;
    },
    [files],
  );

  const description = useCallback(
    (node: TreeNode): string | undefined => {
      if (node.kind === 'dir') return fileLabel(countFiles(node));
      const file = byPath.get(node.path);
      return file?.origPath !== undefined ? `← ${file.origPath}` : undefined;
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
      const kind = kindOf(file.status);
      return { codicon: statusIcon(kind), color: statusColor(kind, params?.colors) };
    },
    [byPath, dirKinds, params?.colors],
  );

  const nameColor = useCallback(
    (node: TreeNode): string | undefined => {
      if (node.kind === 'dir') return dirStatusColor(dirKinds(node), params?.colors);
      const file = byPath.get(node.path);
      return file ? statusColor(kindOf(file.status), params?.colors) : undefined;
    },
    [byPath, dirKinds, params?.colors],
  );

  // ---- result ---------------------------------------------------------------

  const tags: PushTagsMode = tagsOn ? tagsMode : 'none';
  const chosen = useMemo(
    () => sections.filter((s) => checkedRoots.has(s.root)),
    [checkedRoots, sections],
  );
  const canPush = chosen.length > 0 && !busy;

  const argvFor = useCallback(
    (s: PushRepoSectionDto, force: boolean): string[] =>
      buildPushArgs({
        remote: s.remote,
        localBranch: s.branch,
        remoteBranch: s.remoteBranch,
        setUpstream: shouldSetUpstream(s.hasUpstream, s.branch, s.remoteBranch),
        tags,
        runHooks,
        force,
        forceIfIncludes: force && (params?.forceIfIncludes ?? false),
      }),
    [params?.forceIfIncludes, runHooks, tags],
  );

  const submit = useCallback(
    (force: boolean) => {
      if (!canPush) return;
      accept({
        repos: chosen.map((s) => ({
          root: s.root,
          remote: s.remote,
          remoteBranch: s.remoteBranch,
        })),
        tags,
        runHooks,
        force,
      });
    },
    [accept, canPush, chosen, runHooks, tags],
  );

  if (error !== undefined) return <div className="gt-dialog-unknown">{error}</div>;
  if (!params) return <div className="gt-dialog-unknown">Loading…</div>;

  const multi = sections.length > 1;
  const title = `Push Commits to ${sections.map((s) => s.label).join(', ')}`;

  return (
    <Dialog
      title={title}
      onCancel={cancel}
      onHelp={help}
      onAction={(id) => {
        if (id === 'cancel') cancel();
        else if (id === 'push') submit(false);
        else if (id === 'force') submit(true);
      }}
      buttons={[
        {
          id: 'push',
          label: 'Push',
          variant: 'default',
          disabled: !canPush,
          menu: [{ kind: 'item', id: 'force', label: 'Force Push…' }],
        },
        { id: 'cancel', label: 'Cancel', variant: 'secondary' },
      ]}
      footerLeft={
        <>
          <label className="gt-checkbox">
            <input
              type="checkbox"
              data-testid="push-tags-on"
              checked={tagsOn}
              onChange={(e) => setTagsOn(e.currentTarget.checked)}
            />
            <span className="gt-checkbox-body">Push tags:</span>
          </label>
          <select
            className="gt-input gt-push-tags-mode"
            data-testid="push-tags-mode"
            aria-label="Which tags to push"
            disabled={!tagsOn}
            value={tagsMode}
            onChange={(e) => setTagsMode(e.currentTarget.value === 'follow' ? 'follow' : 'all')}
          >
            <option value="all">All</option>
            <option value="follow">Current Branch</option>
          </select>
          <label className="gt-checkbox">
            <input
              type="checkbox"
              data-testid="push-run-hooks"
              checked={runHooks}
              onChange={(e) => setRunHooks(e.currentTarget.checked)}
            />
            <span className="gt-checkbox-body">Run Git hooks</span>
          </label>
        </>
      }
      className="gt-push-dialog"
    >
      <div className="gt-push-body">
        <div className="gt-push-left" data-testid="push-commits">
          {sections.map((s) => {
            const isActive = active?.root === s.root;
            return (
              <div
                key={s.root}
                className={`gt-push-section${isActive ? ' gt-active' : ''}`}
                data-testid={`push-section-${s.label}`}
              >
                <div className="gt-push-target-row">
                  {multi ? (
                    <label className="gt-checkbox">
                      <input
                        type="checkbox"
                        aria-label={`Push ${s.label}`}
                        data-testid={`push-repo-${s.label}`}
                        checked={checkedRoots.has(s.root)}
                        onChange={(e) => {
                          const on = e.currentTarget.checked;
                          setCheckedRoots((prev) => {
                            const next = new Set(prev);
                            if (on) next.add(s.root);
                            else next.delete(s.root);
                            return next;
                          });
                        }}
                      />
                      <span className="gt-checkbox-body">{s.label}</span>
                    </label>
                  ) : null}

                  {editing === s.root ? (
                    <span className="gt-push-target-edit">
                      <select
                        className="gt-input"
                        aria-label="Remote"
                        data-testid="push-edit-remote"
                        value={editRemote}
                        onChange={(e) => setEditRemote(e.currentTarget.value)}
                      >
                        {s.remotes.map((r) => (
                          <option key={r} value={r}>
                            {r}
                          </option>
                        ))}
                      </select>
                      <span aria-hidden="true">:</span>
                      <input
                        className="gt-input"
                        aria-label="Remote branch"
                        data-testid="push-edit-branch"
                        list={`gt-push-branches-${s.label}`}
                        value={editBranch}
                        onChange={(e) => setEditBranch(e.currentTarget.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault();
                            applyEdit(s.root, editRemote, editBranch);
                          }
                        }}
                      />
                      <datalist id={`gt-push-branches-${s.label}`}>
                        {s.remoteBranchOptions.map((b) => (
                          <option key={b} value={b} />
                        ))}
                      </datalist>
                      <button
                        type="button"
                        className="gt-button"
                        data-testid="push-edit-apply"
                        disabled={busy}
                        onClick={() => applyEdit(s.root, editRemote, editBranch)}
                      >
                        Apply
                      </button>
                      <button
                        type="button"
                        className="gt-button"
                        onClick={() => setEditing(undefined)}
                      >
                        Cancel
                      </button>
                    </span>
                  ) : (
                    <button
                      type="button"
                      className="gt-push-target"
                      data-testid={`push-target-${s.label}`}
                      title="Click to push to a different branch"
                      onClick={() => {
                        setActiveRoot(s.root);
                        beginEdit(s);
                      }}
                    >
                      <span className="gt-push-local">{s.branch}</span>
                      <span className="gt-push-arrow" aria-hidden="true">
                        →
                      </span>
                      <span className="gt-push-remote">
                        {s.remote} : {s.remoteBranch}
                      </span>
                      {s.targetExists ? null : <span className="gt-push-new">new</span>}
                    </button>
                  )}

                  <span className="gt-push-count" data-testid={`push-count-${s.label}`}>
                    {s.totalCommits} commit{s.totalCommits === 1 ? '' : 's'}
                  </span>
                </div>

                <ul className="gt-push-commit-list">
                  {s.commits.length === 0 ? (
                    <li className="gt-push-commit gt-muted">Nothing to push.</li>
                  ) : null}
                  {s.commits.map((c) => (
                    <li
                      key={c.sha}
                      className="gt-push-commit"
                      onClick={() => setActiveRoot(s.root)}
                    >
                      <code className="gt-push-sha">{c.sha.slice(0, 7)}</code>
                      <span className="gt-push-subject">{c.subject}</span>
                      <span className="gt-push-author">{c.authorName}</span>
                      <span className="gt-push-date">{shortDate(c.authorTime)}</span>
                    </li>
                  ))}
                  {s.totalCommits > s.commits.length ? (
                    <li className="gt-push-commit gt-muted">
                      … and {s.totalCommits - s.commits.length} more
                    </li>
                  ) : null}
                </ul>
              </div>
            );
          })}
        </div>

        <div className="gt-push-right">
          <div className="gt-push-files-header">
            <span data-testid="push-files-count">{fileLabel(files.length)}</span>
          </div>
          <div className="gt-push-files-body">
            <div className="gt-push-files" ref={treeRef} data-testid="push-files">
              {files.length === 0 ? (
                <div className="gt-push-empty gt-muted">No changed files.</div>
              ) : (
                <FileTree
                  nodes={nodes}
                  height={Math.max(0, treeSize.height)}
                  ariaLabel="Files in this push"
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
                    if (!previewOnClick || paths.length !== 1) return;
                    const only = byPath.get(paths[0] ?? '');
                    if (only) openDiff(only);
                  }}
                  onActivate={(node) => openDiff(byPath.get(node.path))}
                  description={description}
                  icon={icon}
                  nameColor={nameColor}
                />
              )}
            </div>
            <ToolbarStrip ariaLabel="Push file toolbar" className="gt-toolbar-vertical">
              <ToolbarButton
                icon="diff"
                label="Show Diff"
                disabled={selectedFile === undefined}
                onClick={() => openDiff(selectedFile)}
              />
              <ToolbarButton
                icon="eye"
                label="Preview on Click"
                toggled={previewOnClick}
                onClick={() => setPreviewOnClick((on) => !on)}
              />
              <ToolbarButton
                icon="edit"
                label="Edit Source"
                disabled={selectedFile === undefined}
                onClick={() => {
                  if (!selectedFile || !active) return;
                  void rpc.request(PUSH_DIALOG_METHODS.openFile, {
                    root: active.root,
                    path: selectedFile.path,
                  });
                }}
              />
              <ToolbarSeparator />
              <ToolbarButton
                icon="list-tree"
                label="Group by Directory"
                toggled={grouped}
                onClick={() => setGrouped((on) => !on)}
              />
              <ToolbarButton
                icon="expand-all"
                label="Expand all"
                disabled={!grouped}
                onClick={() => setExpanded(new Set(allDirPaths(nodes)))}
              />
              <ToolbarButton
                icon="collapse-all"
                label="Collapse all"
                disabled={!grouped}
                onClick={() => setExpanded(new Set())}
              />
            </ToolbarStrip>
          </div>
        </div>
      </div>

      {params.showCommandLine ? (
        <div className="gt-push-cmd" data-testid="push-command">
          {chosen.length === 0 ? (
            <div className="gt-muted">Nothing selected to push.</div>
          ) : (
            chosen.map((s) => (
              <div key={s.root}>
                <span className="gt-muted">will run:&nbsp;</span>
                <code>{formatGitCommand(argvFor(s, false))}</code>
              </div>
            ))
          )}
        </div>
      ) : null}
    </Dialog>
  );
}
