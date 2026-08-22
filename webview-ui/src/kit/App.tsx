/**
 * P11-T1 kit harness: mounts every piece of the shared UI kit with readouts so
 * Playwright can assert behaviour (tri-state rollup, keyboard tree navigation,
 * menu submenus, splitter, dialog focus trap, per-change diff inclusion).
 *
 * Dev-only — `kit.html` is not a vite `apps` entry, so none of this ships.
 */
import { useMemo, useState } from 'react';
import { Dialog } from '../lib/Dialog';
import { FileTree } from '../lib/FileTree';
import { InlineDiff } from '../lib/InlineDiff';
import { Menu, type MenuItem } from '../lib/Menu';
import { SplitPane } from '../lib/SplitPane';
import { TabPanel, Tabs } from '../lib/Tabs';
import { ToolbarButton } from '../lib/Toolbar';
import { ToolbarDropdown, ToolbarSeparator, ToolbarSpacer, ToolbarStrip } from '../lib/ToolbarStrip';
import { Checkbox } from '../lib/TriCheckbox';
import {
  allDirPaths,
  buildTree,
  countFiles,
  type ToggleDelta,
  type TreeNode,
} from '../lib/treeModel';
import type { LineChangeDto } from '../../../src/shared/protocol';

const PATHS = [
  'src/main/java/api/ArticleDataController.java',
  'src/main/java/api/CommentController.java',
  'src/main/java/util/Strings.java',
  'docs/guide.md',
  '1.txt',
];

const ORIGINAL = 'abcx\nab\ndef\n';
const MODIFIED = 'abcx\nab\n123\ndef\nxxx\n';
const CHANGES: LineChangeDto[] = [
  { originalStartLineNumber: 2, originalEndLineNumber: 0, modifiedStartLineNumber: 3, modifiedEndLineNumber: 3 },
  { originalStartLineNumber: 3, originalEndLineNumber: 0, modifiedStartLineNumber: 5, modifiedEndLineNumber: 5 },
];

const BRANCH_MENU: MenuItem[] = [
  { kind: 'item', id: 'checkout', label: 'Checkout' },
  { kind: 'item', id: 'new-branch', label: "New Branch from 'feature/f1-1'..." },
  { kind: 'separator', id: 's1' },
  {
    kind: 'submenu',
    id: 'compare',
    label: 'Compare',
    items: [
      { kind: 'item', id: 'compare-with', label: "Compare with 'master'" },
      { kind: 'item', id: 'diff-working', label: 'Show Diff with Working Tree' },
    ],
  },
  { kind: 'separator', id: 's2' },
  { kind: 'item', id: 'merge', label: "Merge 'feature/f1-1' into 'master'" },
  { kind: 'item', id: 'rename', label: 'Rename...', accelerator: 'F2' },
  { kind: 'item', id: 'delete', label: 'Delete', disabled: true },
];

function plural(n: number): string {
  return `${n} ${n === 1 ? 'file' : 'files'}`;
}

