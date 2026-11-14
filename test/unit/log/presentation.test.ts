import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  PRESENTATION_CHOICES,
  PRESENTATION_SETTINGS,
  presentationPatch,
  presentationSettingIds,
  presentationWrites,
  readDateFormat,
  readPresentation,
  settingId,
  writeScope,
} from '../../../src/log/presentation';
import { DEFAULT_LOG_PRESENTATION } from '../../../src/shared/protocol';

describe('writeScope (Presentation Settings / Branches Pane Settings toggles)', () => {
  it('writes where the setting is already set, workspace first', () => {
    expect(writeScope({ workspaceValue: true, globalValue: false }, 'global', true)).toBe('workspace');
    expect(writeScope({ globalValue: true }, 'workspace', true)).toBe('global');
  });

  it('puts a value set for the first time in the user\'s settings, never the repository\'s (POST-QA)', () => {
    expect(writeScope({}, 'global', true)).toBe('global');
    expect(writeScope({}, 'workspace', true)).toBe('global');
    expect(writeScope(undefined, 'workspace', true)).toBe('global');
  });

  it('never picks workspace settings without a workspace', () => {
    expect(writeScope({}, 'workspace', false)).toBe('global');
    // A workspace value cannot be in effect with no workspace open.
    expect(writeScope({ workspaceValue: true }, 'workspace', false)).toBe('global');
  });

  it('keeps Tag Names IDE-wide and Show Tags with the project, as IntelliJ does', () => {
    expect(PRESENTATION_SETTINGS.showTagNames.scope).toBe('global');
    expect(PRESENTATION_SETTINGS.showTags.scope).toBe('workspace');
  });

  it("keeps the label options and the visible columns IDE-wide, as IntelliJ's app settings do", () => {
    for (const name of [
      'compactReferences',
      'referencesOnLeft',
      'showAuthorColumn',
      'showDateColumn',
      'showHashColumn',
      'showGraph',
    ] as const) {
      expect(PRESENTATION_SETTINGS[name].scope).toBe('global');
    }
  });

  it('names each setting by its full id', () => {
    expect(settingId('showTagNames')).toBe('gittree.log.showTagNames');
    expect(settingId('showHashColumn')).toBe('gittree.log.columns.hash');
    expect(settingId('showTags')).toBe('gittree.branches.showTags');
    expect(settingId('showGraph')).toBe('gittree.log.showGraph');
    expect(settingId('dateFormat')).toBe('gittree.log.dateFormat');
    expect(settingId('filterChips')).toBe('gittree.log.filterChips');
  });

  it('lists every setting a view draws from, so a change to any reaches it', () => {
    const ids = presentationSettingIds();
    for (const id of [
      'gittree.log.showTagNames',
      'gittree.branches.showTags',
      'gittree.log.columns.date',
      'gittree.log.showGraph',
      'gittree.log.dateFormat',
      'gittree.log.filterChips',
    ]) {
      expect(ids).toContain(id);
    }
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('readPresentation (POST-P14bh)', () => {
  const settings = (values: Record<string, unknown>) => (section: string, key: string) =>
    values[`${section}.${key}`];

  it('reads what the settings say, and the defaults for what they do not', () => {
    const p = readPresentation(
      settings({ 'gittree.log.showGraph': false, 'gittree.log.dateFormat': 'locale', 'gittree.log.filterChips': 'full' }),
      DEFAULT_LOG_PRESENTATION,
    );
    expect(p).toEqual({ ...DEFAULT_LOG_PRESENTATION, showGraph: false, dateFormat: 'locale', filterChips: 'full' });
    expect(readPresentation(settings({}), DEFAULT_LOG_PRESENTATION)).toEqual(DEFAULT_LOG_PRESENTATION);
  });

  it('keeps the default for a value of the wrong kind, or one the setting does not offer', () => {
    const p = readPresentation(
      settings({
        'gittree.log.showGraph': 'no',
        'gittree.log.dateFormat': 'DD.MM.YYYY',
        'gittree.log.filterChips': true,
      }),
      DEFAULT_LOG_PRESENTATION,
    );
    expect(p).toEqual(DEFAULT_LOG_PRESENTATION);
  });

  it('offers exactly the choices the manifest declares', () => {
    expect(PRESENTATION_CHOICES.dateFormat.values).toEqual(['YYYY/MM/DD HH:mm', 'pretty', 'locale']);
    expect(PRESENTATION_CHOICES.filterChips.values).toEqual(['compact', 'full']);
  });

  it("reads IntelliJ's dates (POST-P14cg)", () => {
    expect(readPresentation(settings({ 'gittree.log.dateFormat': 'pretty' }), DEFAULT_LOG_PRESENTATION).dateFormat).toBe(
      'pretty',
    );
  });
});

describe('readDateFormat (the Commit window, POST-P14cg)', () => {
  it('takes every format the setting offers', () => {
    expect(readDateFormat('YYYY/MM/DD HH:mm')).toBe('YYYY/MM/DD HH:mm');
    expect(readDateFormat('pretty')).toBe('pretty');
    expect(readDateFormat('locale')).toBe('locale');
  });

  it('is the default for anything else', () => {
    expect(readDateFormat(undefined)).toBe('YYYY/MM/DD HH:mm');
    expect(readDateFormat('DD.MM.YYYY')).toBe('YYYY/MM/DD HH:mm');
    expect(readDateFormat(3)).toBe('YYYY/MM/DD HH:mm');
  });
});

describe('presentationPatch', () => {
  it('passes known keys with boolean values', () => {
    expect(presentationPatch({ showTagNames: true })).toEqual({ showTagNames: true });
    expect(presentationPatch({ showTags: false, showTagNames: false })).toEqual({
      showTags: false,
      showTagNames: false,
    });
  });

  it('passes the column and label toggles too', () => {
    expect(presentationPatch({ showHashColumn: true, compactReferences: false })).toEqual({
      showHashColumn: true,
      compactReferences: false,
    });
  });

  it('passes the Graph toggle', () => {
    expect(presentationPatch({ showGraph: false })).toEqual({ showGraph: false });
  });

  it('passes a date format the setting offers: Presentation Settings ▸ Date Format (POST-P14cg)', () => {
    expect(presentationPatch({ dateFormat: 'pretty' })).toEqual({ dateFormat: 'pretty' });
    expect(presentationPatch({ dateFormat: 'locale', showGraph: true })).toEqual({ dateFormat: 'locale', showGraph: true });
    expect(presentationPatch({ dateFormat: 'DD.MM.YYYY' })).toEqual({});
    expect(presentationPatch({ dateFormat: true })).toEqual({});
  });

  it("never passes the filter dropdowns' look: only the Settings editor changes it", () => {
    expect(presentationPatch({ filterChips: 'full' })).toEqual({});
  });

  it('drops anything else', () => {
    expect(presentationPatch({ showTagNames: 'yes', showTags: 1, other: true })).toEqual({});
    expect(presentationPatch(undefined)).toEqual({});
    expect(presentationPatch(null)).toEqual({});
    expect(presentationPatch('showTags')).toEqual({});
  });
});

describe('presentationWrites (POST-P14cg)', () => {
  it('writes each toggle to its setting, where the menu writes it', () => {
    expect(presentationWrites({ showTagNames: true, showTags: false })).toEqual([
      { section: 'gittree.log', key: 'showTagNames', value: true, scope: 'global' },
      { section: 'gittree.branches', key: 'showTags', value: false, scope: 'workspace' },
    ]);
  });

  it("writes Date Format's choice to gittree.log.dateFormat, IDE-wide as IntelliJ keeps its date formats", () => {
    expect(presentationWrites({ dateFormat: 'pretty' })).toEqual([
      { section: 'gittree.log', key: 'dateFormat', value: 'pretty', scope: 'global' },
    ]);
  });

  it('writes the toggles first, then the choice, and nothing for an empty patch', () => {
    expect(presentationWrites({ dateFormat: 'locale', showGraph: false }).map((w) => w.key)).toEqual([
      'showGraph',
      'dateFormat',
    ]);
    expect(presentationWrites({})).toEqual([]);
  });
});

describe('the settings behind them', () => {
  interface Property {
    type?: string;
    default?: unknown;
  }
  const manifest = JSON.parse(
    readFileSync(path.resolve(__dirname, '../../../package.json'), 'utf8'),
  ) as { contributes: { configuration: Array<{ properties: Record<string, Property> }> } };
  const properties = Object.assign(
    {},
    ...manifest.contributes.configuration.map((section) => section.properties),
  ) as Record<string, Property>;

  for (const [name, setting] of Object.entries(PRESENTATION_SETTINGS)) {
    const id = `${setting.section}.${setting.key}`;
    it(`declares ${id} as a boolean defaulting to what the views assume`, () => {
      expect(properties[id]?.type).toBe('boolean');
      expect(properties[id]?.default).toBe(
        DEFAULT_LOG_PRESENTATION[name as keyof typeof DEFAULT_LOG_PRESENTATION],
      );
    });
  }

  for (const [name, choice] of Object.entries(PRESENTATION_CHOICES)) {
    const id = `${choice.section}.${choice.key}`;
    it(`declares ${id} as one of its choices, defaulting to what the views assume`, () => {
      const declared = properties[id] as Property & { enum?: unknown[] };
      expect(declared?.type).toBe('string');
      expect(declared?.enum).toEqual([...choice.values]);
      expect(declared?.default).toBe(DEFAULT_LOG_PRESENTATION[name as keyof typeof DEFAULT_LOG_PRESENTATION]);
    });
  }

  it("defaults to IntelliJ's own (`VcsLogApplicationSettings`, the default columns), and the graph shown", () => {
    expect(DEFAULT_LOG_PRESENTATION).toEqual({
      showTagNames: false,
      showTags: true,
      compactReferences: true,
      referencesOnLeft: false,
      showAuthorColumn: true,
      showDateColumn: true,
      showHashColumn: false,
      showGraph: true,
      // GitTree's own, the owner's choice (D40, D39): IntelliJ has the locale's
      // date and every filter value written out.
      dateFormat: 'YYYY/MM/DD HH:mm',
      filterChips: 'compact',
    });
  });
});
