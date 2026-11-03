/**
 * Commit tool window (P11-T2). Layout follows the gap analysis §2A:
 *
 *   tabs  ->  toolbar strip  ->  change tree (flex)  ->  bottom block
 *
 * The bottom block is the amend row with the `N modified` counter, the message
 * editor, and `[Commit] [Commit and Push...]` with the options gear. P11-T4
 * replaces the editor with the IME/undo-hardened one; P11-T5 fills in the gear
 * popup; P11-T6 adds the `Shelf` tab beside `Commit`.
 *
 * The host owns every piece of state. This component renders what it is given
 * and posts intents, so a status refresh or a rehydrate can never desync it.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  COMMIT_METHODS,
  type CommitDiffFileDto,
  type CommitDiffOnScreenDto,
  type CommitFileDiffDto,
  type CommitHistoryDto,
  type CommitMessageEvtDto,
  type CommitOpenDiffParamsDto,
  type CommitRecentCommitsDto,
  type CommitSetIncludedParamsDto,
  type CommitStashStateDto,
  type CommitStateDto,
  type CommitSetCheckedParamsDto,
} from '../../../src/shared/protocol';
import { FileTree } from '../lib/FileTree';
import { InlineDiff } from '../lib/InlineDiff';
import { Menu, type MenuItem } from '../lib/Menu';
import { RpcClient, RpcRequestError } from '../lib/rpc';
import { dirStatusColor, statusColor } from '../lib/status';
import { SplitPane } from '../lib/SplitPane';
import { TabPanel, Tabs } from '../lib/Tabs';
import { ToolbarButton } from '../lib/Toolbar';
import { ToolbarSeparator, ToolbarSpacer, ToolbarStrip } from '../lib/ToolbarStrip';
import {
  allDirPaths,
  ancestorDirs,
  countFiles,
  selectedFiles,
  selectionFollowing,
  type ToggleDelta,
  type TreeNode,
} from '../lib/treeModel';
import { useBusy } from '../lib/useBusy';
import { useElementSize } from '../lib/useElementSize';
import { getVsCodeApi } from '../lib/vscodeApi';
import {
  allDiffFiles,
  assembleCommitTree,
  commitDiffWalk,
  fileCountLabel,
  fileRowContext,
  iconFor,
  partialLabel,
  splitDelta,
  treePathOf,
} from './commitTree';
import { firstLine, relativeTime } from './format';
import { MessageEditor, type MessageEditorHandle } from './MessageEditor';
import { OptionsPopup } from './OptionsPopup';
import { ShelfTab } from './ShelfTab';
import { StashTab } from './StashTab';

interface Persisted {
  tab?: string;
  expanded?: string[];
  message?: string;
  preview?: boolean;
  ratio?: number;
}

/**
 * Commit and rollback open modals and run checks, so they can legitimately sit
 * unanswered far longer than the client's 30 s default.
 */
const INTENT_TIMEOUT_MS = 10 * 60_000;

const EMPTY: CommitStateDto = {
  repos: [],
  targets: [],
  message: '',
  amend: false,
  signing: false,
  busy: false,
  modifiedCount: 0,
  checkedCount: 0,
  paradigm: 'changelists',
};

/** A message dropdown (history clock or Amend ▾), anchored under its button. */
interface MessageMenu {
  label: string;
  x: number;
  y: number;
  items: MenuItem[];
  /** Index-aligned with `items`: the full multi-line message each inserts. */
  messages: string[];
}

