import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  canRevealInOS,
  revealPath,
  revealTargetOf,
  versionAtLeast,
  WSL_REVEAL_SINCE,
} from '../../../src/ui/revealTarget';

/**
 * POST-P14bq — Reveal in File Explorer / Reveal in Finder / Open Containing
 * Folder on the Commit window's rows: where it can work, and what a row names.
 */
describe('canRevealInOS', () => {
  const local = { desktop: true, remoteName: undefined, version: '1.96.0' };

  it('holds in a local desktop window, whatever the version', () => {
    expect(canRevealInOS(local)).toBe(true);
    expect(canRevealInOS({ ...local, remoteName: '' })).toBe(true);
  });

  it('never holds in VS Code for the Web: there is no file manager to open', () => {
    expect(canRevealInOS({ ...local, desktop: false })).toBe(false);
  });

  it("does not hold in a remote window: its files are on another machine", () => {
    for (const remoteName of ['ssh-remote', 'dev-container', 'attached-container', 'codespaces', 'tunnel']) {
      expect(canRevealInOS({ ...local, remoteName, version: '1.144.0' })).toBe(false);
    }
  });

  it('holds in a WSL window from the VS Code that reaches \\\\wsl$ on', () => {
    expect(WSL_REVEAL_SINCE).toBe('1.113.0');
    expect(canRevealInOS({ ...local, remoteName: 'wsl', version: '1.112.3' })).toBe(false);
    expect(canRevealInOS({ ...local, remoteName: 'wsl', version: '1.113.0' })).toBe(true);
    expect(canRevealInOS({ ...local, remoteName: 'wsl', version: '1.144.0' })).toBe(true);
    expect(canRevealInOS({ ...local, remoteName: 'wsl', version: '1.114.0-insider' })).toBe(true);
  });
});

describe('versionAtLeast', () => {
  it('compares each part as a number, not as text', () => {
    expect(versionAtLeast('1.113.0', '1.113.0')).toBe(true);
    expect(versionAtLeast('1.113.1', '1.113.0')).toBe(true);
    expect(versionAtLeast('1.112.9', '1.113.0')).toBe(false);
    expect(versionAtLeast('1.9.0', '1.10.0')).toBe(false);
    expect(versionAtLeast('2.0.0', '1.113.0')).toBe(true);
  });

  it('ignores a suffix, and takes an unreadable version for too old', () => {
    expect(versionAtLeast('1.113.0-insider', '1.113.0')).toBe(true);
    expect(versionAtLeast('', '1.113.0')).toBe(false);
    expect(versionAtLeast('next', '1.113.0')).toBe(false);
  });
});

describe('revealTargetOf', () => {
  const root = 'D:/repos/api';

  it("takes a file row's file: the row the menu was opened on, not the rest of the selection", () => {
    const fileRow = {
      webviewSection: 'commitFile',
      repoRoot: root,
      relPath: 'src/b.ts',
      relPaths: ['src/b.ts', 'src/a.ts', 'docs/x.md'],
    };
    expect(revealTargetOf([fileRow])).toEqual({ repoRoot: root, relPath: 'src/b.ts', folder: false });
  });

  it("takes a folder row's folder, not the first file it also carries", () => {
    const folderRow = {
      webviewSection: 'commitFolder',
      repoRoot: root,
      relPath: 'src/main/java/a.java',
      relPaths: ['src/main/java/a.java'],
      folder: 'src/main/java',
    };
    expect(revealTargetOf([folderRow])).toEqual({ repoRoot: root, relPath: 'src/main/java', folder: true });
  });

  it("takes the keyboard's row as the Commit window sends it", () => {
    expect(revealTargetOf([{ repoRoot: root, relPath: 'README.md' }])).toEqual({
      repoRoot: root,
      relPath: 'README.md',
      folder: false,
    });
    expect(revealTargetOf([{ repoRoot: root, folder: '.idea' }])).toEqual({
      repoRoot: root,
      relPath: '.idea',
      folder: true,
    });
  });

  it('cleans backslashes and stray slashes', () => {
    expect(revealTargetOf([{ repoRoot: root, relPath: 'src\\b.ts' }])?.relPath).toBe('src/b.ts');
    expect(revealTargetOf([{ repoRoot: root, folder: '/src/' }])?.relPath).toBe('src');
  });

  it('refuses a path that would leave the repository', () => {
    expect(revealTargetOf([{ repoRoot: root, relPath: '../other/secret.txt' }])).toBeUndefined();
    expect(revealTargetOf([{ repoRoot: root, relPath: 'src/../../x' }])).toBeUndefined();
    expect(revealTargetOf([{ repoRoot: root, relPath: 'C:/Windows/notepad.exe' }])).toBeUndefined();
    expect(revealTargetOf([{ repoRoot: root, folder: '..' }])).toBeUndefined();
  });

  it("reveals nothing for a folder row whose folder is unusable, rather than its first file", () => {
    expect(revealTargetOf([{ repoRoot: root, folder: '../x', relPath: 'src/a.ts' }])).toBeUndefined();
    expect(revealTargetOf([{ repoRoot: root, folder: 3, relPath: 'src/a.ts' }])).toBeUndefined();
  });

  it('has nothing to say about a row with no repository, no path, or a changelist row', () => {
    expect(revealTargetOf([])).toBeUndefined();
    expect(revealTargetOf([undefined, null, 'D:/repos/api', ['x']])).toBeUndefined();
    expect(revealTargetOf([{ relPath: 'a.ts' }])).toBeUndefined();
    expect(revealTargetOf([{ repoRoot: '', relPath: 'a.ts' }])).toBeUndefined();
    expect(revealTargetOf([{ repoRoot: root, relPath: '' }])).toBeUndefined();
    expect(revealTargetOf([{ repoRoot: root, listId: 'default', targets: [] }])).toBeUndefined();
  });

  it('finds the row among the arguments VS Code passes', () => {
    expect(revealTargetOf([undefined, { repoRoot: root, relPath: 'a.ts' }])?.relPath).toBe('a.ts');
  });
});

describe('revealPath', () => {
  it('puts the row under its repository in the platform’s spelling', () => {
    const root = path.join('repos', 'api');
    expect(revealPath(root, { repoRoot: root, relPath: 'src/main/a.ts', folder: false })).toBe(
      path.join(root, 'src', 'main', 'a.ts'),
    );
    expect(revealPath(root, { repoRoot: root, relPath: '.idea', folder: true })).toBe(path.join(root, '.idea'));
  });
});
