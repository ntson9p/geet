/**
 * Push dialog — IntelliJ's `VcsPushDialog` (P13-T1; rebuilt on IntelliJ's
 * layout in POST-P14ao). Left, the tree of `PushLog`: a row per repository,
 * `source → remote : branch` with `New` for a branch the remote does not have
 * yet, its outgoing commits under it. Right, the merged changes of the
 * commits selected on the left, with IntelliJ's toolbar — Show Diff · View
 * Options · Edit Source · Show Details … Expand All · Collapse All — and, for
 * a single selected commit, its details below. Footer: `? · [ ] Push tags:
 * [All ▾] · [x] Run Git hooks` (only when a pre-push hook exists) and
 * `[Push ▾] [Cancel]`, `Force Push` in the split.
 *
 * Clicking the target branch edits it (F2 does too; Enter applies, Escape
 * cancels); clicking the remote lists the remotes and `Define remote`. With
 * several repositories each row has a checkbox (Space toggles the selected
 * ones) and `Edit all targets` (Alt+F2) edits every target at once.
 *
 * The "will run" line is built with the same `buildPushArgs` and
 * `pushRefspec` the host executes — what the dialog shows is what runs.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from 'react';
import { isValidRefName } from '../../../src/core/git/refName';
import { formatGitCommand } from '../../../src/scm/dialogs/commandLine';
import { buildPushArgs, type PushTagsMode } from '../../../src/scm/dialogs/pushArgs';
import {
  forcePushConfirmation,
  isBranchProtected,
  pushRefspec,
  setsUpstream,
  shortHash,
  showsUpstreamCheckbox,
  targetBadge,
  targetVariants,
  upstreamCheckboxBase,
  type ForceConfirmation,
} from '../../../src/scm/dialogs/pushModel';
import {
  PUSH_DIALOG_METHODS,
  type CommitDetailsDto,
  type CommitFileDto,
  type PushDefineRemoteResultDto,
  type PushDialogParamsDto,
  type PushDialogResultDto,
  type PushDialogUiDto,
  type PushRetargetDto,
} from '../../../src/shared/protocol';
import { Dialog } from '../lib/Dialog';
import { Menu, type MenuItem } from '../lib/Menu';
import { SplitPane } from '../lib/SplitPane';
import { ToolbarButton } from '../lib/Toolbar';
import { ToolbarSeparator, ToolbarSpacer, ToolbarStrip } from '../lib/ToolbarStrip';
import { useDialog } from '../lib/useDialog';
import { commitDate } from '../log/dateFormat';
import { DetailsPanel } from '../log/DetailsPanel';
import {
  EMPTY_SELECTION,
  clickSelection,
  extendSelection,
  rowOrder,
  selectAll,
  shiftTarget,
  type LogSelection,
} from '../log/logSelection';
import { PushChanges, type ChangedFileRef, type RepoChanges } from './PushChanges';
import { DefineRemote, ForcePushConfirm } from './PushOverlays';
import { PushTargetEditor } from './PushTargetEditor';
import {
  buildRows,
  canPush,
  chosenRepos,
  hasChildren,
  initialSelection,
  INITIAL_SHOWN_COMMITS,
  pushable,
  repoKey,
  repoStateOf,
  selectedCommits,
  toggledByKeyboard,
  type PushRow,
  type RepoState,
} from './pushTree';

const DEFAULT_UI: PushDialogUiDto = { showDetails: true, groupByDirectory: true, treeRatio: 0.5, detailsRatio: 0.67 };

const PROTECTED_SETTING_HINT = 'Configure protected branches in the setting gittree.protectedBranches';

/** `Set upstream` counts only while it is shown: the target is not the upstream already. */
function explicitUpstream(r: RepoState): boolean {
  if (!r.setUpstream || r.target === undefined) return false;
  const base = upstreamCheckboxBase(r.dto.source, r.dto.defaultTarget);
  return showsUpstreamCheckbox(base, r.target.remote, r.target.branch);
}

/** IntelliJ's commit tooltip: `hash  date  by author`, the message, and the hint. */
function commitTooltip(c: { sha: string; authorTime: number; authorName: string; body: string }): string {
  return `${shortHash(c.sha)}  ${commitDate(c.authorTime)}  by ${c.authorName}\n\n${c.body}\n\nSelect to show commit details`;
}

interface Editing {
  readonly root: string;
  /** `Edit all targets`: what is typed goes to every repository. */
  readonly sync: boolean;
}

