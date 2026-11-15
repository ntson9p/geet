/**
 * Filter row (P12-T5) — the §2A shape: `Branch or tag` combo · `Text or hash`
 * with `.*`/`Cc` toggles · real multi-select `Branch ▾ User ▾ Date ▾ Paths ▾`
 * dropdowns with search · Graph Options ▾ · right-side toolbar (refresh ·
 * Presentation Settings ▾ · Go to Hash/Branch/Tag · Show Details · Highlight
 * my commits · Saved filters ▾). Every filter composes into the one LogFilter;
 * the host argv build is unchanged.
 */
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react';
import { pathOfPathspec } from '../../../src/core/git/pathspec';
import type {
  LogBranchesDto,
  LogFilterDto,
  LogPresentationDto,
  LogRootDto,
} from '../../../src/shared/protocol';
import { Menu, type MenuItem } from '../lib/Menu';
import { ToolbarButton } from '../lib/Toolbar';
import { useDismiss } from '../lib/useDismiss';
import {
  branchChip,
  dateChip,
  pathsChip,
  resetFilters,
  userChip,
  type ChipText,
} from './filterChips';
import { applyGraphOption, graphOptionsChanged, graphOptionsItems } from './graphOptions';
import { presentationItems, presentationToggle } from './presentationMenu';

// ---------------------------------------------------------------------------
// A chip that opens an in-webview panel (multi-select with search).
// ---------------------------------------------------------------------------

interface DropdownProps {
  label: string;
  /** What the chip says it filters (`filterChips.ts`), cut short when compact. */
  text: ChipText;
  /** `gittree.log.filterChips` is `compact`: the smaller chip (D39). */
  compact: boolean;
  onClear: () => void;
  testid: string;
  /**
   * Whether the `×` is offered. Defaults to "there is a value" — `Paths ▾` is
   * the exception: it shows the repository on show even when nothing is
   * filtered, and clearing cannot un-choose a repository.
   */
  canClear?: boolean;
  children: (close: () => void) => ReactNode;
}

function Dropdown({ label, text, compact, onClear, testid, canClear, children }: DropdownProps) {
  const [open, setOpen] = useState(false);
  const hostRef = useRef<HTMLSpanElement | null>(null);
  const { value, full } = text;

  // A click elsewhere in this webview or anywhere in VS Code, or the webview
  // losing focus, closes the panel as VS Code's own popups close
  // (`useDismiss`). The chip is inside `hostRef`: its own click toggles.
  useDismiss([hostRef], () => setOpen(false), open);

  return (
    <span className="gt-filter-anchor" ref={hostRef}>
      <span
        className={`gt-filter-chipset${compact ? ' gt-compact' : ''}${value !== undefined ? ' gt-active' : ''}`}
      >
        <button
          type="button"
          className="gt-chip-main"
          aria-label={label}
          aria-expanded={open}
          data-testid={testid}
          // The whole value: a compact chip cuts its own short.
          title={full !== undefined ? `${label}: ${full}` : undefined}
          onClick={() => setOpen((v) => !v)}
        >
          {label}
          {value !== undefined ? `: ${value}` : ''} ▾
        </button>
        {(canClear ?? value !== undefined) ? (
          <button
            type="button"
            className="gt-chip-clear"
            onClick={onClear}
            aria-label={`Clear ${label}`}
            title={`Clear ${label}`}
          >
            {compact ? <span className="codicon codicon-close" aria-hidden="true" /> : '×'}
          </button>
        ) : null}
      </span>
      {open ? (
        <div
          className="gt-filter-panel"
          role="dialog"
          aria-label={`${label} filter`}
          data-testid={`${testid}-panel`}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault();
              e.stopPropagation();
              setOpen(false);
            }
          }}
        >
          {children(() => setOpen(false))}
        </div>
      ) : null}
    </span>
  );
}

