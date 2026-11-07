/**
 * POST-QA: GitTree writes an option where the user already keeps it, else in
 * their own settings — never a new value in the repository's
 * `.vscode/settings.json` — and not at all when it would not change.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { sameSettingValue, settingScope } from '../../../src/ui/settingScope';

describe('settingScope', () => {
  it('updates a workspace value where it is, so the change takes effect', () => {
    expect(settingScope({ workspaceValue: 'none' })).toBe('workspace');
    expect(settingScope({ workspaceValue: false, globalValue: true })).toBe('workspace');
    expect(settingScope({ workspaceFolderValue: 'rebase' })).toBe('workspace');
  });

  it('puts everything else in the user\'s settings', () => {
    expect(settingScope({})).toBe('global');
    expect(settingScope(undefined)).toBe('global');
    expect(settingScope({ globalValue: 'all' })).toBe('global');
  });
});

describe('sameSettingValue', () => {
  it('compares plain values and structures', () => {
    expect(sameSettingValue('none', 'none')).toBe(true);
    expect(sameSettingValue(true, false)).toBe(false);
    expect(sameSettingValue([{ name: 'a' }], [{ name: 'a' }])).toBe(true);
    expect(sameSettingValue([{ name: 'a' }], [{ name: 'b' }])).toBe(false);
    expect(sameSettingValue(undefined, null)).toBe(false);
  });
});

describe('no settings write targets the workspace on its own', () => {
  // Every `.update(…, ConfigurationTarget.Workspace)` in src must be the one
  // documented exception: the one-shot cleanup that *removes* a value.
  it('leaves only the documented cleanup', () => {
    const root = path.resolve(__dirname, '../../../src');
    const hits: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const p = path.join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith('.ts')) {
          const text = readFileSync(p, 'utf8');
          const re = /\.update\([^;]*ConfigurationTarget\.Workspace\)/gsu;
          for (const m of text.matchAll(re)) hits.push(`${path.relative(root, p)}: ${m[0].replace(/\s+/gu, ' ')}`);
        }
      }
    };
    walk(root);
    expect(hits).toEqual([expect.stringMatching(/^core[\\/]core\.ts: \.update\('enabled', undefined, /u)]);
  });
});