export function Push() {
  const { init, error, accept, cancel, help, rpc } = useDialog<PushDialogParamsDto, PushDialogResultDto>();

  const [params, setParams] = useState<PushDialogParamsDto | undefined>(undefined);
  const [repos, setRepos] = useState<readonly RepoState[]>([]);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [selection, setSelection] = useState<LogSelection>(EMPTY_SELECTION);
  const [lead, setLead] = useState<string | undefined>(undefined);

  const [editing, setEditing] = useState<Editing | undefined>(undefined);
  const [editText, setEditText] = useState('');
  const [editRemote, setEditRemote] = useState('');
  const [editUpstream, setEditUpstream] = useState(false);
  const [editProblem, setEditProblem] = useState<string | undefined>(undefined);

  const [remoteMenu, setRemoteMenu] = useState<
    { root: string; x: number; y: number; inEditor: boolean } | undefined
  >(undefined);
  const [defineFor, setDefineFor] = useState<string | undefined>(undefined);
  const [defineBusy, setDefineBusy] = useState(false);
  const [defineProblem, setDefineProblem] = useState<{ field: 'name' | 'url'; message: string } | undefined>(
    undefined,
  );
  const [forceAsk, setForceAsk] = useState<ForceConfirmation | undefined>(undefined);
  const [viewMenu, setViewMenu] = useState<{ x: number; y: number } | undefined>(undefined);

  const [tagsOn, setTagsOn] = useState(false);
  const [tagsMode, setTagsMode] = useState<'all' | 'follow'>('all');
  const [runHooks, setRunHooks] = useState(true);

  const [ui, setUi] = useState<PushDialogUiDto>(DEFAULT_UI);
  const [changeSets, setChangeSets] = useState<readonly RepoChanges[]>([]);
  const [changesLoading, setChangesLoading] = useState(false);
  const [selectedFiles, setSelectedFiles] = useState<readonly ChangedFileRef[]>([]);
  const [expandRequest, setExpandRequest] = useState({ all: true, seq: 0 });
  const [details, setDetails] = useState<CommitDetailsDto | undefined>(undefined);

  const treeRef = useRef<HTMLDivElement | null>(null);
  const rowEls = useRef(new Map<string, HTMLDivElement>());
  const changesCache = useRef(new Map<string, CommitFileDto[]>());
  const detailsCache = useRef(new Map<string, CommitDetailsDto>());
  const changesSeq = useRef(0);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    if (!init) return;
    const p = init.params;
    const states = p.repos.map(repoStateOf);
    setParams(p);
    setRepos(states);
    // IntelliJ opens the checked repositories and leaves the others closed.
    setExpanded(new Set(states.filter((s) => s.checked).map((s) => s.dto.root)));
    const first = initialSelection(states, p.highlight);
    setSelection(first !== undefined ? { shas: [first], anchor: first } : EMPTY_SELECTION);
    setLead(first);
    setUi(p.ui);
    setTagsOn(p.tags !== 'none');
    setTagsMode(p.tags === 'follow' ? 'follow' : 'all');
  }, [init]);

  const single = params?.single ?? true;
  const rows = useMemo(() => buildRows(repos, expanded, single), [expanded, repos, single]);
  const keys = useMemo(() => rows.map((r) => r.key), [rows]);
  const order = useMemo(() => rowOrder(keys), [keys]);
  const selectedSet = useMemo(() => new Set(selection.shas), [selection]);
  const byRoot = useMemo(() => new Map(repos.map((r) => [r.dto.root, r])), [repos]);
  const selected = useMemo(() => selectedCommits(rows, selectedSet, repos), [repos, rows, selectedSet]);

  useEffect(() => {
    if (lead !== undefined) rowEls.current.get(lead)?.scrollIntoView({ block: 'nearest' });
  }, [lead]);

  // ---- remembered layout ------------------------------------------------------

  const updateUi = useCallback(
    (patch: Partial<PushDialogUiDto>, debounce = false) => {
      setUi((prev) => ({ ...prev, ...patch }));
      const save = (): void => void rpc.request(PUSH_DIALOG_METHODS.saveUi, patch).catch(() => undefined);
      if (!debounce) {
        save();
        return;
      }
      clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(save, 300);
    },
    [rpc],
  );

  // ---- the changes and details of the selection ------------------------------

  const changesKey = useMemo(() => JSON.stringify([...selected.byRepo]), [selected]);
  useEffect(() => {
    const seq = ++changesSeq.current;
    const wanted = [...selected.byRepo];
    if (wanted.length === 0) {
      setChangeSets([]);
      setChangesLoading(false);
      return;
    }
    setChangesLoading(true);
    void Promise.all(
      wanted.map(async ([root, shas]) => {
        const key = `${root}\u0000${shas.join(',')}`;
        const hit = changesCache.current.get(key);
        if (hit) return { root, files: hit };
        const res = await rpc.request<{ files: CommitFileDto[] }>(PUSH_DIALOG_METHODS.changes, { root, shas });
        const files = res?.files ?? [];
        changesCache.current.set(key, files);
        return { root, files };
      }),
    ).then(
      (list) => {
        if (seq !== changesSeq.current) return;
        const files = new Map(list.map((l) => [l.root, l.files]));
        setChangeSets(
          repos
            .filter((r) => files.has(r.dto.root))
            .map((r) => ({ root: r.dto.root, label: r.dto.label, files: files.get(r.dto.root) ?? [] })),
        );
        setChangesLoading(false);
      },
      () => {
        if (seq === changesSeq.current) setChangesLoading(false);
      },
    );
    // `changesKey` is the selection's identity; `repos` only orders the result.
  }, [changesKey, rpc]);

  const detailsCommit = selected.single;
  const detailsShown = ui.showDetails && detailsCommit !== undefined;
  useEffect(() => {
    if (!detailsShown || detailsCommit === undefined) {
      setDetails(undefined);
      return;
    }
    const { root, commit } = detailsCommit;
    const key = `${root}\u0000${commit.sha}`;
    const hit = detailsCache.current.get(key);
    if (hit) {
      setDetails(hit);
      return;
    }
    setDetails(undefined);
    let live = true;
    void rpc
      .request<CommitDetailsDto | undefined>(PUSH_DIALOG_METHODS.details, { root, sha: commit.sha })
      .then(
        (d) => {
          if (!d) return;
          detailsCache.current.set(key, d);
          if (live) setDetails(d);
        },
        () => undefined,
      );
    return () => {
      live = false;
    };
  }, [detailsCommit, detailsShown, rpc]);

  // ---- targets ------------------------------------------------------------------

  const patchRepo = useCallback((root: string, patch: (r: RepoState) => RepoState) => {
    setRepos((prev) => prev.map((r) => (r.dto.root === root ? patch(r) : r)));
  }, []);

  /** A new target: its commits listed again; the row is checked and opened, as IntelliJ's `onTargetChanged` does. */
  const retarget = useCallback(
    (root: string, remote: string, branch: string, setUpstream: boolean) => {
      patchRepo(root, (r) => ({ ...r, checked: true, loading: true, setUpstream }));
      setExpanded((prev) => new Set(prev).add(root));
      rpc
        .request<PushRetargetDto | undefined>(PUSH_DIALOG_METHODS.retarget, { root, remote, branch })
        .then(
          (res) => {
            patchRepo(root, (r) => {
              if (!res) return { ...r, loading: false };
              const { loadError: _old, ...rest } = r;
              return {
                ...rest,
                target: res.target,
                commits: res.commits,
                ...(res.loadError !== undefined ? { loadError: res.loadError } : {}),
                loading: false,
                shown: INITIAL_SHOWN_COMMITS,
                // A target whose commits cannot be listed is not pushed by default.
                checked: single || res.loadError === undefined,
              };
            });
          },
          () => patchRepo(root, (r) => ({ ...r, loading: false })),
        );
    },
    [patchRepo, rpc, single],
  );

  const editable = useCallback((r: RepoState | undefined): r is RepoState => r !== undefined && pushable(r), []);

  const startEdit = useCallback(
    (root: string, sync = false) => {
      const repo = byRoot.get(root);
      if (!editable(repo) || repo.target === undefined) return;
      setEditing({ root, sync });
      setEditText(repo.target.branch);
      setEditRemote(repo.target.remote);
      setEditUpstream(repo.setUpstream);
      setEditProblem(undefined);
      const key = repoKey(root);
      setSelection({ shas: [key], anchor: key });
      setLead(key);
    },
    [byRoot, editable],
  );

  /** `Edit all targets`: the selected repository when it can be edited, else the first that can. */
  const startSync = useCallback(() => {
    const leadRoot = lead !== undefined ? rows.find((r) => r.key === lead)?.root : undefined;
    const first = editable(byRoot.get(leadRoot ?? '')) ? leadRoot : repos.find((r) => editable(r))?.dto.root;
    if (first !== undefined) startEdit(first, true);
  }, [byRoot, editable, lead, repos, rows, startEdit]);

  /** `refocus`: back to the tree after Enter or Escape; not when the user clicked elsewhere. */
  const endEdit = useCallback((refocus = true) => {
    setEditing(undefined);
    setEditProblem(undefined);
    if (refocus) treeRef.current?.focus();
  }, []);

  /** Enter: the typed target for this repository — or, editing all, for every one. */
  const applyEdit = useCallback((refocus = true): boolean => {
    if (!editing) return false;
    const name = editText;
    if (!isValidRefName(name)) {
      setEditProblem(`Invalid destination branch name: ${name}`);
      return false;
    }
    const roots = editing.sync ? repos.filter((r) => editable(r)).map((r) => r.dto.root) : [editing.root];
    for (const root of roots) {
      const repo = byRoot.get(root);
      if (!repo?.target) continue;
      const remote = root === editing.root ? editRemote : repo.target.remote;
      const base = upstreamCheckboxBase(repo.dto.source, repo.dto.defaultTarget);
      const upstream = root === editing.root && editUpstream && showsUpstreamCheckbox(base, remote, name);
      if (repo.target.remote === remote && repo.target.branch === name && repo.loadError === undefined) {
        patchRepo(root, (r) => ({ ...r, checked: true, setUpstream: upstream }));
        continue;
      }
      retarget(root, remote, name, upstream);
    }
    endEdit(refocus);
    return true;
  }, [byRoot, editRemote, editText, editUpstream, editable, editing, endEdit, patchRepo, repos, retarget]);

  /** Focus moved on: the edit is applied if it can be, else dropped — IntelliJ's interrupted edit. */
  const leaveEdit = useCallback(() => {
    if (remoteMenu !== undefined) return;
    if (isValidRefName(editText)) applyEdit(false);
    else endEdit(false);
  }, [applyEdit, editText, endEdit, remoteMenu]);

  const openRemoteMenu = useCallback((root: string, e: ReactMouseEvent<HTMLElement>, inEditor: boolean) => {
    e.stopPropagation();
    const box = e.currentTarget.getBoundingClientRect();
    setRemoteMenu({ root, x: box.left, y: box.bottom, inEditor });
  }, []);

  const toggleChecked = useCallback(
    (root: string, on: boolean) => patchRepo(root, (r) => (r.target !== undefined ? { ...r, checked: on } : r)),
    [patchRepo],
  );

  // ---- the tree's mouse and keys --------------------------------------------------

  const onRowClick = useCallback(
    (index: number, e: ReactMouseEvent<HTMLDivElement>) => {
      const key = keys[index];
      if (key === undefined) return;
      // An edit in progress was applied already: the click took the focus.
      setSelection((cur) =>
        clickSelection(keys, order, cur, index, { toggle: e.ctrlKey || e.metaKey, range: e.shiftKey }),
      );
      setLead(key);
      treeRef.current?.focus();
    },
    [keys, order],
  );

  const showMore = useCallback(
    (root: string) => patchRepo(root, (r) => ({ ...r, shown: r.shown * 2 })),
    [patchRepo],
  );

  const onTreeKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>) => {
      if (editing) return;
      const index = lead !== undefined ? keys.indexOf(lead) : -1;
      const row = rows[index];
      const moveTo = (next: number, extend: boolean): void => {
        const key = keys[next];
        if (key === undefined) return;
        setSelection((cur) =>
          extend ? extendSelection(keys, order, cur, next, Math.max(index, 0)) : { shas: [key], anchor: key },
        );
        setLead(key);
      };
      const target = shiftTarget(e.key, Math.max(index, 0), 10, keys.length);
      if (target !== undefined && !(e.altKey || e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        moveTo(index < 0 ? 0 : target, e.shiftKey);
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
        e.preventDefault();
        setSelection((cur) => selectAll(keys, cur));
        return;
      }
      if (e.key === 'F2') {
        e.preventDefault();
        if (e.altKey && !single) startSync();
        else if (row !== undefined && editable(byRoot.get(row.root))) startEdit(row.root);
        else startSync();
        return;
      }
      if (e.key === ' ') {
        // IntelliJ binds Space on this tree to the checkboxes, and to nothing else.
        e.preventDefault();
        if (single) return;
        for (const [root, on] of toggledByKeyboard(rows, selectedSet, repos)) toggleChecked(root, on);
        return;
      }
      if (!row) return;
      if (e.key === 'ArrowRight' && row.kind === 'repo' && !single) {
        e.preventDefault();
        const repo = byRoot.get(row.root);
        if (!expanded.has(row.root) && repo && hasChildren(repo)) {
          setExpanded((prev) => new Set(prev).add(row.root));
        } else if (expanded.has(row.root)) moveTo(index + 1, false);
        return;
      }
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        if (row.kind === 'repo' && !single && expanded.has(row.root)) {
          setExpanded((prev) => {
            const next = new Set(prev);
            next.delete(row.root);
            return next;
          });
        } else if (row.kind !== 'repo') {
          moveTo(keys.indexOf(repoKey(row.root)), false);
        }
      }
    },
    [byRoot, editable, editing, expanded, keys, lead, order, repos, rows, selectedSet, single, startEdit, startSync, toggleChecked],
  );

  // ---- pushing ---------------------------------------------------------------------

  const chosen = useMemo(() => chosenRepos(repos), [repos]);
  const pushAllowed = canPush(repos, editing !== undefined) && !repos.some((r) => r.loading);
  const tags: PushTagsMode = tagsOn ? tagsMode : 'none';
  const effectiveHooks = params?.showRunHooks === true ? runHooks : true;
  const prohibited = useMemo(
    () => chosen.find((r) => r.target !== undefined && isBranchProtected(r.target.branch, params?.protectedBranches ?? [])),
    [chosen, params?.protectedBranches],
  );

  const argvFor = useCallback(
    (r: RepoState): string[] =>
      r.target === undefined
        ? []
        : buildPushArgs({
            remote: r.target.remote,
            refspec: pushRefspec(r.dto.source, r.target),
            setUpstream: setsUpstream(r.dto.source, r.target, r.dto.sourceTracks, explicitUpstream(r)),
            tags,
            runHooks: effectiveHooks,
            force: false,
            forceIfIncludes: false,
          }),
    [effectiveHooks, tags],
  );

  const submit = useCallback(
    (force: boolean, dontWarn?: { remote: string; branch: string }) => {
      if (!pushAllowed) return;
      accept({
        repos: chosen.flatMap((r) =>
          r.target === undefined
            ? []
            : [
                {
                  root: r.dto.root,
                  source: r.dto.source,
                  target: { remote: r.target.remote, branch: r.target.branch },
                  setUpstream: explicitUpstream(r),
                },
              ],
        ),
        tags,
        runHooks: effectiveHooks,
        force,
        ...(dontWarn !== undefined ? { dontWarnForce: dontWarn } : {}),
      });
    },
    [accept, chosen, effectiveHooks, pushAllowed, tags],
  );

  const forcePush = useCallback(() => {
    if (!pushAllowed || prohibited !== undefined || !params) return;
    const confirm = forcePushConfirmation(
      chosen.flatMap((r) => (r.target !== undefined ? [{ remote: r.target.remote, branch: r.target.branch }] : [])),
      params.silentForceTargets,
    );
    if (confirm === undefined) submit(true);
    else setForceAsk(confirm);
  }, [chosen, params, prohibited, pushAllowed, submit]);

  if (error !== undefined) return <div className="gt-dialog-unknown">{error}</div>;
  if (!params) return <div className="gt-dialog-unknown">Loading…</div>;

  // ---- rendering ------------------------------------------------------------------------

  const renderTarget = (repo: RepoState): JSX.Element => {
    const root = repo.dto.root;
    if (repo.dto.error !== undefined) {
      return (
        <span className="gt-push-error" data-testid="push-repo-error">
          {repo.dto.error}
        </span>
      );
    }
    if (repo.dto.remotes.length === 0) {
      return (
        <button
          type="button"
          className="gt-push-link"
          data-testid="push-define-remote-link"
          onClick={(e) => {
            e.stopPropagation();
            setDefineProblem(undefined);
            setDefineFor(root);
          }}
        >
          Define remote
        </button>
      );
    }
    const target = repo.target;
    if (target === undefined) return <span className="gt-push-error">Cannot push</span>;
    if (editing?.root === root) {
      const base = upstreamCheckboxBase(repo.dto.source, repo.dto.defaultTarget);
      return (
        <PushTargetEditor
          remote={editRemote}
          text={editText}
          variants={targetVariants(repo.dto.recentTargets, editRemote, repo.dto.remoteBranches)}
          showUpstream={showsUpstreamCheckbox(base, editRemote, editText)}
          upstream={editUpstream}
          problem={editProblem}
          onTextChange={(text) => {
            setEditText(text);
            setEditProblem(undefined);
          }}
          onUpstreamChange={setEditUpstream}
          onRemoteClick={(e) => openRemoteMenu(root, e, true)}
          onApply={() => void applyEdit()}
          onCancel={() => endEdit()}
          onLeave={leaveEdit}
        />
      );
    }
    const synced = editing?.sync === true && editable(repo);
    const badge = targetBadge(target, upstreamCheckboxBase(repo.dto.source, repo.dto.defaultTarget), explicitUpstream(repo));
    return (
      <>
        <button
          type="button"
          tabIndex={-1}
          className="gt-push-link"
          data-testid={`push-remote-${repo.dto.label}`}
          onClick={(e) => openRemoteMenu(root, e, false)}
        >
          {target.remote}
        </button>
        <span className="gt-push-sep">{' : '}</span>
        <button
          type="button"
          tabIndex={-1}
          className="gt-push-link gt-push-branch"
          data-testid={`push-target-${repo.dto.label}`}
          title="Click to push to another branch (F2)"
          onClick={(e) => {
            e.stopPropagation();
            startEdit(root);
          }}
        >
          {synced ? editText : target.branch}
        </button>
        {badge !== undefined && !synced ? (
          <span className="gt-push-badge" data-testid={`push-badge-${repo.dto.label}`}>
            {badge}
          </span>
        ) : null}
      </>
    );
  };

  const renderRow = (row: PushRow, index: number): JSX.Element => {
    const isSelected = selectedSet.has(row.key);
    const repo = byRoot.get(row.root);
    const dim = !single && repo !== undefined && !repo.checked;
    const className = `gt-push-row gt-push-${row.kind}-row${isSelected ? ' gt-selected' : ''}${
      row.key === lead ? ' gt-lead' : ''
    }${dim ? ' gt-push-dim' : ''}`;
    const common = {
      id: `gt-push-row-${index}`,
      role: 'treeitem',
      'aria-selected': isSelected,
      className,
      ref: (el: HTMLDivElement | null) => {
        if (el) rowEls.current.set(row.key, el);
        else rowEls.current.delete(row.key);
      },
      onClick: (e: ReactMouseEvent<HTMLDivElement>) => onRowClick(index, e),
    };
    if (row.kind === 'repo' && repo) {
      const open = single || expanded.has(row.root);
      return (
        <div key={row.key} {...common} aria-level={1} aria-expanded={single || !hasChildren(repo) ? undefined : open} data-testid={`push-repo-row-${repo.dto.label}`}>
          {!single ? (
            hasChildren(repo) ? (
              <span
                className={`codicon codicon-chevron-${open ? 'down' : 'right'} gt-push-chevron`}
                aria-hidden="true"
                onClick={(e) => {
                  e.stopPropagation();
                  setExpanded((prev) => {
                    const next = new Set(prev);
                    if (open) next.delete(row.root);
                    else next.add(row.root);
                    return next;
                  });
                }}
              />
            ) : (
              <span className="gt-push-chevron" aria-hidden="true" />
            )
          ) : null}
          {!single ? (
            <input
              type="checkbox"
              tabIndex={-1}
              className="gt-push-check"
              aria-label={`Push ${repo.dto.label}`}
              data-testid={`push-repo-${repo.dto.label}`}
              disabled={repo.target === undefined}
              checked={repo.checked}
              ref={(el) => {
                if (el) el.indeterminate = repo.checked && repo.loading;
              }}
              onClick={(e) => e.stopPropagation()}
              onChange={(e) => toggleChecked(row.root, e.currentTarget.checked)}
            />
          ) : null}
          {!single ? <span className="gt-push-repo-name">{repo.dto.label}</span> : null}
          <span className="gt-push-source">{repo.dto.source.presentation}</span>
          <span className="gt-push-arrow">{' → '}</span>
          {renderTarget(repo)}
          {single && repo.loading ? <span className="gt-muted gt-push-loading">Loading…</span> : null}
        </div>
      );
    }
    if (row.kind === 'commit') {
      return (
        <div key={row.key} {...common} aria-level={2} title={commitTooltip(row.commit)} data-testid="push-commit-row">
          <span className="gt-push-subject">{row.commit.subject}</span>
        </div>
      );
    }
    if (row.kind === 'more') {
      return (
        <div key={row.key} {...common} aria-level={2}>
          <button
            type="button"
            tabIndex={-1}
            className="gt-push-link"
            data-testid="push-more-commits"
            onClick={(e) => {
              e.stopPropagation();
              showMore(row.root);
            }}
          >
            ...
          </button>
        </div>
      );
    }
    return (
      <div key={row.key} {...common} aria-level={2}>
        <span className="gt-push-error">{row.kind === 'error' ? row.text : ''}</span>
      </div>
    );
  };

  const leadIndex = lead !== undefined ? keys.indexOf(lead) : -1;
  const tree = (
    <div className="gt-push-left">
      <div
        ref={treeRef}
        className="gt-push-tree"
        role="tree"
        aria-label="Commits to push"
        aria-multiselectable="true"
        aria-activedescendant={leadIndex >= 0 ? `gt-push-row-${leadIndex}` : undefined}
        tabIndex={0}
        data-testid="push-commits"
        onKeyDown={onTreeKeyDown}
      >
        {rows.map(renderRow)}
      </div>
      {!single ? (
        <div className="gt-push-edit-all">
          <button
            type="button"
            className="gt-push-link"
            data-testid="push-edit-all"
            disabled={editing !== undefined}
            onClick={startSync}
          >
            Edit all targets
          </button>
        </div>
      ) : null}
    </div>
  );

  const fileForSource = selectedFiles.length === 1 ? selectedFiles[0] : undefined;
  const openDiff = (ref: ChangedFileRef | undefined): void => {
    if (!ref) return;
    const files = changeSets.find((c) => c.root === ref.root)?.files ?? [];
    void rpc.request(PUSH_DIALOG_METHODS.openDiff, { root: ref.root, files, index: ref.index });
  };

  const changes = (
    <PushChanges
      repos={changeSets}
      anySelected={selected.count > 0}
      loading={changesLoading}
      grouped={ui.groupByDirectory}
      expandRequest={expandRequest}
      colors={params.colors}
      onSelectedFilesChange={setSelectedFiles}
      onOpen={openDiff}
    />
  );

  const right = (
    <div
      className="gt-push-right"
      onKeyDown={(e) => {
        // IntelliJ's shortcuts for the two file actions.
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'd') {
          e.preventDefault();
          openDiff(selectedFiles[0]);
        } else if (e.key === 'F4' && fileForSource !== undefined) {
          e.preventDefault();
          void rpc.request(PUSH_DIALOG_METHODS.openFile, { root: fileForSource.root, path: fileForSource.file.path });
        }
      }}
    >
      <ToolbarStrip ariaLabel="Changes toolbar">
        <ToolbarButton
          icon="arrow-swap"
          label="Show Diff"
          disabled={selectedFiles.length === 0}
          onClick={() => openDiff(selectedFiles[0])}
        />
        <ToolbarSeparator />
        <ToolbarButton
          icon="eye"
          label="View Options"
          onClick={(e) => {
            const box = e.currentTarget.getBoundingClientRect();
            setViewMenu({ x: box.left, y: box.bottom });
          }}
        />
        <ToolbarButton
          icon="edit"
          label="Edit Source"
          disabled={fileForSource === undefined || fileForSource.file.status.startsWith('D')}
          onClick={() => {
            if (fileForSource !== undefined) {
              void rpc.request(PUSH_DIALOG_METHODS.openFile, {
                root: fileForSource.root,
                path: fileForSource.file.path,
              });
            }
          }}
        />
        <ToolbarSeparator />
        <ToolbarButton
          icon="layout-panel"
          label="Show Details"
          disabled={detailsCommit === undefined}
          toggled={ui.showDetails}
          onClick={() => updateUi({ showDetails: !ui.showDetails })}
        />
        <ToolbarSpacer />
        <ToolbarButton
          icon="expand-all"
          label="Expand All"
          onClick={() => setExpandRequest((r) => ({ all: true, seq: r.seq + 1 }))}
        />
        <ToolbarButton
          icon="collapse-all"
          label="Collapse All"
          onClick={() => setExpandRequest((r) => ({ all: false, seq: r.seq + 1 }))}
        />
      </ToolbarStrip>
      {detailsShown ? (
        <SplitPane
          direction="vertical"
          ratio={ui.detailsRatio}
          defaultRatio={DEFAULT_UI.detailsRatio}
          onRatioChange={(detailsRatio) => updateUi({ detailsRatio }, true)}
          minFirst={60}
          minSecond={60}
          ariaLabel="Changes and commit details"
          className="gt-push-details-split"
          first={changes}
          second={
            <div className="gt-push-details" data-testid="push-details">
              <DetailsPanel
                details={details !== undefined ? [details] : []}
                selectedCount={1}
                loading={details === undefined}
                issue={params.issue}
              />
            </div>
          }
        />
      ) : (
        changes
      )}
    </div>
  );

  const remoteMenuItems = (root: string, current: string): MenuItem[] => {
    const repo = byRoot.get(root);
    return [
      ...(repo?.dto.remotes ?? []).map(
        (r): MenuItem => ({ kind: 'item', id: `remote:${r}`, label: r, checked: r === current }),
      ),
      { kind: 'separator', id: 'sep' },
      { kind: 'item', id: 'define', label: 'Define remote' },
    ];
  };

  const forceItem: MenuItem = {
    kind: 'item',
    id: 'force',
    label: 'Force Push',
    disabled: !pushAllowed || prohibited !== undefined,
    title:
      prohibited?.target !== undefined
        ? `Force push to ${prohibited.target.branch} is prohibited\n${PROTECTED_SETTING_HINT}`
        : PROTECTED_SETTING_HINT,
  };

  const defineRepo = defineFor !== undefined ? byRoot.get(defineFor) : undefined;

  return (
    <Dialog
      title={params.title}
      onCancel={cancel}
      onHelp={help}
      onAction={(id) => {
        if (id === 'cancel') cancel();
        else if (id === 'push') submit(false);
        else if (id === 'force') forcePush();
      }}
      buttons={[
        { id: 'push', label: 'Push', variant: 'default', disabled: !pushAllowed, menu: [forceItem] },
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
          {params.showRunHooks ? (
            <label className="gt-checkbox">
              <input
                type="checkbox"
                data-testid="push-run-hooks"
                checked={runHooks}
                onChange={(e) => setRunHooks(e.currentTarget.checked)}
              />
              <span className="gt-checkbox-body">Run Git hooks</span>
            </label>
          ) : null}
        </>
      }
      className="gt-push-dialog"
    >
      <SplitPane
        direction="horizontal"
        ratio={ui.treeRatio}
        defaultRatio={DEFAULT_UI.treeRatio}
        onRatioChange={(treeRatio) => updateUi({ treeRatio }, true)}
        minFirst={160}
        minSecond={200}
        ariaLabel="Commits and changes"
        className="gt-push-split"
        first={tree}
        second={right}
      />

      {params.showCommandLine ? (
        <div className="gt-push-cmd" data-testid="push-command">
          {chosen.length === 0 ? (
            <div className="gt-muted">Nothing selected to push.</div>
          ) : (
            chosen.map((r) => (
              <div key={r.dto.root}>
                <span className="gt-muted">will run:&nbsp;</span>
                <code>{formatGitCommand(argvFor(r))}</code>
              </div>
            ))
          )}
        </div>
      ) : null}

      {remoteMenu !== undefined ? (
        <Menu
          items={remoteMenuItems(
            remoteMenu.root,
            remoteMenu.inEditor ? editRemote : (byRoot.get(remoteMenu.root)?.target?.remote ?? ''),
          )}
          at={{ x: remoteMenu.x, y: remoteMenu.y }}
          ariaLabel="Remotes"
          onSelect={(id) => {
            const { root, inEditor } = remoteMenu;
            if (id === 'define') {
              if (inEditor) endEdit();
              setDefineProblem(undefined);
              setDefineFor(root);
              return;
            }
            const remote = id.slice('remote:'.length);
            if (inEditor) {
              setEditRemote(remote);
              return;
            }
            const repo = byRoot.get(root);
            if (repo?.target !== undefined && repo.target.remote !== remote) {
              retarget(root, remote, repo.target.branch, repo.setUpstream);
            }
          }}
          onClose={() => setRemoteMenu(undefined)}
        />
      ) : null}

      {viewMenu !== undefined ? (
        <Menu
          items={[
            { kind: 'header', id: 'groupBy', label: 'Group By' },
            { kind: 'item', id: 'directory', label: 'Directory', checked: ui.groupByDirectory },
          ]}
          at={viewMenu}
          ariaLabel="View Options"
          onSelect={(id) => {
            if (id === 'directory') updateUi({ groupByDirectory: !ui.groupByDirectory });
          }}
          onClose={() => setViewMenu(undefined)}
        />
      ) : null}

      {forceAsk !== undefined ? (
        <ForcePushConfirm
          message={forceAsk.message}
          offerDontWarn={forceAsk.target !== undefined}
          onConfirm={(dontWarn) => {
            const target = forceAsk.target;
            setForceAsk(undefined);
            submit(true, dontWarn && target !== undefined ? { remote: target.remote, branch: target.branch } : undefined);
          }}
          onCancel={() => setForceAsk(undefined)}
        />
      ) : null}

      {defineRepo !== undefined ? (
        <DefineRemote
          repoLabel={single ? undefined : defineRepo.dto.label}
          busy={defineBusy}
          problem={defineProblem}
          onCancel={() => setDefineFor(undefined)}
          onSubmit={(value) => {
            const root = defineRepo.dto.root;
            setDefineBusy(true);
            setDefineProblem(undefined);
            rpc
              .request<PushDefineRemoteResultDto>(PUSH_DIALOG_METHODS.defineRemote, { root, ...value })
              .then(
                (res) => {
                  setDefineBusy(false);
                  if (!res.ok) {
                    setDefineProblem({ field: res.field, message: res.message });
                    return;
                  }
                  patchRepo(root, () => ({ ...repoStateOf(res.repo), checked: true }));
                  setExpanded((prev) => new Set(prev).add(root));
                  setDefineFor(undefined);
                  treeRef.current?.focus();
                },
                (err: unknown) => {
                  setDefineBusy(false);
                  setDefineProblem({ field: 'url', message: err instanceof Error ? err.message : String(err) });
                },
              );
          }}
        />
      ) : null}
    </Dialog>
  );
}
