/**
 * The Commits pane's `Presentation Settings ▾` (the eye), in IntelliJ's order:
 * `Show` · Compact References View · Tag Names · References on the Left ·
 * Columns ▸ Author · Hash · Date — after Geet's own `Graph`, which IntelliJ
 * has no row for, and before Geet's own `Date Format ▸` (POST-P14cg), which
 * IntelliJ keeps in its Settings (Appearance & Behavior › System Settings ›
 * Date Formats). IntelliJ's other rows — Root Names, Long Edges, Commit
 * Timestamp and the Highlight group — are left out: a checkbox that changes
 * nothing would be worse than its absence. Pure, so the rows and what each
 * toggles are testable without a page.
 */
import {
  DEFAULT_LOG_PRESENTATION,
  LOG_DATE_FORMATS,
  LOG_FILTER_CHIPS,
  type LogDateFormat,
  type LogPresentationDto,
  type LogPresentationToggle,
} from '../../../src/shared/protocol';
import { dateFormatSample, type DateFormatOptions } from './dateFormat';

export interface PresentationChoiceRow {
  readonly kind: 'item';
  readonly id: string;
  readonly label: string;
  readonly checked: boolean;
  /** One of a run of choices only one of which holds: Date Format's. */
  readonly radio?: boolean;
  /** What the choice looks like, at the row's right. */
  readonly accelerator?: string;
  readonly title?: string;
}

export type PresentationRow =
  | { readonly kind: 'header'; readonly id: string; readonly label: string }
  | { readonly kind: 'item'; readonly id: string; readonly label: string; readonly checked: boolean }
  | {
      readonly kind: 'submenu';
      readonly id: string;
      readonly label: string;
      readonly items: ReadonlyArray<PresentationChoiceRow>;
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

/** A Date Format row's id: `dateFormat:` and the setting's value. */
const DATE_FORMAT_ROW = 'dateFormat:';

/**
 * Presentation Settings ▸ Date Format, in this order (POST-P14cg): Geet's
 * own default, IntelliJ's log as it ships, and the system's date and time
 * (IntelliJ's with "Use pretty formatting" off).
 */
export const DATE_FORMAT_CHOICES: ReadonlyArray<{
  readonly value: LogDateFormat;
  readonly label: string;
  readonly title: string;
}> = [
  {
    value: 'YYYY/MM/DD HH:mm',
    label: 'Year First',
    title: 'Year first, two digits for every other field, a 24-hour clock',
  },
  {
    value: 'pretty',
    label: 'IntelliJ',
    title: "As IntelliJ's log: 5 minutes ago, Today or Yesterday with the time, older dates in the system's format",
  },
  {
    value: 'locale',
    label: 'System',
    title: "The system's short date and time, for every date",
  },
];

/**
 * The menu's rows. `now` and `dates` are for the tests: the Date Format rows
 * show each format as it would write today at 14:19.
 */
export function presentationItems(
  p: LogPresentationDto,
  now: number = Date.now(),
  dates: DateFormatOptions = {},
): PresentationRow[] {
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
    {
      kind: 'submenu',
      id: 'dateFormat',
      label: 'Date Format',
      items: DATE_FORMAT_CHOICES.map(({ value, label, title }) => ({
        kind: 'item' as const,
        id: `${DATE_FORMAT_ROW}${value}`,
        label,
        checked: p.dateFormat === value,
        radio: true,
        accelerator: dateFormatSample(value, now, dates),
        title,
      })),
    },
  ];
}

/**
 * What a click on row `id` changes, or nothing for a row that is not a toggle
 * or a choice, or for the choice that already holds.
 */
export function presentationToggle(
  p: LogPresentationDto,
  id: string,
): Partial<LogPresentationDto> | undefined {
  if (id.startsWith(DATE_FORMAT_ROW)) {
    const value = id.slice(DATE_FORMAT_ROW.length);
    if (!(LOG_DATE_FORMATS as readonly string[]).includes(value) || value === p.dateFormat) return undefined;
    return { dateFormat: value as LogDateFormat };
  }
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