export function App() {
  const rpc = useMemo(() => new RpcClient(), []);
  const api = useMemo(() => getVsCodeApi(), []);
  const saved = (api.getState() as Persisted | undefined) ?? {};

  const [state, setState] = useState<CommitStateDto>(EMPTY);
  const [ready, setReady] = useState(false);
  const [tab, setTab] = useState(saved.tab ?? 'commit');
  // POST-P14l: IntelliJ's `Combine stashes and shelves in one tab`. Off by
  // default, so the strip is `Commit | Shelf | Stash`; on, the Stash tab folds
  // into the Shelf tab and the third tab disappears.
  const [combined, setCombined] = useState(false);

  useEffect(() => {
    const off = rpc.onEvent(COMMIT_METHODS.evtStash, (payload) => {
      setCombined((payload as CommitStashStateDto | undefined)?.combined === true);
    });
    rpc
      .request<CommitStashStateDto>(COMMIT_METHODS.stashState)
      .then((next) => setCombined(next?.combined === true), () => undefined);
    return off;
  }, [rpc]);

  // Turning the setting on while the Stash tab is showing would leave `tab`
  // naming a tab that no longer exists, and every panel renders null.
  useEffect(() => {
    if (combined && tab === 'stash') setTab('shelf');
  }, [combined, tab]);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(
    () => new Set(saved.expanded ?? []),
  );
  const [selection, setSelection] = useState<ReadonlySet<string>>(() => new Set());
  const [reveal, setReveal] = useState<{ readonly path: string } | undefined>(undefined);
  // The file a diff opened from the list is showing, while it is on screen.
  const [diffOnScreen, setDiffOnScreen] = useState<CommitDiffFileDto | undefined>(undefined);
  // Mirror of the uncontrolled editor's value — drives `canCommit`, the
  // webview-state persist, and re-seeds the editor when its TabPanel remounts
  // after a Shelf-tab round trip (P11-T6). The editor owns the DOM value; a
  // changing `initial` never touches it after mount, and mid-composition the
  // mirror is frozen because onInput is suppressed (P11-T4).
  const [message, setMessage] = useState(saved.message ?? '');
  const [menu, setMenu] = useState<MessageMenu | null>(null);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [preview, setPreview] = useState(saved.preview ?? false);
  const [ratio, setRatio] = useState(saved.ratio ?? 0.55);
  const [diff, setDiff] = useState<CommitFileDiffDto | undefined>(undefined);
  const [rpcError, setRpcError] = useState<string | undefined>(undefined);
  const [treeRef, treeSize] = useElementSize<HTMLDivElement>();
  const [diffRef, diffSize] = useElementSize<HTMLDivElement>();
  const seededExpansion = useRef(false);
  const editorRef = useRef<MessageEditorHandle | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;

  const model = useMemo(() => assembleCommitTree(state), [state]);
  const modelRef = useRef(model);
  modelRef.current = model;
  const selectionRef = useRef(selection);
  selectionRef.current = selection;

  const apply = useCallback((next: CommitStateDto) => {
    setState(next);
    setDiffOnScreen(next.diffOnScreen);
    setReady(true);
  }, []);

  useEffect(() => {
    const offState = rpc.onEvent(COMMIT_METHODS.evtState, (p) => apply(p as CommitStateDto));
    // Programmatic message writes (history pick via the native command, amend
    // prefill, post-commit clear) arrive on their own event. Generic state
    // pushes never touch the editor: they can carry a snapshot older than the
    // debounced persist, and applying one would eat the user's last keystrokes.
    const offMessage = rpc.onEvent(COMMIT_METHODS.evtMessage, (p) => {
      const m = p as CommitMessageEvtDto;
      if (m.repoRoot !== stateRef.current.activeRepo) return;
      editorRef.current?.setProgrammatic(m.message);
    });
    rpc.request<CommitStateDto>(COMMIT_METHODS.init).then(apply, () => setReady(true));
    return () => {
      offState();
      offMessage();
    };
  }, [apply, rpc]);

  // Adopt the host's message only when the repo under the editor changes —
  // which includes the first snapshot. Everything else comes via evtMessage.
  const editorRepo = useRef<{ root: string | undefined } | null>(null);
  useEffect(() => {
    if (!ready) return;
    if (editorRepo.current !== null && editorRepo.current.root === state.activeRepo) return;
    editorRepo.current = { root: state.activeRepo };
    editorRef.current?.adoptExternal(state.message);
  }, [ready, state]);

  // Expand every group and folder the first time real content arrives, the way
  // the IntelliJ commit window opens.
  useEffect(() => {
    if (seededExpansion.current || model.nodes.length === 0) return;
    seededExpansion.current = true;
    if ((saved.expanded ?? []).length === 0) {
      setExpanded(new Set(allDirPaths(model.nodes)));
    }
  }, [model.nodes, saved.expanded]);

  useEffect(() => {
    api.setState({
      tab,
      expanded: [...expanded],
      message,
      preview,
      ratio,
    } satisfies Persisted);
  }, [api, expanded, message, preview, ratio, tab]);

  const activeRepo = state.activeRepo;

  /**
   * Every webview→host intent is an RPC **request**, matching what
   * `WebviewRpcHost.on()` registers. `sendEvent` posts `kind: 'evt'`, which
   * only reaches `onEvent` listeners — a mismatch no handler ever sees, so it
   * fails in total silence. Reporting the rejection is the point: an intent
   * that never lands must be visible, not invisible.
   */
  const request = useCallback(
    (method: string, params: unknown = {}): Promise<void> =>
      rpc.request(method, params, INTENT_TIMEOUT_MS).then(
        () => setRpcError(undefined),
        (err: unknown) => {
          // A timeout means the host is slow or the user is sitting in a modal;
          // the state push will tell the truth. Only routing and handler
          // failures are worth interrupting for.
          if (err instanceof RpcRequestError && err.code === 'timeout') return;
          setRpcError(err instanceof Error ? err.message : String(err));
        },
      ),
    [rpc],
  );
  const send = useCallback(
    (method: string, params: unknown = {}) => {
      void request(method, params);
    },
    [request],
  );
  /**
   * A walk over the whole list goes on following it, as IntelliJ's does: this list
   * changes while you read it, unlike a commit's. One over a selection is what was
   * selected.
   */
  const walksWholeList = useRef(false);

  const openDiffAt = useCallback(
    (treePath: string) => {
      const ref = modelRef.current.files.get(treePath);
      if (!ref) return;
      const walk = commitDiffWalk(modelRef.current, selectionRef.current, treePath);
      walksWholeList.current = !walk.explicit;
      send(COMMIT_METHODS.openDiff, {
        repoRoot: ref.repoRoot,
        path: ref.relPath,
        files: walk.files,
      } satisfies CommitOpenDiffParamsDto);
    },
    [send],
  );

  const listKey = useMemo(
    () =>
      allDiffFiles(model)
        .map((f) => `${f.repoRoot}\n${f.path}`)
        .join('\n'),
    [model],
  );
  useEffect(() => {
    if (walksWholeList.current) {
      send(COMMIT_METHODS.diffChain, { files: allDiffFiles(modelRef.current) });
    }
  }, [listKey, send]);

  useEffect(() => {
    // The walk moved on: the row follows, and nothing opens again.
    const offMoved = rpc.onEvent(COMMIT_METHODS.evtDiffFile, (p) => {
      const current = modelRef.current;
      const treePath = treePathOf(current, p as CommitDiffFileDto);
      if (treePath === undefined) return;
      setExpanded((prev) => new Set([...prev, ...ancestorDirs(current.nodes, treePath)]));
      setSelection((prev) => selectionFollowing(current.nodes, prev, treePath));
      setReveal({ path: treePath });
    });
    const offOpen = rpc.onEvent(COMMIT_METHODS.evtOpenDiff, (p) => {
      const treePath = treePathOf(modelRef.current, p as CommitDiffFileDto);
      if (treePath !== undefined) openDiffAt(treePath);
    });
    const offOnScreen = rpc.onEvent(COMMIT_METHODS.evtDiffOnScreen, (p) => {
      setDiffOnScreen((p as CommitDiffOnScreenDto).file);
    });
    return () => {
      offMoved();
      offOpen();
      offOnScreen();
    };
  }, [openDiffAt, rpc]);

  // Looked up in each new tree, so a file moved to another changelist keeps its mark.
  const onScreenPath = useMemo(
    () => (diffOnScreen !== undefined ? treePathOf(model, diffOnScreen) : undefined),
    [diffOnScreen, model],
  );

  // Refresh turns until the host has re-read every repository and pushed the
  // state it found — the moment the badge and the tree are current.
  const [refreshing, trackRefresh] = useBusy();

  const onToggleCheck = useCallback(
    (delta: ToggleDelta) => {
      for (const part of splitDelta(delta, model)) {
        send(COMMIT_METHODS.setChecked, {
          repoRoot: part.repoRoot,
          paths: part.paths,
          checked: part.checked,
        } satisfies CommitSetCheckedParamsDto);
      }
    },
    [model, send],
  );

  const onToggleExpand = useCallback((path: string, open: boolean) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (open) next.add(path);
      else next.delete(path);
      return next;
    });
  }, []);

  const description = useCallback(
    (node: TreeNode): string | undefined => {
      if (node.kind === 'dir') return fileCountLabel(countFiles(node));
      const ref = model.files.get(node.path);
      if (!ref) return undefined;
      // A partially-included file says so first: it is the one row whose
      // checkbox does not tell the whole story.
      if (ref.change.partial !== undefined) return partialLabel(ref.change.partial);
      const dir = ref.relPath.includes('/')
        ? ref.relPath.slice(0, ref.relPath.lastIndexOf('/'))
        : '';
      return ref.change.origPath !== undefined ? `${ref.change.origPath} ->` : dir;
    },
    [model],
  );

  const icon = useCallback(
    (node: TreeNode) => {
      if (node.kind === 'dir') {
        // P11-T8: a folder of modified descendants wears the modified color.
        const color = dirStatusColor(model.dirKinds.get(node.path) ?? new Set(), state.colors);
        return color !== undefined ? { codicon: 'folder', color } : { codicon: 'folder' };
      }
      const ref = model.files.get(node.path);
      return ref ? iconFor(ref.change, state.colors) : { codicon: 'file' };
    },
    [model, state.colors],
  );

  // IntelliJ colors the file *names*, not only the icons (P11-T8).
  const nameColor = useCallback(
    (node: TreeNode): string | undefined => {
      if (node.kind === 'dir') {
        return dirStatusColor(model.dirKinds.get(node.path) ?? new Set(), state.colors);
      }
      const ref = model.files.get(node.path);
      return ref ? statusColor(ref.change.kind, state.colors) : undefined;
    },
    [model, state.colors],
  );

  /**
   * P14-T2: native context menus for the change tree. The changelists tree view
   * used to be the only place a changelist could be renamed, deleted or made
   * active; once it goes, this is that home. Labels are static, so master §9's
   * native-menu rule applies (the kit `Menu` is for interpolated labels).
   *
   * POST-P14v: file rows carry the whole selection, so `Add to VCS` and the
   * other file verbs act on a Ctrl-clicked set rather than on one row.
   */
  const rowContext = useCallback(
    (node: TreeNode): Record<string, unknown> | undefined => {
      const group = model.groups.get(node.path);
      if (group) {
        return {
          preventDefaultContextMenuItems: true,
          // A `repo` row is one repository's copy of the list; a `group` row may
          // be several, so scoped-only actions live on the repository row.
          webviewSection: group.kind === 'repo' ? 'commitRepo' : 'commitGroup',
          ...(group.repoRoot !== undefined ? { repoRoot: group.repoRoot } : {}),
          ...(group.listId !== undefined ? { listId: group.listId } : {}),
          targets: group.targets,
          listIsDefault: group.isDefault,
          listCheckable: group.checkable,
          listSpansRepos: group.targets.length > 1,
        };
      }
      return fileRowContext(model, node.path, selection);
    },
    [model, selection],
  );

  const selectedRelPaths = useCallback((): { repoRoot: string; paths: string[] } | undefined => {
    const refs = [...selection]
      .map((p) => model.files.get(p))
      .filter((r): r is NonNullable<typeof r> => r !== undefined);
    const first = refs[0];
    if (!first) return undefined;
    return {
      repoRoot: first.repoRoot,
      paths: refs.filter((r) => r.repoRoot === first.repoRoot).map((r) => r.relPath),
    };
  }, [model, selection]);

  // ---- preview diff (P11-T3) ------------------------------------------------

  /** The preview pane follows a single selected file; it has no meaning for many. */
  const selectedFile = useMemo(() => {
    if (selection.size !== 1) return undefined;
    const [only] = [...selection];
    return only === undefined ? undefined : model.files.get(only);
  }, [model, selection]);

  const diffRepo = selectedFile?.repoRoot;
  const diffPath = selectedFile?.relPath;

  useEffect(() => {
    if (!preview || diffRepo === undefined || diffPath === undefined) {
      setDiff(undefined);
      return;
    }
    let cancelled = false;
    rpc
      .request<CommitFileDiffDto | undefined>(COMMIT_METHODS.fileDiff, {
        repoRoot: diffRepo,
        path: diffPath,
      })
      .then(
        (next) => {
          if (!cancelled) setDiff(next ?? undefined);
        },
        () => {
          if (!cancelled) setDiff(undefined);
        },
      );
    return () => {
      cancelled = true;
    };
    // `state` is a dependency on purpose: a refresh, a rollback or an inclusion
    // toggle all land as a state push, and each can change what this file's
    // changes are. Re-reading is cheaper than showing a diff that has moved on.
  }, [diffPath, diffRepo, preview, rpc, state]);

  const includedSet = useMemo(() => {
    // An unticked file contributes nothing, so none of its changes are in —
    // showing them all ticked would contradict the tree row right above.
    if (!diff || !diff.checked) return new Set<number>();
    return new Set(diff.included ?? diff.changes.map((_, i) => i));
  }, [diff]);

  const onToggleInclude = useCallback(
    (index: number, next: boolean) => {
      if (!diff || diffRepo === undefined || diffPath === undefined) return;
      const included = new Set(includedSet);
      if (next) included.add(index);
      else included.delete(index);
      send(COMMIT_METHODS.setIncluded, {
        repoRoot: diffRepo,
        path: diffPath,
        included: [...included].sort((a, b) => a - b),
        signature: diff.signature,
      } satisfies CommitSetIncludedParamsDto);
    },
    [diff, diffPath, diffRepo, includedSet, send],
  );

  // ---- message editor (P11-T4) ----------------------------------------------

  const onEditorInput = useCallback((value: string) => setMessage(value), []);
  const activeRepoRef = useRef(activeRepo);
  activeRepoRef.current = activeRepo;
  const onEditorPersist = useCallback(
    (value: string) => {
      const repoRoot = activeRepoRef.current;
      if (repoRoot === undefined) return;
      send(COMMIT_METHODS.setMessage, { repoRoot, message: value });
    },
    [send],
  );

  /** Opens the history clock or Amend ▾ dropdown under its button. */
  const openMessageMenu = useCallback(
    async (anchor: HTMLElement, kind: 'history' | 'amend') => {
      const repoRoot = activeRepoRef.current;
      if (repoRoot === undefined) return;
      const rect = anchor.getBoundingClientRect();
      const at = { x: rect.left, y: rect.bottom + 2 };
      try {
        if (kind === 'history') {
          const res = await rpc.request<CommitHistoryDto>(COMMIT_METHODS.messageHistory, {
            repoRoot,
          });
          const entries = res?.entries ?? [];
          setMenu({
            label: 'Commit message history',
            ...at,
            items:
              entries.length === 0
                ? [{ kind: 'item', id: 'empty', label: 'No commit message history yet.', disabled: true }]
                : entries.map((e, i) => ({
                    kind: 'item' as const,
                    id: String(i),
                    label: firstLine(e.message),
                    accelerator: relativeTime(e.ts, Date.now()),
                  })),
            messages: entries.map((e) => e.message),
          });
        } else {
          const res = await rpc.request<CommitRecentCommitsDto>(COMMIT_METHODS.recentCommits, {
            repoRoot,
          });
          const commits = res?.commits ?? [];
          setMenu({
            label: 'Reuse commit message',
            ...at,
            items:
              commits.length === 0
                ? [{ kind: 'item', id: 'empty', label: 'No commits yet.', disabled: true }]
                : commits.map((c, i) => ({
                    kind: 'item' as const,
                    id: String(i),
                    label: c.subject,
                    accelerator: c.shortSha,
                  })),
            messages: commits.map((c) => c.message),
          });
        }
      } catch (err) {
        setRpcError(err instanceof Error ? err.message : String(err));
      }
    },
    [rpc],
  );

  const onMenuSelect = useCallback(
    (id: string) => {
      const text = menu?.messages[Number(id)];
      setMenu(null);
      // Deferred one tick: the closing menu restores focus to the button that
      // opened it, and the editor must win that race after a pick.
      if (text !== undefined) window.setTimeout(() => editorRef.current?.insert(text), 0);
    },
    [menu],
  );

  const commit = (andPush: boolean): void => {
    if (activeRepo === undefined) return;
    // A half-typed message may still be inside the debounce window; the flush
    // posts it first, and the host processes messages in arrival order.
    editorRef.current?.flush();
    send(COMMIT_METHODS.commit, { repoRoot: activeRepo, andPush });
  };

  const canCommit =
    !state.busy &&
    activeRepo !== undefined &&
    (state.amend || message.trim().length > 0) &&
    (state.amend || state.checkedCount > 0 || state.paradigm === 'staging');

  // The tree spans every repository, so in a multi-root workspace a bare
  // `Commit` leaves the scope invisible — which is how a commit lands in the
  // wrong repo unnoticed. Single-root workspaces keep the plain label.
  // Defensive despite the DTO requiring it: this crosses `postMessage`, where
  // the compiler enforces nothing, and a missing field must not blank the
  // whole panel — which is exactly what it did the first time.
  const targets = state.targets ?? [];
  const commitLabel =
    state.repos.length < 2 || targets.length === 0
      ? 'Commit'
      : targets.length === 1
        ? `Commit to ${targets[0]}`
        : `Commit to ${targets.length} repositories`;
  const targetTitle = targets.length > 0 ? `Commits: ${targets.join(', ')}` : undefined;

  const nothingToShow = ready && model.nodes.length === 0;
  const errorText = state.error ?? rpcError;

  const treePane = nothingToShow ? (
    <div className="gt-commit-empty" data-testid="commit-empty">
      No changes.
    </div>
  ) : (
    <FileTree
      nodes={model.nodes}
      height={Math.max(0, treeSize.height)}
      ariaLabel="Changes"
      expanded={expanded}
      onToggleExpand={onToggleExpand}
      checked={model.checked}
      checkboxless={model.checkboxless}
      onToggleCheck={onToggleCheck}
      selection={selection}
      onSelectionChange={(paths) => setSelection(new Set(paths))}
      onActivate={(node) => {
        if (!model.files.has(node.path)) return;
        openDiffAt(node.path);
        // Enter opens the keyboard's row, which the arrows moved without
        // selecting: the selection goes with the diff, as it does on a walk.
        setSelection((prev) =>
          prev.size === 1 && prev.has(node.path) ? prev : selectionFollowing(model.nodes, prev, node.path),
        );
      }}
      description={description}
      icon={icon}
      nameColor={nameColor}
      rowContext={rowContext}
      {...(reveal !== undefined ? { reveal } : {})}
      {...(onScreenPath !== undefined ? { current: onScreenPath } : {})}
    />
  );

  const previewPane = ((): JSX.Element => {
    if (!selectedFile) {
      return (
        <div className="gt-commit-empty" data-testid="preview-hint">
          Select one file to review and include its changes.
        </div>
      );
    }
    if (!diff) {
      return <div className="gt-commit-empty">Loading changes…</div>;
    }
    if (diff.wholeFileOnly) {
      // Binary, or a file with only one side. Offering checkboxes here would
      // promise a granularity the commit cannot deliver.
      return (
        <div className="gt-commit-empty" data-testid="preview-whole-file">
          {selectedFile.relPath} commits as a whole file.
        </div>
      );
    }
    return (
      <InlineDiff
        originalText={diff.originalText}
        modifiedText={diff.modifiedText}
        changes={diff.changes}
        leftLabel="HEAD"
        rightLabel={selectedFile.relPath}
        height={Math.max(0, diffSize.height)}
        included={includedSet}
        onToggleInclude={onToggleInclude}
      />
    );
  })();

  return (
    <div className="gt-commit">
      <Tabs
        ariaLabel="Commit tool window"
        active={tab}
        onChange={setTab}
        tabs={[
          { id: 'commit', label: 'Commit' },
          { id: 'shelf', label: 'Shelf' },
          ...(combined ? [] : [{ id: 'stash', label: 'Stash' }]),
        ]}
      />

      {/* Window-level, not per-tab: a failed shelf action must be visible from
          the Shelf tab exactly like a failed commit is from the Commit tab. */}
      {errorText !== undefined ? (
        <div className="gt-commit-error" role="alert" data-testid="commit-error">
          {errorText}
        </div>
      ) : null}

      <TabPanel id="commit" active={tab} className="gt-commit-panel">
        <ToolbarStrip ariaLabel="Commit actions">
          <ToolbarButton
            icon="refresh"
            label="Refresh"
            disabled={state.busy}
            busy={refreshing}
            onClick={() => trackRefresh(() => request(COMMIT_METHODS.refresh))}
          />
          <ToolbarButton
            icon="discard"
            label="Rollback"
            disabled={state.busy || selection.size === 0}
            onClick={() => {
              const target = selectedRelPaths();
              if (target) send(COMMIT_METHODS.rollback, target);
            }}
          />
          <ToolbarButton
            icon="diff"
            label="Show Diff"
            disabled={selection.size === 0}
            onClick={() => {
              const first = selectedFiles(model.nodes, selection)[0];
              if (first !== undefined) openDiffAt(first);
            }}
          />
          <ToolbarButton
            icon="archive"
            label="Shelve Changes"
            disabled={state.busy || activeRepo === undefined}
            onClick={() => send(COMMIT_METHODS.shelve, { repoRoot: activeRepo })}
          />
          <ToolbarButton
            icon="split-horizontal"
            label="Preview Diff"
            toggled={preview}
            onClick={() => setPreview((on) => !on)}
          />
          <ToolbarSeparator />
          <ToolbarButton
            icon="expand-all"
            label="Expand all"
            onClick={() => setExpanded(new Set(allDirPaths(model.nodes)))}
          />
          <ToolbarButton
            icon="collapse-all"
            label="Collapse all"
            onClick={() => setExpanded(new Set())}
          />
          <ToolbarSpacer />
        </ToolbarStrip>

        <div className="gt-commit-body" data-testid="commit-tree">
          {preview ? (
            <SplitPane
              direction="vertical"
              ariaLabel="Changes and diff preview"
              ratio={ratio}
              onRatioChange={setRatio}
              minFirst={80}
              minSecond={80}
              first={
                <div className="gt-commit-pane" ref={treeRef}>
                  {treePane}
                </div>
              }
              second={
                <div className="gt-commit-pane" ref={diffRef} data-testid="commit-preview">
                  {previewPane}
                </div>
              }
            />
          ) : (
            <div className="gt-commit-pane" ref={treeRef}>
              {treePane}
            </div>
          )}
        </div>

        <div className="gt-commit-bottom">
          <div className="gt-commit-amend-row">
            <label className="gt-checkbox">
              <input
                type="checkbox"
                checked={state.amend}
                disabled={state.busy || activeRepo === undefined}
                onChange={() => send(COMMIT_METHODS.toggleAmend, { repoRoot: activeRepo })}
              />
              <span className="gt-checkbox-body">
                <span>
                  Amend <span className="gt-muted">last commit</span>
                </span>
              </span>
            </label>
            <ToolbarButton
              icon="chevron-down"
              label="Reuse a recent commit message"
              disabled={activeRepo === undefined}
              onClick={(e) => void openMessageMenu(e.currentTarget, 'amend')}
            />
            <ToolbarButton
              icon="history"
              label="Commit message history"
              disabled={activeRepo === undefined}
              onClick={(e) => void openMessageMenu(e.currentTarget, 'history')}
            />
            <span className="gt-commit-counter" data-testid="commit-counter">
              {state.checkedCount} of {fileCountLabel(state.modifiedCount)}
            </span>
          </div>

          <MessageEditor
            ref={editorRef}
            initial={message}
            disabled={activeRepo === undefined}
            onInput={onEditorInput}
            onPersist={onEditorPersist}
          />

          <div className="gt-commit-actions">
            <button
              type="button"
              className="gt-button gt-primary"
              data-testid="commit-button"
              disabled={!canCommit}
              title={targetTitle}
              onClick={() => commit(false)}
            >
              {commitLabel}
            </button>
            <button
              type="button"
              className="gt-button"
              data-testid="commit-push-button"
              disabled={!canCommit}
              title={targetTitle}
              onClick={() => commit(true)}
            >
              Commit and Push...
            </button>
            <ToolbarSpacer />
            <ToolbarButton
              icon="gear"
              label="Commit options"
              disabled={activeRepo === undefined}
              toggled={optionsOpen}
              onClick={() => setOptionsOpen((open) => !open)}
            />
          </div>
        </div>
      </TabPanel>

      <TabPanel id="shelf" active={tab} className="gt-commit-panel">
        <ShelfTab rpc={rpc} send={send} colors={state.colors} />
        {/* `Combine stashes and shelves in one tab`: the stashes render under
            the shelves rather than in a tab of their own. */}
        {combined ? <StashTab rpc={rpc} send={send} colors={state.colors} embedded /> : null}
      </TabPanel>

      {combined ? null : (
        <TabPanel id="stash" active={tab} className="gt-commit-panel">
          <StashTab rpc={rpc} send={send} colors={state.colors} />
        </TabPanel>
      )}

      {optionsOpen && activeRepo !== undefined ? (
        <OptionsPopup rpc={rpc} repoRoot={activeRepo} onClose={() => setOptionsOpen(false)} />
      ) : null}

      {menu !== null ? (
        <Menu
          items={menu.items}
          at={{ x: menu.x, y: menu.y }}
          ariaLabel={menu.label}
          onSelect={onMenuSelect}
          onClose={() => setMenu(null)}
        />
      ) : null}
    </div>
  );
}