export function App() {
  const nodes = useMemo<TreeNode[]>(
    () => buildTree(PATHS, { root: { path: '@changes', name: 'Changes' } }),
    [],
  );
  const [tab, setTab] = useState('tree');
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(
    () => new Set(allDirPaths(nodes)),
  );
  const [checked, setChecked] = useState<ReadonlySet<string>>(() => new Set());
  const [selection, setSelection] = useState<ReadonlySet<string>>(() => new Set());
  const [ratio, setRatio] = useState(0.62);
  const [included, setIncluded] = useState<ReadonlySet<number>>(() => new Set([0]));
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null);
  const [picked, setPicked] = useState('');
  const [dialogOpen, setDialogOpen] = useState(false);
  const [dialogResult, setDialogResult] = useState('');
  const [hooks, setHooks] = useState(true);
  const [groupBy, setGroupBy] = useState('tree');

  const applyDelta = (delta: ToggleDelta): void => {
    const next = new Set(checked);
    for (const p of delta.paths) {
      if (delta.next) next.add(p);
      else next.delete(p);
    }
    setChecked(next);
  };

  const toggleExpand = (path: string, open: boolean): void => {
    const next = new Set(expanded);
    if (open) next.add(path);
    else next.delete(path);
    setExpanded(next);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
      <Tabs
        ariaLabel="Kit sections"
        active={tab}
        onChange={setTab}
        tabs={[
          { id: 'tree', label: 'Tree', icon: 'list-tree' },
          { id: 'diff', label: 'Diff', icon: 'diff', badge: '2' },
          { id: 'menu', label: 'Menu' },
          { id: 'dialog', label: 'Dialog' },
        ]}
        actions={<ToolbarButton icon="gear" label="Kit settings" />}
      />

      <TabPanel id="tree" active={tab}>
        <ToolbarStrip ariaLabel="Tree toolbar">
          <ToolbarButton
            icon="expand-all"
            label="Expand all"
            onClick={() => setExpanded(new Set(allDirPaths(nodes)))}
          />
          <ToolbarButton icon="collapse-all" label="Collapse all" onClick={() => setExpanded(new Set())} />
          <ToolbarSeparator />
          <ToolbarDropdown
            label={groupBy === 'tree' ? 'Group by directory' : 'Flat list'}
            ariaLabel="Group by"
            onSelect={setGroupBy}
            items={[
              { kind: 'item', id: 'tree', label: 'Group by directory', checked: groupBy === 'tree' },
              { kind: 'item', id: 'flat', label: 'Flat list', checked: groupBy === 'flat' },
            ]}
          />
          <ToolbarSpacer />
          <ToolbarButton icon="refresh" label="Refresh" />
        </ToolbarStrip>

        <div style={{ height: 320 }}>
          <SplitPane
            direction="horizontal"
            ariaLabel="Tree and readout splitter"
            ratio={ratio}
            onRatioChange={setRatio}
            first={
              <FileTree
                nodes={nodes}
                height={320}
                ariaLabel="Changed files"
                expanded={expanded}
                onToggleExpand={toggleExpand}
                checked={checked}
                onToggleCheck={applyDelta}
                selection={selection}
                onSelectionChange={(paths) => setSelection(new Set(paths))}
                description={(n) =>
                  n.kind === 'dir' ? plural(countFiles(n)) : undefined
                }
                icon={(n) => ({ codicon: n.kind === 'dir' ? 'folder' : 'file' })}
              />
            }
            second={
              <div style={{ padding: 8, fontSize: '0.9em' }}>
                <div data-testid="checked-count">checked: {checked.size}</div>
                <div data-testid="checked-list">{[...checked].sort().join(',')}</div>
                <div data-testid="selection-list">{[...selection].sort().join(',')}</div>
                <div data-testid="ratio">ratio: {ratio.toFixed(2)}</div>
              </div>
            }
          />
        </div>
      </TabPanel>

      <TabPanel id="diff" active={tab}>
        <InlineDiff
          originalText={ORIGINAL}
          modifiedText={MODIFIED}
          changes={CHANGES}
          leftLabel="f3a5bc77 1.txt"
          rightLabel="Current version"
          height={220}
          included={included}
          onToggleInclude={(index, next) => {
            const set = new Set(included);
            if (next) set.add(index);
            else set.delete(index);
            setIncluded(set);
          }}
        />
        <div data-testid="included-list">{[...included].sort().join(',')}</div>
      </TabPanel>

      <TabPanel id="menu" active={tab}>
        <div style={{ padding: 12 }}>
          <button
            type="button"
            className="gt-button"
            data-testid="open-menu"
            onClick={(e) => {
              const box = e.currentTarget.getBoundingClientRect();
              setMenuAt({ x: box.left, y: box.bottom });
            }}
          >
            Branch actions
          </button>
          <div data-testid="menu-picked">{picked}</div>
        </div>
        {menuAt !== null ? (
          <Menu
            items={BRANCH_MENU}
            at={menuAt}
            ariaLabel="Branch actions"
            onSelect={setPicked}
            onClose={() => setMenuAt(null)}
          />
        ) : null}
      </TabPanel>

      <TabPanel id="dialog" active={tab}>
        <div style={{ padding: 12 }}>
          <button
            type="button"
            className="gt-button"
            data-testid="open-dialog"
            onClick={() => setDialogOpen(true)}
          >
            Open dialog
          </button>
          <div data-testid="dialog-result">{dialogResult}</div>
        </div>
        {dialogOpen ? (
          <div style={{ position: 'fixed', inset: 0, background: 'var(--vscode-editor-background)' }}>
            <Dialog
              title="Push Commits to demo-git"
              onHelp={() => setDialogResult('help')}
              onCancel={() => {
                setDialogResult('cancel');
                setDialogOpen(false);
              }}
              onAction={(id) => {
                setDialogResult(id);
                setDialogOpen(false);
              }}
              footerLeft={
                <Checkbox checked={hooks} label="Run Git hooks" onChange={setHooks} />
              }
              buttons={[
                {
                  id: 'push',
                  label: 'Push',
                  variant: 'default',
                  menu: [{ kind: 'item', id: 'force-push', label: 'Force Push...' }],
                },
                { id: 'cancel', label: 'Cancel' },
              ]}
            >
              <input className="gt-input" data-testid="dialog-input" placeholder="Remote branch" />
              <Checkbox
                checked={false}
                label="Push tags"
                caption="Tags reachable from the pushed commits"
                onChange={() => undefined}
              />
            </Dialog>
          </div>
        ) : null}
      </TabPanel>
    </div>
  );
}
