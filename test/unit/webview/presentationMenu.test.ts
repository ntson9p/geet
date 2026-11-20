import { describe, expect, it } from 'vitest';
import { DEFAULT_LOG_PRESENTATION } from '../../../src/shared/protocol';
import {
  asPresentation,
  presentationItems,
  presentationToggle,
} from '../../../webview-ui/src/log/presentationMenu';

/** Windows' US Region settings, as the host hands them to the page. */
const US = { date: 'M/d/yyyy', time: 'h:mm a', locale: 'en-US' };
/** Saturday 2026-11-14, 09:05 where the tests run. */
const NOW = new Date(2026, 10, 14, 9, 5).getTime();

describe("presentationItems (IntelliJ's Presentation Settings ▾)", () => {
  it('reads Show · Graph · Compact References View · Tag Names · References on the Left · Columns ▸ · Date Format ▸', () => {
    const rows = presentationItems(DEFAULT_LOG_PRESENTATION);
    expect(rows.map((r) => r.label)).toEqual([
      'Show',
      // POST-P14bh: Geet's own row, first under Show.
      'Graph',
      'Compact References View',
      'Tag Names',
      'References on the Left',
      'Columns',
      // POST-P14cg: Geet's own; IntelliJ keeps its date formats in Settings.
      'Date Format',
    ]);
    const columns = rows[5]!;
    expect(columns.kind).toBe('submenu');
    // IntelliJ's own order: Author, Hash, Date.
    expect(columns.kind === 'submenu' ? columns.items.map((i) => i.label) : []).toEqual(['Author', 'Hash', 'Date']);
  });

  it("ticks the defaults: the graph, IntelliJ's compact view, Author and Date, and the year-first dates", () => {
    const rows = presentationItems(DEFAULT_LOG_PRESENTATION);
    const ticked = rows.flatMap((r) =>
      r.kind === 'item' ? (r.checked ? [r.label] : []) : r.kind === 'submenu' ? r.items.filter((i) => i.checked).map((i) => i.label) : [],
    );
    expect(ticked).toEqual(['Graph', 'Compact References View', 'Author', 'Date', 'Year First']);
  });

  describe('Date Format ▸ (POST-P14cg)', () => {
    const dateFormat = (p = DEFAULT_LOG_PRESENTATION) => {
      const row = presentationItems(p, NOW, { system: US }).find((r) => r.id === 'dateFormat');
      if (row?.kind !== 'submenu') throw new Error('no Date Format submenu');
      return row.items;
    };

    it('offers Year First, IntelliJ and System, in that order, as one choice', () => {
      expect(dateFormat().map((i) => i.label)).toEqual(['Year First', 'IntelliJ', 'System']);
      expect(dateFormat().map((i) => i.id)).toEqual([
        'dateFormat:YYYY/MM/DD HH:mm',
        'dateFormat:pretty',
        'dateFormat:locale',
      ]);
      expect(dateFormat().every((i) => i.radio === true)).toBe(true);
    });

    it('shows each choice writing today at 14:19, at the right of its row', () => {
      expect(dateFormat().map((i) => i.accelerator)).toEqual(['2026/11/14 14:19', 'Today 2:19 PM', '11/14/2026 2:19 PM']);
    });

    it('ticks the format that holds, and only it', () => {
      expect(dateFormat().map((i) => i.checked)).toEqual([true, false, false]);
      expect(dateFormat({ ...DEFAULT_LOG_PRESENTATION, dateFormat: 'pretty' }).map((i) => i.checked)).toEqual([
        false,
        true,
        false,
      ]);
      expect(dateFormat({ ...DEFAULT_LOG_PRESENTATION, dateFormat: 'locale' }).map((i) => i.checked)).toEqual([
        false,
        false,
        true,
      ]);
    });

    it('says on hover what each writes', () => {
      expect(dateFormat()[1]?.title).toContain('IntelliJ');
      expect(dateFormat().every((i) => typeof i.title === 'string' && i.title.length > 0)).toBe(true);
    });
  });

  it('unticks Graph when the setting is off', () => {
    const graph = presentationItems({ ...DEFAULT_LOG_PRESENTATION, showGraph: false }).find((r) => r.id === 'graph');
    expect(graph).toMatchObject({ kind: 'item', checked: false });
  });
});