function CheckRow({
  label,
  checked,
  onToggle,
  star,
  note,
}: {
  label: string;
  checked: boolean;
  onToggle: () => void;
  star?: boolean;
  /** Said after the label, dimmed: `not in this repository`. */
  note?: string;
}) {
  return (
    <label className="gt-filter-checkrow">
      <input type="checkbox" checked={checked} onChange={onToggle} />
      {star === true ? <span className="codicon codicon-star-full gt-filter-star" aria-hidden="true" /> : null}
      <span className="gt-filter-checkrow-label">{label}</span>
      {note !== undefined ? <span className="gt-filter-note">{note}</span> : null}
    </label>
  );
}

/**
 * `HEAD (Current)` and `All branches`: each is the whole Branch filter on its
 * own, never one of several ticked, so they are radio buttons, kept above the
 * list of branches and apart from it. Picking a branch below unticks both.
 */
function PresetRow({
  group,
  label,
  checked,
  onPick,
}: {
  group: string;
  label: string;
  checked: boolean;
  onPick: () => void;
}) {
  return (
    <label className="gt-filter-checkrow gt-filter-preset">
      <input type="radio" name={group} checked={checked} onChange={onPick} />
      <span className="gt-filter-checkrow-label">{label}</span>
    </label>
  );
}

/**
 * IntelliJ's Graph Options icon — an arrow down beside three rows — which no
 * codicon resembles closely enough to stand in for it.
 */
function GraphOptionsGlyph() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round">
      <path d="M4 2.5v10.5M1.75 10.75 4 13l2.25-2.25" strokeLinejoin="round" />
      <path d="M8.5 4h6M8.5 8h6M8.5 12h6" />
    </svg>
  );
}

// ---------------------------------------------------------------------------

export interface FilterBarProps {
  filter: LogFilterDto;
  onChange: (next: LogFilterDto) => void;
  branches: LogBranchesDto | null;
  fetchAuthors: () => Promise<string[]>;
  presets: ReadonlyArray<{ name: string; filter: LogFilterDto }>;
  onSavePreset: () => void;
  onDeletePreset: (name: string) => void;
  onRefresh: () => void;
  /** A Refresh is re-reading: its icon turns until the new rows are on screen. */
  refreshing?: boolean;
  onGoToRef: (ref?: string) => void;
  /** `Paths ▾ · Select…` — the host's file chooser. */
  onBrowsePaths: () => void;
  /** `Paths ▾ · Select in Tree…` — pick out of the repository's own tree. */
  onPickPathsInTree: () => void;
  /** `Paths ▾ · Roots` — every repository the workspace has. */
  roots: readonly LogRootDto[];
  /** Which of `roots` the log is showing. */
  currentRoot: string;
  onSetRoot: (root: string) => void;
  /** Graph-palette swatch for a root, so a repository keeps one colour. */
  rootColor: (colorIdx: number) => string;
  showDetails: boolean;
  onToggleDetails: () => void;
  highlightMine: boolean;
  onToggleHighlightMine: () => void;
  canHighlightMine: boolean;
  /** `Presentation Settings ▾`, the eye button: how the rows draw their refs and columns. */
  presentation: LogPresentationDto;
  onPresentationChange: (patch: Partial<LogPresentationDto>) => void;
  /** P10-T2: lets the host's focus-filter command reach the search box. */
  searchInputRef?: RefObject<HTMLInputElement>;
  /**
   * What the Branch selection names that this repository lacks — picked in
   * another one, before `Paths ▾ · Roots` moved the tab here. Those stay
   * ticked in `Branch ▾`, marked, so they can be unticked.
   */
  missingRefs?: readonly string[];
}

const HASH_RE = /^[0-9a-f]{7,40}$/i;

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}

/** How long typing has to pause before the search text is applied. */
const TEXT_FILTER_DELAY_MS = 300;

