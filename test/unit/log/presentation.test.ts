import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  PRESENTATION_SETTINGS,
  presentationPatch,
  settingId,
  writeScope,
} from '../../../src/log/presentation';
import { DEFAULT_LOG_PRESENTATION } from '../../../src/shared/protocol';

describe('writeScope (Presentation Settings / Branches Pane Settings toggles)', () => {
  it('writes where the setting is already set, workspace first', () => {
    expect(writeScope({ workspaceValue: true, globalValue: false }, 'global', true)).toBe('workspace');
    expect(writeScope({ globalValue: true }, 'workspace', true)).toBe('global');
  });

  it('falls back to the setting\'s own scope when nothing is set yet', () => {
    expect(writeScope({}, 'global', true)).toBe('global');
    expect(writeScope({}, 'workspace', true)).toBe('workspace');
    expect(writeScope(undefined, 'workspace', true)).toBe('workspace');
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
    ] as const) {
      expect(PRESENTATION_SETTINGS[name].scope).toBe('global');
    }
  });

  it('names each setting by its full id', () => {
    expect(settingId('showTagNames')).toBe('gittree.log.showTagNames');
    expect(settingId('showHashColumn')).toBe('gittree.log.columns.hash');
    expect(settingId('showTags')).toBe('gittree.branches.showTags');
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

  it('drops anything else', () => {
    expect(presentationPatch({ showTagNames: 'yes', showTags: 1, other: true })).toEqual({});
    expect(presentationPatch(undefined)).toEqual({});
    expect(presentationPatch(null)).toEqual({});
    expect(presentationPatch('showTags')).toEqual({});
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

  it("defaults to IntelliJ's own (`VcsLogApplicationSettings`, the default columns)", () => {
    expect(DEFAULT_LOG_PRESENTATION).toEqual({
      showTagNames: false,
      showTags: true,
      compactReferences: true,
      referencesOnLeft: false,
      showAuthorColumn: true,
      showDateColumn: true,
      showHashColumn: false,
    });
  });
});
