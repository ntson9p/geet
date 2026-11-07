import { describe, expect, it } from 'vitest';
import { repoRootOf } from '../../../src/ui/rowContext';

describe("the repository a webview row's menu was opened on", () => {
  it('reads repoRoot from the row payload VS Code hands the command', () => {
    expect(repoRootOf({ webviewSection: 'commitRepository', repoRoot: 'D:/repos/api', repoHasTracked: true })).toBe(
      'D:/repos/api',
    );
  });

  it('finds none in anything else a command can be called with', () => {
    for (const arg of [undefined, null, 'D:/repos/api', ['a.ts'], {}, { repoRoot: '' }, { repoRoot: 3 }]) {
      expect(repoRootOf(arg)).toBeUndefined();
    }
  });
});