export function FilterBar({
  filter,
  onChange,
  branches,
  fetchAuthors,
  presets,
  onSavePreset,
  onDeletePreset,
  onRefresh,
  refreshing,
  onGoToRef,
  onBrowsePaths,
  onPickPathsInTree,
  roots,
  currentRoot,
  onSetRoot,
  rootColor,
  showDetails,
  onToggleDetails,
  highlightMine,
  onToggleHighlightMine,
  canHighlightMine,
  presentation,
  onPresentationChange,
  searchInputRef,
  missingRefs,
}: FilterBarProps) {
  const text = filter.text ?? { q: '', regex: false, matchCase: false };
  const compact = presentation.filterChips === 'compact';
  const chipMode = presentation.filterChips;
  // Radio buttons are grouped by name, and every Log tab's bar is in one page.
  const presetGroup = `gt-refs-preset-${useId()}`;
  /**
   * What is typed in the search box, ahead of the filter it becomes. Every
   * applied filter re-reads the log (`git log --grep`), so applying one per
   * keystroke made typing lag behind the keyboard; the text is applied once
   * typing pauses — or at once on Enter.
   */
  const [textDraft, setTextDraft] = useState(text.q);
  const textTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const filterRef = useRef(filter);
  filterRef.current = filter;
  // A filter changed from elsewhere (a saved filter, a reset) shows in the
  // box — unless the user is mid-typing, whose text wins.
  useEffect(() => {
    if (textTimer.current === undefined) setTextDraft(text.q);
  }, [text.q]);
  useEffect(() => () => clearTimeout(textTimer.current), []);
  const applyText = useCallback(
    (q: string) => {
      clearTimeout(textTimer.current);
      textTimer.current = undefined;
      const current = filterRef.current;
      const was = current.text ?? { q: '', regex: false, matchCase: false };
      if (q === was.q) return;
      const next = { ...current };
      if (q.length === 0) delete next.text;
      else next.text = { ...was, q };
      onChange(next);
    },
    [onChange],
  );
  const [refSearch, setRefSearch] = useState('');
  const [userSearch, setUserSearch] = useState('');
  const [authors, setAuthors] = useState<string[] | undefined>(undefined);
  const [pathDraft, setPathDraft] = useState('');
  const [comboDraft, setComboDraft] = useState('');
  const [presetsAt, setPresetsAt] = useState<{ x: number; y: number } | null>(null);
  const [presentationAt, setPresentationAt] = useState<{ x: number; y: number } | null>(null);
  const [graphOptionsAt, setGraphOptionsAt] = useState<{ x: number; y: number } | null>(null);

  const selectedRefs = Array.isArray(filter.refs) ? filter.refs : [];

  // The two presets, derived exactly as `buildLogArgs` reads them: a `range`
  // outranks `refs` entirely, so neither preset is active while one is set —
  // the same precedence `refsLabel` uses to show the range in the chip. HEAD is
  // also the `refs === undefined` case, since both mean "no ref argv".
  const headOnly =
    filter.range === undefined && (filter.refs === undefined || filter.refs === 'HEAD');
  const allBranches = filter.range === undefined && filter.refs === 'ALL';

  const toggleRef = useCallback(
    (name: string) => {
      const next = { ...filter };
      delete next.range;
      const set = new Set(selectedRefs);
      if (set.has(name)) set.delete(name);
      else set.add(name);
      next.refs = set.size === 0 ? 'HEAD' : [...set];
      onChange(next);
    },
    [filter, onChange, selectedRefs],
  );

  const allRefNames = branches
    ? [
        ...branches.locals.map((b) => b.name),
        ...branches.remotes.flatMap((r) => r.branches),
        ...branches.tags,
      ]
    : [];

  // Favorites first inside the Branch ▾ list (§2A).
  const sortedLocals = branches
    ? [...branches.locals].sort((a, b) =>
        a.favorite === b.favorite ? a.name.localeCompare(b.name) : a.favorite ? -1 : 1,
      )
    : [];

  const applyCombo = (value: string): void => {
    const v = value.trim();
    const next = { ...filter };
    delete next.range;
    if (v.length === 0 || v === 'HEAD') next.refs = 'HEAD';
    else if (v === 'ALL') next.refs = 'ALL';
    else next.refs = [v];
    onChange(next);
  };

  const presetMenuItems: MenuItem[] = [
    ...presets.map(
      (p): MenuItem => ({ kind: 'item', id: `apply:${p.name}`, label: p.name, icon: 'filter' }),
    ),
    ...(presets.length > 0 ? [{ kind: 'separator', id: 'sep1' } as MenuItem] : []),
    { kind: 'item', id: 'save', label: 'Save current filter…', icon: 'save' },
    ...(presets.length > 0
      ? [
          {
            kind: 'submenu',
            id: 'deleteMenu',
            label: 'Delete preset',
            items: presets.map(
              (p): MenuItem => ({ kind: 'item', id: `delete:${p.name}`, label: p.name }),
            ),
          } as MenuItem,
        ]
      : []),
  ];

  return (
    <div className="gt-log-filterbar" role="toolbar" aria-label="Log filters">
      <input
        type="text"
        className="gt-input gt-log-refcombo"
        placeholder="Branch or tag"
        aria-label="Branch or tag"
        list="gt-ref-combo-list"
        value={comboDraft}
        onChange={(e) => setComboDraft(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            applyCombo(e.currentTarget.value);
            setComboDraft('');
          }
        }}
      />
      <datalist id="gt-ref-combo-list">
        <option value="HEAD" />
        <option value="ALL" />
        {allRefNames.map((n) => (
          <option key={n} value={n} />
        ))}
      </datalist>

      <input
        ref={searchInputRef}
        type="text"
        className="gt-input gt-log-search"
        placeholder="Text or hash"
        aria-label="Search commit messages"
        value={textDraft}
        onChange={(e) => {
          const q = e.currentTarget.value;
          setTextDraft(q);
          clearTimeout(textTimer.current);
          textTimer.current = setTimeout(() => applyText(q), TEXT_FILTER_DELAY_MS);
        }}
        onKeyDown={(e) => {
          if (e.key !== 'Enter') return;
          const q = e.currentTarget.value;
          // A hash-shaped entry navigates instead of grepping (IntelliJ).
          if (HASH_RE.test(q.trim())) onGoToRef(q.trim());
          // Enter does not wait for the pause.
          applyText(q);
        }}
      />
      <ToolbarButton
        label="Regex"
        toggled={text.regex}
        icon="regex"
        onClick={() => onChange({ ...filter, text: { ...text, regex: !text.regex } })}
      />
      <ToolbarButton
        label="Match case"
        toggled={text.matchCase}
        icon="case-sensitive"
        onClick={() => onChange({ ...filter, text: { ...text, matchCase: !text.matchCase } })}
      />

      <Dropdown
        label="Branch"
        testid="filter-branch"
        text={branchChip(filter, chipMode)}
        compact={compact}
        onClear={() => {
          const next = { ...filter, refs: 'HEAD' as const };
          delete next.range;
          onChange(next);
        }}
      >
        {() => {
          // Ticked names this repository's lists do not have: a branch picked
          // in another repository, or a revision typed into `Branch or tag`.
          // Listed first, so each can be unticked.
          const listed = new Set(allRefNames);
          const missing = new Set(missingRefs ?? []);
          const unlisted = selectedRefs.filter(
            (n) => !listed.has(n) && n.toLowerCase().includes(refSearch.toLowerCase()),
          );
          return (
            <>
              <input
                className="gt-input gt-filter-search"
                placeholder="Search refs"
                aria-label="Search refs"
                value={refSearch}
                onChange={(e) => setRefSearch(e.currentTarget.value)}
              />
              <div className="gt-filter-presets" role="radiogroup" aria-label="Show">
                <PresetRow
                  group={presetGroup}
                  label="HEAD (Current)"
                  checked={headOnly}
                  onPick={() => {
                    const next = { ...filter, refs: 'HEAD' as const };
                    delete next.range;
                    onChange(next);
                  }}
                />
                <PresetRow
                  group={presetGroup}
                  label="All branches"
                  checked={allBranches}
                  onPick={() => {
                    const next = { ...filter, refs: 'ALL' as const };
                    delete next.range;
                    onChange(next);
                  }}
                />
              </div>
              <div className="gt-filter-list" role="group" aria-label="Branches and tags">
                {unlisted.map((n) => (
                  <CheckRow
                    key={`unlisted:${n}`}
                    label={n}
                    checked
                    onToggle={() => toggleRef(n)}
                    {...(missing.has(n) ? { note: 'not in this repository' } : {})}
                  />
                ))}
                {sortedLocals
                  .filter((b) => b.name.toLowerCase().includes(refSearch.toLowerCase()))
                  .map((b) => (
                    <CheckRow
                      key={b.name}
                      label={b.name}
                      star={b.favorite}
                      checked={selectedRefs.includes(b.name)}
                      onToggle={() => toggleRef(b.name)}
                    />
                  ))}
                {(branches?.remotes ?? [])
                  .flatMap((r) => r.branches)
                  .filter((n) => n.toLowerCase().includes(refSearch.toLowerCase()))
                  .map((n) => (
                    <CheckRow
                      key={n}
                      label={n}
                      checked={selectedRefs.includes(n)}
                      onToggle={() => toggleRef(n)}
                    />
                  ))}
                {(branches?.tags ?? [])
                  .filter((n) => n.toLowerCase().includes(refSearch.toLowerCase()))
                  .map((n) => (
                    <CheckRow
                      key={`tag:${n}`}
                      label={n}
                      checked={selectedRefs.includes(n)}
                      onToggle={() => toggleRef(n)}
                    />
                  ))}
              </div>
            </>
          );
        }}
      </Dropdown>

      <Dropdown
        label="User"
        testid="filter-user"
        text={userChip(filter, chipMode, branches?.myAuthor)}
        compact={compact}
        onClear={() => {
          const next = { ...filter };
          delete next.authors;
          onChange(next);
        }}
      >
        {() => {
          if (authors === undefined) {
            void fetchAuthors().then(setAuthors, () => setAuthors([]));
          }
          const current = new Set(filter.authors ?? []);
          const toggleAuthor = (a: string): void => {
            const set = new Set(current);
            if (set.has(a)) set.delete(a);
            else set.add(a);
            const next = { ...filter };
            if (set.size === 0) delete next.authors;
            else next.authors = [...set];
            onChange(next);
          };
          return (
            <>
              <input
                className="gt-input gt-filter-search"
                placeholder="Search users"
                aria-label="Search users"
                value={userSearch}
                onChange={(e) => setUserSearch(e.currentTarget.value)}
              />
              <div className="gt-filter-list">
                {branches?.myAuthor !== undefined ? (
                  <CheckRow
                    label={`Me (${branches.myAuthor})`}
                    checked={current.has(branches.myAuthor)}
                    onToggle={() => toggleAuthor(branches.myAuthor!)}
                  />
                ) : null}
                {(authors ?? [])
                  .filter((a) => a.toLowerCase().includes(userSearch.toLowerCase()))
                  .slice(0, 200)
                  .map((a) => (
                    <CheckRow key={a} label={a} checked={current.has(a)} onToggle={() => toggleAuthor(a)} />
                  ))}
                {authors === undefined ? <div className="gt-muted">Loading…</div> : null}
              </div>
            </>
          );
        }}
      </Dropdown>

      <Dropdown
        label="Date"
        testid="filter-date"
        text={dateChip(filter, chipMode, presentation.dateFormat)}
        compact={compact}
        onClear={() => {
          const next = { ...filter };
          delete next.dateRange;
          onChange(next);
        }}
      >
        {(close) => (
          <div className="gt-filter-list">
            {(
              [
                ['Today', 0],
                ['Yesterday', 1],
                ['Last 7 days', 7],
                ['Last 30 days', 30],
              ] as const
            ).map(([label, days]) => (
              <button
                key={label}
                type="button"
                className="gt-filter-row-button"
                onClick={() => {
                  onChange({ ...filter, dateRange: { from: isoDaysAgo(days) } });
                  close();
                }}
              >
                {label}
              </button>
            ))}
            <div className="gt-filter-daterow">
              <label>
                from{' '}
                <input
                  type="date"
                  className="gt-input"
                  aria-label="From date"
                  value={filter.dateRange?.from ?? ''}
                  onChange={(e) => {
                    const from = e.currentTarget.value;
                    const range = { ...(filter.dateRange ?? {}) };
                    if (from.length === 0) delete range.from;
                    else range.from = from;
                    const next = { ...filter };
                    if (range.from === undefined && range.to === undefined) delete next.dateRange;
                    else next.dateRange = range;
                    onChange(next);
                  }}
                />
              </label>
              <label>
                until{' '}
                <input
                  type="date"
                  className="gt-input"
                  aria-label="Until date"
                  value={filter.dateRange?.to ?? ''}
                  onChange={(e) => {
                    const to = e.currentTarget.value;
                    const range = { ...(filter.dateRange ?? {}) };
                    if (to.length === 0) delete range.to;
                    else range.to = to;
                    const next = { ...filter };
                    if (range.from === undefined && range.to === undefined) delete next.dateRange;
                    else next.dateRange = range;
                    onChange(next);
                  }}
                />
              </label>
            </div>
          </div>
        )}
      </Dropdown>

      <Dropdown
        label="Paths"
        testid="filter-paths"
        text={pathsChip(filter, chipMode, roots, currentRoot)}
        compact={compact}
        canClear={(filter.paths ?? []).length > 0}
        onClear={() => {
          const next = { ...filter };
          delete next.paths;
          delete next.follow;
          onChange(next);
        }}
      >
        {(close) => (
          <div className="gt-filter-list">
            {/* The reference's two chooser rows, in its order. */}
            <button
              type="button"
              className="gt-filter-row-button"
              onClick={() => {
                onBrowsePaths();
                close();
              }}
            >
              Select…
            </button>
            <button
              type="button"
              className="gt-filter-row-button"
              onClick={() => {
                onPickPathsInTree();
                close();
              }}
            >
              Select in Tree…
            </button>

            {/* Roots. The reference merges every root into one graph and lets
                you tick a subset; this log renders one repository at a time,
                so the rows are radios and picking one moves the log there. */}
            {roots.length > 0 ? (
              <>
                <div className="gt-filter-section">Roots</div>
                {roots.map((r) => (
                  <label key={r.root} className="gt-filter-checkrow" title={r.root}>
                    <input
                      type="radio"
                      name="gt-log-root"
                      checked={r.root === currentRoot}
                      data-testid={`filter-root-${r.label}`}
                      onChange={() => {
                        if (r.root === currentRoot) return;
                        onSetRoot(r.root);
                        close();
                      }}
                    />
                    <span
                      className="gt-filter-swatch"
                      style={{ background: rootColor(r.colorIdx) }}
                      aria-hidden="true"
                    />
                    <span className="gt-filter-checkrow-label">{r.label}</span>
                  </label>
                ))}
              </>
            ) : null}

            {(filter.paths ?? []).length > 0 ? <div className="gt-filter-section">Paths</div> : null}
            {(filter.paths ?? []).map((p) => (
              <div key={p} className="gt-filter-pathrow">
                {/* A picked path's `:(literal)` tells git it is a name; it is not shown. */}
                <span className="gt-filter-checkrow-label" title={pathOfPathspec(p)}>
                  {pathOfPathspec(p)}
                </span>
                <button
                  type="button"
                  className="gt-chip-clear"
                  aria-label={`Remove ${pathOfPathspec(p)}`}
                  onClick={() => {
                    const paths = (filter.paths ?? []).filter((x) => x !== p);
                    const next = { ...filter };
                    if (paths.length === 0) {
                      delete next.paths;
                      delete next.follow;
                    } else {
                      next.paths = paths;
                      delete next.follow;
                    }
                    onChange(next);
                  }}
                >
                  ×
                </button>
              </div>
            ))}
            <div className="gt-filter-pathadd">
              <input
                className="gt-input"
                placeholder="path or glob"
                aria-label="Add path"
                value={pathDraft}
                onChange={(e) => setPathDraft(e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && pathDraft.trim().length > 0) {
                    const next = { ...filter };
                    // Deduped like both choosers — a repeated path is one
                    // pathspec to git and two rows here.
                    next.paths = [...new Set([...(filter.paths ?? []), pathDraft.trim()])];
                    delete next.follow;
                    onChange(next);
                    setPathDraft('');
                  }
                }}
              />
            </div>
          </div>
        )}
      </Dropdown>

      <ToolbarButton
        label="Graph Options"
        glyph={<GraphOptionsGlyph />}
        badge={graphOptionsChanged(filter)}
        onClick={(e) => {
          const box = e.currentTarget.getBoundingClientRect();
          setGraphOptionsAt({ x: box.left, y: box.bottom + 2 });
        }}
      />
      {graphOptionsAt !== null ? (
        <Menu
          items={graphOptionsItems(filter)}
          at={graphOptionsAt}
          ariaLabel="Graph Options"
          onClose={() => setGraphOptionsAt(null)}
          onSelect={(id) => {
            const next = applyGraphOption(filter, id);
            if (next !== undefined) onChange(next);
          }}
        />
      ) : null}

      <span className="gt-filter-spacer" />

      <ToolbarButton label="Refresh log" icon="refresh" busy={refreshing} onClick={onRefresh} />
      <ToolbarButton
        label="Presentation Settings"
        icon="eye"
        onClick={(e) => {
          const box = e.currentTarget.getBoundingClientRect();
          setPresentationAt({ x: box.left, y: box.bottom + 2 });
        }}
      />
      {presentationAt !== null ? (
        <Menu
          items={presentationItems(presentation)}
          at={presentationAt}
          ariaLabel="Presentation Settings"
          onClose={() => setPresentationAt(null)}
          onSelect={(id) => {
            const patch = presentationToggle(presentation, id);
            if (patch !== undefined) onPresentationChange(patch);
          }}
        />
      ) : null}
      <ToolbarButton label="Go to Hash/Branch/Tag" icon="arrow-right" onClick={() => onGoToRef()} />
      <ToolbarButton
        label="Show Details"
        icon="layout-sidebar-right"
        toggled={showDetails}
        onClick={onToggleDetails}
      />
      <ToolbarButton
        label="Highlight my commits"
        icon="account"
        toggled={highlightMine}
        disabled={!canHighlightMine}
        onClick={onToggleHighlightMine}
      />
      <ToolbarButton
        label="Saved filters"
        icon="bookmark"
        onClick={(e) => {
          const box = e.currentTarget.getBoundingClientRect();
          setPresetsAt({ x: box.left, y: box.bottom + 2 });
        }}
      />
      {presetsAt !== null ? (
        <Menu
          items={presetMenuItems}
          at={presetsAt}
          ariaLabel="Saved filters"
          onClose={() => setPresetsAt(null)}
          onSelect={(id) => {
            if (id === 'save') onSavePreset();
            else if (id.startsWith('apply:')) {
              const preset = presets.find((p) => p.name === id.slice(6));
              if (preset) onChange({ ...preset.filter });
            } else if (id.startsWith('delete:')) {
              onDeletePreset(id.slice(7));
            }
          }}
        />
      ) : null}

      <ToolbarButton
        label="Reset all filters"
        icon="clear-all"
        // The sort and First Parent are how the graph is drawn, not filters,
        // so they stay; No Merges is a filter in IntelliJ and goes.
        onClick={() => onChange(resetFilters(filter))}
      />
    </div>
  );
}
