/**
 * The Commits pane's `Presentation Settings ▾` (the eye), in IntelliJ's order:
 * `Show` · Compact References View · Tag Names · References on the Left ·
 * Columns ▸ Author · Hash · Date. IntelliJ's other rows — Root Names, Long
 * Edges, Commit Timestamp and the Highlight group — are left out: a checkbox
 * that changes nothing would be worse than its absence. Pure, so the rows and
 * what each toggles are testable without a page.
 */
import type { LogPresentationDto } from '../../../src/shared/protocol';

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
const TOGGLES: Readonly<Record<string, keyof LogPresentationDto>> = {
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
