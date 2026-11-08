/**
 * new-way-6: a branch twenty repositories share had a menu of thirty rows,
 * twenty of them repository names, taller than the sidebar. The repositories'
 * own menus are listed while they are five or fewer, and held in one
 * `In One Repository` row past that.
 */
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { INLINE_REPOSITORIES, oneRepositoryItems } from '../../../src/branches/oneRepository';
import type { BranchPanelMenuItemDto } from '../../../src/shared/protocol';

const words = { header: 'In one repository', folded: 'In One Repository' };

/** A repository's own submenu, as `branchMenu` builds it. */
function repoMenu(label: string): BranchPanelMenuItemDto {
  return {
    kind: 'submenu',
    label,
    icon: 'repo',
    items: [
      {
        kind: 'item',
        label: 'Checkout',
        run: { type: 'action', target: { kind: 'local', name: 'x', roots: [`/${label}`] }, action: 'checkout', root: `/${label}` },
      },
    ],
  };
}

const repos = (n: number): BranchPanelMenuItemDto[] => Array.from({ length: n }, (_, i) => repoMenu(`repo${i + 1}`));

describe('the per-repository part of a branch’s menu', () => {
  it('lists up to five repositories under its heading, as before', () => {
    expect(INLINE_REPOSITORIES).toBe(5);
    for (const n of [2, 3, 5]) {
      const menus = repos(n);
      expect(oneRepositoryItems(menus, words)).toEqual([{ kind: 'header', label: 'In one repository' }, ...menus]);
    }
  });

  it('holds six or more in one row, each repository’s own menu inside it, in order', () => {
    for (const n of [6, 20]) {
      const menus = repos(n);
      const items = oneRepositoryItems(menus, words);
      expect(items).toHaveLength(1);
      expect(items[0]).toEqual({ kind: 'submenu', label: 'In One Repository', icon: 'repo', items: menus });
    }
  });

  it('says nothing when no repository has a menu to offer', () => {
    expect(oneRepositoryItems([], words)).toEqual([]);
  });

  it('is what a branch’s menu across repositories ends with', () => {
    const source = readFileSync(path.resolve(__dirname, '../../../src/branches/panelActions.ts'), 'utf8');
    const body = source.slice(source.indexOf('export function branchMenu('), source.indexOf('export function repositoryMenu('));
    expect(body).toMatch(/oneRepositoryItems\(/u);
    expect(body).toMatch(/header: vscode\.l10n\.t\('In one repository'\), folded: vscode\.l10n\.t\('In One Repository'\)/u);
    // No repository listed outside it.
    expect(body).not.toMatch(/kind: 'header', label: vscode\.l10n\.t\('In one repository'\)/u);
  });
});
