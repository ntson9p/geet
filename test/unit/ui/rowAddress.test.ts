/**
 * POST-P14cd: the rows of Geet's own tree views that stand for a file or a
 * folder (Stashes, Local History, Conflicts, Worktrees) carry Geet's own
 * address, so that no other extension marks them: VS Code's built-in Git
 * marked a stashed file with its status now. Geet marks them with what is
 * true of the row. What VS Code draws is the integration suites' and a real
 * window's; this is the address and the marks.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ROW_MARKS,
  ROW_SCHEME,
  ROW_VIEWS,
  rowAddress,
  rowLook,
  rowMarkOf,
} from '../../../src/ui/rowAddress';

const root = path.resolve(__dirname, '../../..');
const read = (...p: string[]): string => readFileSync(path.join(root, ...p), 'utf8');

describe("a row's address", () => {
  it('is Geet’s scheme, the view as its authority, the file’s path, and the mark as its query', () => {
    expect(rowAddress('stash', '/c:/repos/api/src/a.ts', 'modified')).toEqual({
      scheme: 'geet-row',
      authority: 'stash',
      path: '/c:/repos/api/src/a.ts',
      query: 'modified',
    });
    expect(ROW_SCHEME).toBe('geet-row');
  });

  it('keeps the path absolute, and has no query without a mark', () => {
    expect(rowAddress('history', 'c:/repos/api/a.ts')).toEqual({
      scheme: 'geet-row',
      authority: 'history',
      path: '/c:/repos/api/a.ts',
      query: '',
    });
  });

  it("ends in the file's name, which VS Code's icon theme reads", () => {
    const { path: p } = rowAddress('history', '/c:/repos/api/src/index.ts');
    expect(p.slice(p.lastIndexOf('/') + 1)).toBe('index.ts');
  });
});

describe('the marks Geet draws', () => {
  it("are VS Code's letters, in Geet's status colours", () => {
    expect(ROW_MARKS.map((m) => [m, rowLook(m).letter, rowLook(m).color])).toEqual([
      ['added', 'A', 'geet.color.added'],
      ['modified', 'M', 'geet.color.modified'],
      ['deleted', 'D', 'geet.color.deleted'],
      ['renamed', 'R', 'geet.color.renamed'],
      ['untracked', 'U', 'geet.color.untracked'],
      ['conflicted', '!', 'geet.color.conflicted'],
    ]);
  });

  it('use colours Geet contributes, so they follow the theme with or without the built-in Git extension', () => {
    const manifest = JSON.parse(read('package.json')) as { contributes: { colors: Array<{ id: string }> } };
    const ids = new Set(manifest.contributes.colors.map((c) => c.id));
    for (const mark of ROW_MARKS) expect(ids.has(rowLook(mark).color)).toBe(true);
  });

  it('cover every status a stash records', () => {
    // StashFileStatus, as the stash service writes it.
    for (const status of ['modified', 'added', 'deleted', 'renamed', 'untracked']) {
      expect(ROW_MARKS).toContain(status);
    }
  });

  it('are read back from the address', () => {
    expect(rowMarkOf('geet-row', 'stash', 'deleted')).toEqual({ view: 'stash', mark: 'deleted' });
    expect(rowMarkOf('geet-row', 'conflict', 'conflicted')).toEqual({ view: 'conflict', mark: 'conflicted' });
  });

  it('are none for another scheme, another view, no mark, or a query that is no mark', () => {
    expect(rowMarkOf('file', 'stash', 'modified')).toBeUndefined();
    expect(rowMarkOf('geet-compare', '', 'M')).toBeUndefined();
    expect(rowMarkOf('geet-row', 'somewhere', 'modified')).toBeUndefined();
    expect(rowMarkOf('geet-row', 'history', '')).toBeUndefined();
    expect(rowMarkOf('geet-row', 'stash', 'M')).toBeUndefined();
    // The query is looked up, not trusted: no prototype key is a mark.
    for (const odd of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      expect(rowMarkOf('geet-row', 'stash', odd)).toBeUndefined();
    }
  });

  it('name the four views', () => {
    expect([...ROW_VIEWS]).toEqual(['stash', 'history', 'conflict', 'worktree']);
  });
});

describe("Geet's own tree views", () => {
  const VIEWS = [
    { file: ['src', 'stash', 'stashView.ts'], call: "rowUri('stash', fullPath, node.file.status)" },
    { file: ['src', 'localHistory', 'restoreUx.ts'], call: "rowUri('history', fullPath)" },
    { file: ['src', 'merge', 'conflictsView.ts'], call: "rowUri('conflict', path.join(node.session.repo.root, node.path), 'conflicted')" },
    { file: ['src', 'branches', 'worktrees.ts'], call: "rowUri('worktree', info.path)" },
  ] as const;

  it("give their file and folder rows Geet's address, with the mark that is true of the row", () => {
    for (const view of VIEWS) expect(read(...view.file)).toContain(`item.resourceUri = ${view.call};`);
  });

  it('give the rows that relied on their address for a hover a hover of their own', () => {
    expect(read('src', 'stash', 'stashView.ts')).toContain('item.tooltip = fullPath;');
    expect(read('src', 'localHistory', 'restoreUx.ts')).toContain('item.tooltip = fullPath;');
  });

  it('keep the name a screen reader hears, which VS Code would otherwise take from that hover', () => {
    // Seen in a real VS Code 1.144: with only the hover set, a stash row was read
    // out as its full path rather than `a.txt modified`.
    expect(read('src', 'stash', 'stashView.ts')).toContain(
      'item.accessibilityInformation = { label: `${name} ${description}` };',
    );
    expect(read('src', 'localHistory', 'restoreUx.ts')).toContain(
      'item.accessibilityInformation = { label: description.length > 0 ? `${name} ${description}` : name };',
    );
  });

  it("leave no tree row anywhere in Geet with a file: address, which another extension would mark", () => {
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const full = path.join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (name.endsWith('.ts') && /resourceUri\s*=\s*vscode\.Uri\.file\(/u.test(readFileSync(full, 'utf8'))) {
          offenders.push(path.relative(root, full));
        }
      }
    };
    walk(path.join(root, 'src'));
    expect(offenders).toEqual([]);
  });

  it('have their marks drawn from activation on', () => {
    expect(read('src', 'scm', 'register.ts')).toContain('registerRowDecorations(context);');
  });
});
