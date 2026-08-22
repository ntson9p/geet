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
  type CommitStateDto,
  type CommitSetCheckedParamsDto,
} from '../../../src/shared/protocol';
import { FileTree } from '../lib/FileTree';
import { RpcClient } from '../lib/rpc';
import { TabPanel, Tabs } from '../lib/Tabs';
import { ToolbarButton } from '../lib/Toolbar';
import { ToolbarSeparator, ToolbarSpacer, ToolbarStrip } from '../lib/ToolbarStrip';
import { allDirPaths, countFiles, type ToggleDelta, type TreeNode } from '../lib/treeModel';
import { useElementSize } from '../lib/useElementSize';
import { getVsCodeApi } from '../lib/vscodeApi';
import { assembleCommitTree, fileCountLabel, iconFor, splitDelta } from './commitTree';

interface Persisted {
  tab?: string;
  expanded?: string[];
  message?: string;
}

const EMPTY: CommitStateDto = {
  repos: [],
  message: '',
  amend: false,
  signing: false,
  busy: false,
  modifiedCount: 0,
  checkedCount: 0,
  paradigm: 'changelists',
};

export function App() {
  const rpc = useMemo(() => new RpcClient(), []);
  const api = useMemo(() => getVsCodeApi(), []);
  const saved = (api.getState() as Persisted | undefined) ?? {};

  const [state, setState] = useState<CommitStateDto>(EMPTY);
  const [ready, setReady] = useState(false);
  const [tab, setTab] = useState(saved.tab ?? 'commit');
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(
    () => new Set(saved.expanded ?? []),
  );
  const [selection, setSelection] = useState<ReadonlySet<string>>(() => new Set());
  const [message, setMessage] = useState(saved.message ?? '');
  const [treeRef, treeSize] = useElementSize<HTMLDivElement>();
  const seededExpansion = useRef(false);

  const model = useMemo(() => assembleCommitTree(state), [state]);

  const apply = useCallback((next: CommitStateDto) => {
    setState(next);
    setReady(true);
  }, []);

  useEffect(() => {
    const off = rpc.onEvent(COMMIT_METHODS.evtState, (p) => apply(p as CommitStateDto));
    rpc.request<CommitStateDto>(COMMIT_METHODS.init).then(apply, () => setReady(true));
    return off;
  }, [apply, rpc]);

  // The host is the source of truth for the message, but only adopt its value
  // when it actually differs — echoing every keystroke back would fight the
  // editor's undo stack (hardened in P11-T4).
  useEffect(() => {
    setMessage((current) => (state.message === current ? current : state.message));
  }, [state.message]);

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
    api.setState({ tab, expanded: [...expanded], message } satisfies Persisted);
  }, [api, expanded, message, tab]);

  const activeRepo = state.activeRepo;

  const onToggleCheck = useCallback(
    (delta: ToggleDelta) => {
      for (const part of splitDelta(delta, model)) {
        rpc.sendEvent(COMMIT_METHODS.setChecked, {
          repoRoot: part.repoRoot,
          paths: part.paths,
          checked: part.checked,
        } satisfies CommitSetCheckedParamsDto);
      }
    },
    [model, rpc],
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
      const dir = ref.relPath.includes('/')
        ? ref.relPath.slice(0, ref.relPath.lastIndexOf('/'))
        : '';
      return ref.change.origPath !== undefined ? `${ref.change.origPath} ->` : dir;
    },
    [model],
  );

  const icon = useCallback(
    (node: TreeNode) => {
      if (node.kind === 'dir') return { codicon: 'folder' };
      const ref = model.files.get(node.path);
      return ref ? iconFor(ref.change) : { codicon: 'file' };
    },
    [model],
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

  const send = useCallback(
    (method: string, params: unknown = {}) => {
      rpc.sendEvent(method, params);
    },
    [rpc],
  );

  const commit = (andPush: boolean): void => {
    if (activeRepo === undefined) return;
    send(COMMIT_METHODS.commit, { repoRoot: activeRepo, andPush });
  };

  const canCommit =
    !state.busy &&
    activeRepo !== undefined &&
    (state.amend || message.trim().length > 0) &&
    (state.amend || state.checkedCount > 0 || state.paradigm === 'staging');

  const nothingToShow = ready && model.nodes.length === 0;

  return (
    <div className="gt-commit">
      <Tabs
        ariaLabel="Commit tool window"
        active={tab}
        onChange={setTab}
        tabs={[{ id: 'commit', label: 'Commit' }]}
      />

      <TabPanel id="commit" active={tab} className="gt-commit-panel">
        <ToolbarStrip ariaLabel="Commit actions">
          <ToolbarButton
            icon="refresh"
            label="Refresh"
            disabled={state.busy}
            onClick={() => send(COMMIT_METHODS.refresh)}
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
              const target = selectedRelPaths();
              const first = target?.paths[0];
              if (target && first !== undefined) {
                send(COMMIT_METHODS.openDiff, { repoRoot: target.repoRoot, path: first });
              }
            }}
          />
          <ToolbarButton
            icon="archive"
            label="Shelve Changes"
            disabled={state.busy || activeRepo === undefined}
            onClick={() => send(COMMIT_METHODS.shelve, { repoRoot: activeRepo })}
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

        <div className="gt-commit-tree" ref={treeRef} data-testid="commit-tree">
          {nothingToShow ? (
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
                const ref = model.files.get(node.path);
                if (ref) send(COMMIT_METHODS.openDiff, { repoRoot: ref.repoRoot, path: ref.relPath });
              }}
              description={description}
              icon={icon}
            />
          )}
        </div>

        {state.error !== undefined ? (
          <div className="gt-commit-error" role="alert" data-testid="commit-error">
            {state.error}
          </div>
        ) : null}

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
              icon="history"
              label="Commit message history"
              onClick={() => send(COMMIT_METHODS.showHistory, { repoRoot: activeRepo })}
            />
            <span className="gt-commit-counter" data-testid="commit-counter">
              {state.checkedCount} of {fileCountLabel(state.modifiedCount)}
            </span>
          </div>

          <textarea
            className="gt-input gt-commit-message"
            aria-label="Commit message"
            data-testid="commit-message"
            rows={6}
            value={message}
            disabled={activeRepo === undefined}
            onChange={(e) => {
              setMessage(e.currentTarget.value);
              send(COMMIT_METHODS.setMessage, {
                repoRoot: activeRepo,
                message: e.currentTarget.value,
              });
            }}
          />

          <div className="gt-commit-actions">
            <button
              type="button"
              className="gt-button gt-primary"
              data-testid="commit-button"
              disabled={!canCommit}
              onClick={() => commit(false)}
            >
              Commit
            </button>
            <button
              type="button"
              className="gt-button"
              data-testid="commit-push-button"
              disabled={!canCommit}
              onClick={() => commit(true)}
            >
              Commit and Push...
            </button>
            <ToolbarSpacer />
            <ToolbarButton
              icon="gear"
              label="Commit options"
              onClick={() => send(COMMIT_METHODS.showOptions, { repoRoot: activeRepo })}
            />
          </div>
        </div>
      </TabPanel>
    </div>
  );
}
