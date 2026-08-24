/**
 * Filter row (P12-T5) — the §2A shape: `Branch or tag` combo · `Text or hash`
 * with `.*`/`Cc` toggles · real multi-select `Branch ▾ User ▾ Date ▾ Paths ▾`
 * dropdowns with search · right-side toolbar (refresh · Go to Hash/Branch/Tag
 * · Show Details · Highlight my commits · Saved filters ▾). Every filter
 * composes into the one LogFilter; the host argv build is unchanged.
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react';
import type { LogBranchesDto, LogFilterDto } from '../../../src/shared/protocol';
import { Menu, type MenuItem } from '../lib/Menu';
import { ToolbarButton } from '../lib/Toolbar';

// ---------------------------------------------------------------------------
// A chip that opens an in-webview panel (multi-select with search).
// ---------------------------------------------------------------------------

interface DropdownProps {
  label: string;
  value: string | undefined;
  onClear: () => void;
  testid: string;
  children: (close: () => void) => ReactNode;
}

function Dropdown({ label, value, onClear, testid, children }: DropdownProps) {
  const [open, setOpen] = useState(false);
  const hostRef = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e: MouseEvent): void => {
      if (!hostRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown, true);
    return () => document.removeEventListener('mousedown', onDown, true);
  }, [open]);

  return (
    <span className="gt-filter-anchor" ref={hostRef}>
      <span className={`gt-filter-chipset${value !== undefined ? ' gt-active' : ''}`}>
        <button
          type="button"
          className="gt-chip-main"
          aria-label={label}
          aria-expanded={open}
          data-testid={testid}
          onClick={() => setOpen((v) => !v)}
        >
          {label}
          {value !== undefined ? `: ${value}` : ''} ▾
        </button>
        {value !== undefined ? (
          <button type="button" className="gt-chip-clear" onClick={onClear} aria-label={`Clear ${label}`}>
            ×
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
}: {
  label: string;
  checked: boolean;
  onToggle: () => void;
  star?: boolean;
}) {
  return (
    <label className="gt-filter-checkrow">
      <input type="checkbox" checked={checked} onChange={onToggle} />
      {star === true ? <span className="codicon codicon-star-full gt-filter-star" aria-hidden="true" /> : null}
      <span className="gt-filter-checkrow-label">{label}</span>
    </label>
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
  onGoToRef: (ref?: string) => void;
  onBrowsePaths: () => void;
  showDetails: boolean;
  onToggleDetails: () => void;
  highlightMine: boolean;
  onToggleHighlightMine: () => void;
  canHighlightMine: boolean;
  /** P10-T2: lets the host's focus-filter command reach the search box. */
  searchInputRef?: RefObject<HTMLInputElement>;
}

function refsLabel(f: LogFilterDto): string | undefined {
  if (f.range) return `${f.range.a}...${f.range.b}`;
  if (f.refs === 'ALL') return 'All';
  if (Array.isArray(f.refs)) return f.refs.length > 2 ? `${f.refs.length} refs` : f.refs.join(', ');
  return undefined; // HEAD default renders as no active value
}

function datesLabel(f: LogFilterDto): string | undefined {
  if (!f.dateRange || (f.dateRange.from === undefined && f.dateRange.to === undefined)) return undefined;
  return `${f.dateRange.from ?? '…'} → ${f.dateRange.to ?? '…'}`;
}

const HASH_RE = /^[0-9a-f]{7,40}$/i;

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}

export function FilterBar({
  filter,
  onChange,
  branches,
  fetchAuthors,
  presets,
  onSavePreset,
  onDeletePreset,
  onRefresh,
  onGoToRef,
  onBrowsePaths,
  showDetails,
  onToggleDetails,
  highlightMine,
  onToggleHighlightMine,
  canHighlightMine,
  searchInputRef,
}: FilterBarProps) {
  const text = filter.text ?? { q: '', regex: false, matchCase: false };
  const [refSearch, setRefSearch] = useState('');
  const [userSearch, setUserSearch] = useState('');
  const [authors, setAuthors] = useState<string[] | undefined>(undefined);
  const [pathDraft, setPathDraft] = useState('');
  const [comboDraft, setComboDraft] = useState('');
  const [presetsAt, setPresetsAt] = useState<{ x: number; y: number } | null>(null);

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
        value={text.q}
        onChange={(e) => {
          const q = e.currentTarget.value;
          const next = { ...filter };
          if (q.length === 0) delete next.text;
          else next.text = { ...text, q };
          onChange(next);
        }}
        onKeyDown={(e) => {
          // A hash-shaped entry navigates instead of grepping (IntelliJ).
          if (e.key === 'Enter' && HASH_RE.test(e.currentTarget.value.trim())) {
            onGoToRef(e.currentTarget.value.trim());
          }
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
        value={refsLabel(filter)}
        onClear={() => {
          const next = { ...filter, refs: 'HEAD' as const };
          delete next.range;
          onChange(next);
        }}
      >
        {() => (
          <>
            <input
              className="gt-input gt-filter-search"
              placeholder="Search refs"
              aria-label="Search refs"
              value={refSearch}
              onChange={(e) => setRefSearch(e.currentTarget.value)}
            />
            <div className="gt-filter-list">
              <CheckRow
                label="HEAD (Current)"
                checked={headOnly}
                onToggle={() => {
                  // Nothing to un-check into: HEAD *is* the empty filter, so an
                  // already-checked click is a no-op rather than a log re-run
                  // (`applyFilter` restarts the session on every change).
                  if (headOnly) return;
                  const next = { ...filter, refs: 'HEAD' as const };
                  delete next.range;
                  onChange(next);
                }}
              />
              <CheckRow
                label="All branches"
                checked={allBranches}
                onToggle={() => {
                  const next = { ...filter, refs: allBranches ? ('HEAD' as const) : ('ALL' as const) };
                  delete next.range;
                  onChange(next);
                }}
              />
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
        )}
      </Dropdown>

      <Dropdown
        label="User"
        testid="filter-user"
        value={filter.authors && filter.authors.length > 0 ? filter.authors.join(', ') : undefined}
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
        value={datesLabel(filter)}
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
        value={filter.paths && filter.paths.length > 0 ? filter.paths.join(', ') : undefined}
        onClear={() => {
          const next = { ...filter };
          delete next.paths;
          delete next.follow;
          onChange(next);
        }}
      >
        {() => (
          <div className="gt-filter-list">
            {(filter.paths ?? []).map((p) => (
              <div key={p} className="gt-filter-pathrow">
                <span className="gt-filter-checkrow-label">{p}</span>
                <button
                  type="button"
                  className="gt-chip-clear"
                  aria-label={`Remove ${p}`}
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
                    next.paths = [...(filter.paths ?? []), pathDraft.trim()];
                    delete next.follow;
                    onChange(next);
                    setPathDraft('');
                  }
                }}
              />
              <button type="button" className="gt-filter-row-button" onClick={onBrowsePaths}>
                Browse…
              </button>
            </div>
          </div>
        )}
      </Dropdown>

      <select
        className="gt-input gt-log-sort"
        aria-label="Sort"
        value={filter.sort}
        onChange={(e) => onChange({ ...filter, sort: e.currentTarget.value as LogFilterDto['sort'] })}
      >
        <option value="date">Date</option>
        <option value="topo">Topo</option>
        <option value="intelli">IntelliSort</option>
      </select>

      <span className="gt-filter-spacer" />

      <ToolbarButton label="Refresh log" icon="refresh" onClick={onRefresh} />
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
        onClick={() => onChange({ sort: filter.sort, refs: 'HEAD' })}
      />
    </div>
  );
}
