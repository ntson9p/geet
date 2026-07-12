/**
 * Filter bar (P4-T4): IntelliJ chip order — Branch, User, Date, Path — plus
 * a free-text --grep box with regex/case toggles and the sort selector.
 * Chip pickers run HOST-side (QuickPicks); the bar shows active values and
 * clears with ×. All filters intersect in one LogFilter.
 */
import type { LogFilterDto } from '../../../src/shared/protocol';
import { ToolbarButton } from '../lib/Toolbar';

interface ChipProps {
  label: string;
  value: string | undefined;
  onPick: () => void;
  onClear: () => void;
}

function Chip({ label, value, onPick, onClear }: ChipProps) {
  return (
    <span className={`gt-filter-chipset${value !== undefined ? ' gt-active' : ''}`}>
      <button type="button" className="gt-chip-main" onClick={onPick} aria-label={label}>
        {label}
        {value !== undefined ? `: ${value}` : ''}
      </button>
      {value !== undefined ? (
        <button type="button" className="gt-chip-clear" onClick={onClear} aria-label={`Clear ${label}`}>
          ×
        </button>
      ) : null}
    </span>
  );
}

export interface FilterBarProps {
  filter: LogFilterDto;
  onChange: (next: LogFilterDto) => void;
  onPickBranches: () => void;
  onPickAuthors: () => void;
  onPickDates: () => void;
  onPickPaths: () => void;
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

export function FilterBar({ filter, onChange, onPickBranches, onPickAuthors, onPickDates, onPickPaths }: FilterBarProps) {
  const text = filter.text ?? { q: '', regex: false, matchCase: false };
  const anyActive =
    refsLabel(filter) !== undefined ||
    (filter.authors?.length ?? 0) > 0 ||
    datesLabel(filter) !== undefined ||
    (filter.paths?.length ?? 0) > 0 ||
    text.q.length > 0;

  return (
    <div className="gt-log-filterbar" role="toolbar" aria-label="Log filters">
      <Chip
        label="Branch"
        value={refsLabel(filter)}
        onPick={onPickBranches}
        onClear={() => {
          const next = { ...filter, refs: 'HEAD' as const };
          delete next.range;
          onChange(next);
        }}
      />
      <Chip
        label="User"
        value={filter.authors && filter.authors.length > 0 ? filter.authors.join(', ') : undefined}
        onPick={onPickAuthors}
        onClear={() => {
          const next = { ...filter };
          delete next.authors;
          onChange(next);
        }}
      />
      <Chip
        label="Date"
        value={datesLabel(filter)}
        onPick={onPickDates}
        onClear={() => {
          const next = { ...filter };
          delete next.dateRange;
          onChange(next);
        }}
      />
      <Chip
        label="Path"
        value={filter.paths && filter.paths.length > 0 ? filter.paths.join(', ') : undefined}
        onPick={onPickPaths}
        onClear={() => {
          const next = { ...filter };
          delete next.paths;
          delete next.follow;
          onChange(next);
        }}
      />

      <input
        type="text"
        className="gt-input gt-log-search"
        placeholder="Search messages"
        aria-label="Search commit messages"
        value={text.q}
        onChange={(e) => {
          const q = e.currentTarget.value;
          const next = { ...filter };
          if (q.length === 0) delete next.text;
          else next.text = { ...text, q };
          onChange(next);
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

      {anyActive ? (
        <ToolbarButton
          label="Reset all filters"
          icon="clear-all"
          onClick={() => onChange({ sort: filter.sort, refs: 'HEAD' })}
        />
      ) : null}
    </div>
  );
}
