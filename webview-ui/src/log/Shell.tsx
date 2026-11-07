/**
 * Git tool-window shell (P12-T1): the §2A four-pane layout —
 * `[Branches | Commits] | [Changed Files / Commit Details]` — via nested
 * SplitPanes, with a header per pane so pane actions stop competing for the
 * single view/title strip.
 *
 * Pane headers are the keyboard rail: each is focusable, announces the pane
 * name, `Tab`/`Shift+Tab` cycle between panes, Enter/ArrowDown drops focus
 * into the pane body, and the collapse chevron folds the pane to a slim bar
 * (IntelliJ's behaviour) without unmounting anything — collapsed panes keep
 * their state because they merely hide.
 */
import { useCallback, useRef, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { SplitPane } from '../lib/SplitPane';

export type PaneId = 'branches' | 'commits' | 'files' | 'details';

export interface ShellLayout {
  /** Fraction for [Branches|Commits] vs the right column. */
  outer: number;
  /** Fraction for Branches inside the left pair. */
  left: number;
  /** Fraction for Changed Files inside the right column. */
  right: number;
  collapsed: Partial<Record<PaneId, boolean>>;
}

export const DEFAULT_LAYOUT: ShellLayout = {
  outer: 0.68,
  // POST-QA: at 0.22 the Branches pane was ~150px, the icon rail and two
  // scrollbars left its names three letters (`bu…`, `HEA…`).
  left: 0.28,
  right: 0.55,
  collapsed: {},
};

const PANE_ORDER: PaneId[] = ['branches', 'commits', 'files', 'details'];
const PANE_TITLES: Record<PaneId, string> = {
  branches: 'Branches',
  commits: 'Commits',
  files: 'Changed Files',
  details: 'Commit Details',
};

export interface ShellProps {
  layout: ShellLayout;
  onLayoutChange: (next: ShellLayout) => void;
  branches: ReactNode;
  commits: ReactNode;
  files: ReactNode;
  details: ReactNode;
  /** Extra header-row content (a pane toolbar) per pane. */
  toolbars?: Partial<Record<PaneId, ReactNode>>;
}

export function Shell({ layout, onLayoutChange, branches, commits, files, details, toolbars }: ShellProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);

  const setCollapsed = useCallback(
    (id: PaneId, next: boolean) => {
      onLayoutChange({ ...layout, collapsed: { ...layout.collapsed, [id]: next } });
    },
    [layout, onLayoutChange],
  );

  /** Tab / Shift+Tab cycle the four pane headers; Enter enters the body. */
  const onHeaderKeyDown = useCallback((id: PaneId, e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Tab') {
      e.preventDefault();
      const at = PANE_ORDER.indexOf(id);
      const next = PANE_ORDER[(at + (e.shiftKey ? -1 : 1) + PANE_ORDER.length) % PANE_ORDER.length];
      hostRef.current
        ?.querySelector<HTMLElement>(`[data-pane-header="${next}"]`)
        ?.focus();
      return;
    }
    if (e.key === 'Enter' || e.key === 'ArrowDown') {
      e.preventDefault();
      const body = hostRef.current?.querySelector<HTMLElement>(`[data-pane-body="${id}"]`);
      const target = body?.querySelector<HTMLElement>(
        'button:not(:disabled), [tabindex]:not([tabindex="-1"]), input:not(:disabled), select:not(:disabled)',
      );
      (target ?? body)?.focus();
    }
  }, []);

  const pane = useCallback(
    (id: PaneId, body: ReactNode, collapseDir: 'bar-vertical' | 'bar-horizontal'): ReactNode => {
      // The Commits pane is the window's centre and never collapses — also,
      // folding it would unmount the sized graph container (IntelliJ's centre
      // pane has no collapse either).
      const collapsible = id !== 'commits';
      const collapsed = collapsible && layout.collapsed[id] === true;
      if (collapsed) {
        return (
          <div
            className={`gt-pane-collapsed gt-${collapseDir}`}
            data-testid={`pane-${id}-collapsed`}
          >
            <button
              type="button"
              className="gt-pane-expand"
              aria-label={`Expand ${PANE_TITLES[id]}`}
              onClick={() => setCollapsed(id, false)}
            >
              <span className="codicon codicon-chevron-right" aria-hidden="true" />
              <span className="gt-pane-collapsed-title">{PANE_TITLES[id]}</span>
            </button>
          </div>
        );
      }
      return (
        <section className="gt-pane" data-testid={`pane-${id}`} aria-label={PANE_TITLES[id]}>
          <div
            className="gt-pane-header"
            data-pane-header={id}
            role="button"
            tabIndex={0}
            aria-label={`${PANE_TITLES[id]} pane`}
            onKeyDown={(e) => onHeaderKeyDown(id, e)}
          >
            {collapsible ? (
              <button
                type="button"
                className="gt-pane-chevron"
                aria-label={`Collapse ${PANE_TITLES[id]}`}
                tabIndex={-1}
                onClick={() => setCollapsed(id, true)}
              >
                <span className="codicon codicon-chevron-down" aria-hidden="true" />
              </button>
            ) : null}
            <span className="gt-pane-title">{PANE_TITLES[id]}</span>
            <div className="gt-pane-toolbar">{toolbars?.[id]}</div>
          </div>
          <div className="gt-pane-body" data-pane-body={id}>
            {body}
          </div>
        </section>
      );
    },
    [layout.collapsed, onHeaderKeyDown, setCollapsed, toolbars],
  );

  const branchesCollapsed = layout.collapsed.branches === true;
  const filesCollapsed = layout.collapsed.files === true;
  const detailsCollapsed = layout.collapsed.details === true;

  // A collapsed pane leaves the split entirely — the sibling takes the room
  // and the slim bar sits beside it. Ratios are preserved for when it returns.
  const leftPair = branchesCollapsed ? (
    <div className="gt-shell-row">
      {pane('branches', branches, 'bar-vertical')}
      {pane('commits', commits, 'bar-vertical')}
    </div>
  ) : (
    <SplitPane
      direction="horizontal"
      ariaLabel="Branches and commits"
      ratio={layout.left}
      defaultRatio={DEFAULT_LAYOUT.left}
      onRatioChange={(left) => onLayoutChange({ ...layout, left })}
      minFirst={120}
      minSecond={200}
      first={pane('branches', branches, 'bar-vertical')}
      second={pane('commits', commits, 'bar-vertical')}
    />
  );

  const rightColumn =
    filesCollapsed || detailsCollapsed ? (
      <div className="gt-shell-column">
        {pane('files', files, 'bar-horizontal')}
        {pane('details', details, 'bar-horizontal')}
      </div>
    ) : (
      <SplitPane
        direction="vertical"
        ariaLabel="Changed files and commit details"
        ratio={layout.right}
        defaultRatio={DEFAULT_LAYOUT.right}
        onRatioChange={(right) => onLayoutChange({ ...layout, right })}
        minFirst={80}
        minSecond={80}
        first={pane('files', files, 'bar-horizontal')}
        second={pane('details', details, 'bar-horizontal')}
      />
    );

  return (
    <div className="gt-shell" ref={hostRef} data-testid="log-shell">
      <SplitPane
        direction="horizontal"
        ariaLabel="Log panes"
        ratio={layout.outer}
        defaultRatio={DEFAULT_LAYOUT.outer}
        onRatioChange={(outer) => onLayoutChange({ ...layout, outer })}
        minFirst={260}
        minSecond={200}
        first={leftPair}
        second={rightColumn}
      />
    </div>
  );
}
