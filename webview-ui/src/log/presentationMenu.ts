/**
 * The Commits pane's `Presentation Settings ▾` (the eye), in IntelliJ's order:
 * `Show` · Compact References View · Tag Names · References on the Left ·
 * Columns ▸ Author · Hash · Date — after GitTree's own `Graph`, which IntelliJ
 * has no row for. IntelliJ's other rows — Root Names, Long Edges, Commit
 * Timestamp and the Highlight group — are left out: a checkbox that changes
 * nothing would be worse than its absence. Pure, so the rows and what each
 * toggles are testable without a page.
 */
import {
  DEFAULT_LOG_PRESENTATION,
  LOG_DATE_FORMATS,
  LOG_FILTER_CHIPS,
  type LogPresentationDto,
  type LogPresentationToggle,
} from '../../../src/shared/protocol';

export type PresentationRow =
  | { readonly kind: 'header'; readonly id: string; readonly label: string }
  | { readonly kind: 'item'; readonly id: string; readonly label: string; readonly checked: boolean }
  | {
      readonly kind: 'submenu';
      readonly id: string;
      readonly label: string;
      readonly items: ReadonlyArray<{
        readonly kind: 'item';
        readonly id: string;
        readonly label: string;
        readonly checked: boolean;
      }>;
    };

/** Each row's setting. */
const TOGGLES: Readonly<Record<string, LogPresentationToggle>> = {
  graph: 'showGraph',
  compactReferences: 'compactReferences',
  tagNames: 'showTagNames',
  referencesOnLeft: 'referencesOnLeft',
  'column:author': 'showAuthorColumn',
  'column:hash': 'showHashColumn',
  'column:date': 'showDateColumn',
};

export function presentationItems(p: LogPresentationDto): PresentationRow[] {
  return [
    { kind: 'header', id: 'show', label: 'Show' },
    // POST-P14bh: the lanes and dots. Off, the rows are the message and the columns.
    { kind: 'item', id: 'graph', label: 'Graph', checked: p.showGraph },
    { kind: 'item', id: 'compactReferences', label: 'Compact References View', checked: p.compactReferences },
    { kind: 'item', id: 'tagNames', label: 'Tag Names', checked: p.showTagNames },
    { kind: 'item', id: 'referencesOnLeft', label: 'References on the Left', checked: p.referencesOnLeft },
    {
      kind: 'submenu',
      id: 'columns',
      label: 'Columns',
      // IntelliJ's order (`getDefaultDynamicColumns`): Author, Hash, Date.
      items: [
        { kind: 'item', id: 'column:author', label: 'Author', checked: p.showAuthorColumn },
        { kind: 'item', id: 'column:hash', label: 'Hash', checked: p.showHashColumn },
        { kind: 'item', id: 'column:date', label: 'Date', checked: p.showDateColumn },
      ],
    },
  ];
}

/** What a click on row `id` changes, or nothing for a row that is not a toggle. */
export function presentationToggle(
  p: LogPresentationDto,
  id: string,
): Partial<LogPresentationDto> | undefined {
  const key = TOGGLES[id];
  return key === undefined ? undefined : { [key]: !p[key] };
}

/**
 * A whole `LogPresentationDto`, or nothing: a stray `{ ok: true }` must not
 * blank every toggle. A setting the answer does not carry keeps its default
 * rather than turning off — a column must not vanish for want of it — and a
 * choice it carries a value the setting does not offer keeps its default too.
 */
export function asPresentation(value: unknown): LogPresentationDto | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  if (typeof raw.showTagNames !== 'boolean' || typeof raw.showTags !== 'boolean') return undefined;
  const out: LogPresentationDto = { ...DEFAULT_LOG_PRESENTATION };
  const toggles = Object.keys(DEFAULT_LOG_PRESENTATION).filter(
    (k): k is LogPresentationToggle => typeof DEFAULT_LOG_PRESENTATION[k as keyof LogPresentationDto] === 'boolean',
  );
  for (const key of toggles) {
    const v = raw[key];
    if (typeof v === 'boolean') out[key] = v;
  }
  if ((LOG_DATE_FORMATS as readonly unknown[]).includes(raw.dateFormat)) {
    out.dateFormat = raw.dateFormat as LogPresentationDto['dateFormat'];
  }
  if ((LOG_FILTER_CHIPS as readonly unknown[]).includes(raw.filterChips)) {
    out.filterChips = raw.filterChips as LogPresentationDto['filterChips'];
  }
  return out;
}
