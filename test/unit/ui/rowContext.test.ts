import { describe, expect, it } from 'vitest';
import { folderOf, repoRootOf } from '../../../src/ui/rowContext';

describe('the folder a Commit-window folder row stands for (POST-P14bf)', () => {
  it('reads it from the row payload, repository-relative with forward slashes', () => {
    expect(folderOf([{ repoRoot: 'D:/r', relPaths: ['src/a.ts'], folder: 'src/experimental' }])).toBe('src/experimental');
    expect(folderOf([undefined, { folder: 'src\\app\\' }])).toBe('src/app');
    expect(folderOf([{ folder: '/.idea/' }])).toBe('.idea');
  });

  it('finds none for a file row, or a path that would climb out of the repository', () => {
    for (const args of [[], [{ relPath: 'a.ts' }], [{ folder: '' }], [{ folder: '/' }], [{ folder: '../x' }], [{ folder: 'a/../../b' }], [{ folder: 3 }]]) {
      expect(folderOf(args)).toBeUndefined();
    }
  });
});

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
