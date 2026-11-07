import { describe, expect, it } from 'vitest';
import { DEFAULT_LOG_PRESENTATION } from '../../../src/shared/protocol';
import {
  asPresentation,
  presentationItems,
  presentationToggle,
} from '../../../webview-ui/src/log/presentationMenu';

describe("presentationItems (IntelliJ's Presentation Settings ▾)", () => {
  it('reads Show · Graph · Compact References View · Tag Names · References on the Left · Columns ▸', () => {
    const rows = presentationItems(DEFAULT_LOG_PRESENTATION);
    expect(rows.map((r) => r.label)).toEqual([
      'Show',
      // POST-P14bh: GitTree's own row, first under Show.
      'Graph',
      'Compact References View',
      'Tag Names',
      'References on the Left',
      'Columns',
    ]);
    const columns = rows[5]!;
    expect(columns.kind).toBe('submenu');
    // IntelliJ's own order: Author, Hash, Date.
    expect(columns.kind === 'submenu' ? columns.items.map((i) => i.label) : []).toEqual(['Author', 'Hash', 'Date']);
  });

  it("ticks the defaults: the graph, IntelliJ's compact view, Author and Date", () => {
    const rows = presentationItems(DEFAULT_LOG_PRESENTATION);
    const ticked = rows.flatMap((r) =>
      r.kind === 'item' ? (r.checked ? [r.label] : []) : r.kind === 'submenu' ? r.items.filter((i) => i.checked).map((i) => i.label) : [],
    );
    expect(ticked).toEqual(['Graph', 'Compact References View', 'Author', 'Date']);
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
    expect(presentationToggle(DEFAULT_LOG_PRESENTATION, 'longEdges')).toBeUndefined();
  });
});

describe('asPresentation (what the view takes from the host)', () => {
  it('takes a whole presentation, the two choices included', () => {
    const sent = { ...DEFAULT_LOG_PRESENTATION, showGraph: false, dateFormat: 'locale', filterChips: 'full' };
    expect(asPresentation(sent)).toEqual(sent);
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
