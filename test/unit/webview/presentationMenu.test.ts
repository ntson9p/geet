import { describe, expect, it } from 'vitest';
import { DEFAULT_LOG_PRESENTATION } from '../../../src/shared/protocol';
import { presentationItems, presentationToggle } from '../../../webview-ui/src/log/presentationMenu';

describe("presentationItems (IntelliJ's Presentation Settings ▾)", () => {
  it('reads Show · Compact References View · Tag Names · References on the Left · Columns ▸', () => {
    const rows = presentationItems(DEFAULT_LOG_PRESENTATION);
    expect(rows.map((r) => r.label)).toEqual([
      'Show',
      'Compact References View',
      'Tag Names',
      'References on the Left',
      'Columns',
    ]);
    const columns = rows[4]!;
    expect(columns.kind).toBe('submenu');
    // IntelliJ's own order: Author, Hash, Date.
    expect(columns.kind === 'submenu' ? columns.items.map((i) => i.label) : []).toEqual(['Author', 'Hash', 'Date']);
  });

  it("ticks IntelliJ's defaults: compact view, Author and Date", () => {
    const rows = presentationItems(DEFAULT_LOG_PRESENTATION);
    const ticked = rows.flatMap((r) =>
      r.kind === 'item' ? (r.checked ? [r.label] : []) : r.kind === 'submenu' ? r.items.filter((i) => i.checked).map((i) => i.label) : [],
    );
    expect(ticked).toEqual(['Compact References View', 'Author', 'Date']);
  });
});

describe('presentationToggle', () => {
  it('flips the setting behind each row', () => {
    const p = DEFAULT_LOG_PRESENTATION;
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