describe('presentationToggle', () => {
  it('flips the setting behind each row', () => {
    const p = DEFAULT_LOG_PRESENTATION;
    expect(presentationToggle(p, 'graph')).toEqual({ showGraph: false });
    expect(presentationToggle({ ...p, showGraph: false }, 'graph')).toEqual({ showGraph: true });
    expect(presentationToggle(p, 'compactReferences')).toEqual({ compactReferences: false });
    expect(presentationToggle(p, 'tagNames')).toEqual({ showTagNames: true });
    expect(presentationToggle(p, 'referencesOnLeft')).toEqual({ referencesOnLeft: true });
    expect(presentationToggle(p, 'column:author')).toEqual({ showAuthorColumn: false });
    expect(presentationToggle(p, 'column:hash')).toEqual({ showHashColumn: true });
    expect(presentationToggle(p, 'column:date')).toEqual({ showDateColumn: false });
  });

  it('changes nothing for the caption, the submenu itself, or anything else', () => {
    expect(presentationToggle(DEFAULT_LOG_PRESENTATION, 'show')).toBeUndefined();
    expect(presentationToggle(DEFAULT_LOG_PRESENTATION, 'columns')).toBeUndefined();
    expect(presentationToggle(DEFAULT_LOG_PRESENTATION, 'dateFormat')).toBeUndefined();
    expect(presentationToggle(DEFAULT_LOG_PRESENTATION, 'longEdges')).toBeUndefined();
  });

  it('chooses the date format a Date Format row names (POST-P14cg)', () => {
    const p = DEFAULT_LOG_PRESENTATION;
    expect(presentationToggle(p, 'dateFormat:pretty')).toEqual({ dateFormat: 'pretty' });
    expect(presentationToggle(p, 'dateFormat:locale')).toEqual({ dateFormat: 'locale' });
    expect(presentationToggle({ ...p, dateFormat: 'pretty' }, 'dateFormat:YYYY/MM/DD HH:mm')).toEqual({
      dateFormat: 'YYYY/MM/DD HH:mm',
    });
  });

  it('changes nothing for the format that already holds, or one the setting does not offer', () => {
    expect(presentationToggle(DEFAULT_LOG_PRESENTATION, 'dateFormat:YYYY/MM/DD HH:mm')).toBeUndefined();
    expect(presentationToggle(DEFAULT_LOG_PRESENTATION, 'dateFormat:DD.MM.YYYY')).toBeUndefined();
    expect(presentationToggle(DEFAULT_LOG_PRESENTATION, 'dateFormat:')).toBeUndefined();
  });
});

describe('asPresentation (what the view takes from the host)', () => {
  it('takes a whole presentation, the two choices included', () => {
    const sent = { ...DEFAULT_LOG_PRESENTATION, showGraph: false, dateFormat: 'locale', filterChips: 'full' };
    expect(asPresentation(sent)).toEqual(sent);
    // POST-P14cg: IntelliJ's dates.
    expect(asPresentation({ ...DEFAULT_LOG_PRESENTATION, dateFormat: 'pretty' })?.dateFormat).toBe('pretty');
  });

  it('refuses what is no presentation at all', () => {
    expect(asPresentation({ ok: true })).toBeUndefined();
    expect(asPresentation(null)).toBeUndefined();
    expect(asPresentation('compact')).toBeUndefined();
  });

  it('keeps the default for a setting the answer leaves out, or carries wrongly', () => {
    // A host from before the Graph toggle and the two choices: nothing vanishes.
    const old = { showTagNames: true, showTags: true };
    expect(asPresentation(old)).toEqual({ ...DEFAULT_LOG_PRESENTATION, showTagNames: true });
    const odd = { ...DEFAULT_LOG_PRESENTATION, showGraph: 'no', dateFormat: 'DD.MM.YYYY', filterChips: 1 };
    expect(asPresentation(odd)).toEqual(DEFAULT_LOG_PRESENTATION);
  });
});
