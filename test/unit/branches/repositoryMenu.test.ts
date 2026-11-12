import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  LEFT_OUT_OF_BRANCHES_VIEW,
  REPOSITORY_MENU,
  repositoryMenuDto,
  repositoryMenuEntry,
  repositoryMenuFor,
} from '../../../src/branches/repositoryMenu';

interface MenuEntry {
  command: string;
  when?: string;
  group?: string;
}

const root = path.resolve(__dirname, '../../..');
const manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as {
  contributes: {
    commands: Array<{ command: string; title: string }>;
    menus: Record<string, MenuEntry[]>;
  };
};
const nls = JSON.parse(readFileSync(path.join(root, 'package.nls.json'), 'utf8')) as Record<string, string>;

/** The Repositories section's repository menu, in the order VS Code draws it. */
function repositoriesSectionMenu(): Array<{ command: string; group: string }> {
  const groupOf = (g: string): [string, number] => {
    const [name, order] = g.split('@');
    return [name ?? '', Number(order ?? 0)];
  };
  return manifest.contributes.menus['view/item/context']!
    .filter((m) => m.when === 'view == gittree.repositories && viewItem == repository')
    .map((m) => ({ command: m.command, group: m.group ?? '' }))
    .sort((a, b) => {
      const [ga, oa] = groupOf(a.group);
      const [gb, ob] = groupOf(b.group);
      return ga.localeCompare(gb) || oa - ob;
    });
}

function titleOf(command: string): string {
  const raw = manifest.contributes.commands.find((c) => c.command === command)?.title ?? '';
  const key = /^%(.+)%$/u.exec(raw)?.[1];
  return key !== undefined ? (nls[key] ?? raw) : raw;
}

describe("REPOSITORY_MENU (a repository's right-click menu in the Branches section)", () => {
  it("is the Repositories section's menu, in its order, less what the Branches section already is", () => {
    const expected = repositoriesSectionMenu()
      .map((m) => m.command)
      .filter((c) => !LEFT_OUT_OF_BRANCHES_VIEW.includes(c));
    expect(REPOSITORY_MENU.map((e) => e.command)).toEqual(expected);
  });

  it('leaves out only commands the Repositories section really has', () => {
    const section = repositoriesSectionMenu().map((m) => m.command);
    for (const command of LEFT_OUT_OF_BRANCHES_VIEW) expect(section).toContain(command);
  });

  it('labels each entry with its command title, as that section does', () => {
    for (const entry of REPOSITORY_MENU) expect(entry.label).toBe(titleOf(entry.command));
  });

  it('groups as that section groups, so the rules fall in the same places', () => {
    const groups = new Map(repositoriesSectionMenu().map((m) => [m.command, m.group.split('@')[0]]));
    const boundaries = (list: string[]): boolean[] => list.map((g, i) => i > 0 && g !== list[i - 1]);
    expect(boundaries(REPOSITORY_MENU.map((e) => e.group))).toEqual(
      boundaries(REPOSITORY_MENU.map((e) => groups.get(e.command) ?? '')),
    );
  });

  it('opens with Show in New Log Tab, its own group: a way of looking, before the ways of acting', () => {
    expect(REPOSITORY_MENU[0]).toEqual({
      command: 'gittree.repositories.showInLog',
      label: 'Show in New Log Tab',
      group: 'view',
    });
    expect(REPOSITORY_MENU[1]?.group).not.toBe('view');
  });

  it('updates the repository under its own name, Without Fetching right under it (POST-P14bx)', () => {
    // Update Project… updates every repository everywhere else; here it updated this one alone.
    const commands = REPOSITORY_MENU.map((e) => e.command);
    const at = commands.indexOf('gittree.update.repository');
    expect(at).toBeGreaterThan(0);
    expect(commands[at + 1]).toBe('gittree.update.repositoryWithoutFetch');
    expect(repositoryMenuEntry('gittree.update.repository')).toEqual({
      command: 'gittree.update.repository',
      label: 'Update Repository…',
      group: 'update',
    });
    expect(repositoryMenuEntry('gittree.update.repositoryWithoutFetch')).toEqual({
      command: 'gittree.update.repositoryWithoutFetch',
      label: 'Update Repository Without Fetching…',
      group: 'update',
    });
    expect(commands).not.toContain('gittree.update.dialog');
    expect(commands).not.toContain('gittree.update.withoutFetch');
  });

  it("with one repository, which is the project, updates under the project's name (POST-P14bx)", () => {
    const one = repositoryMenuFor(1);
    expect(one.map((e) => e.label)).toEqual(
      REPOSITORY_MENU.map((e) =>
        e.command === 'gittree.update.repository'
          ? 'Update Project…'
          : e.command === 'gittree.update.repositoryWithoutFetch'
            ? 'Update Project Without Fetching…'
            : e.label,
      ),
    );
    const update = one.find((e) => e.label === 'Update Project…');
    expect(update).toEqual({ command: 'gittree.update.dialog', label: 'Update Project…', group: 'update' });
    expect(one.find((e) => e.label === 'Update Project Without Fetching…')?.command).toBe(
      'gittree.update.withoutFetch',
    );
    // The project's titles are those commands' own, as every entry's is.
    for (const entry of one) expect(entry.label).toBe(titleOf(entry.command));
    // Several: the repository's own.
    expect(repositoryMenuFor(2)).toBe(REPOSITORY_MENU);
    expect(repositoryMenuFor(20)).toBe(REPOSITORY_MENU);
  });

  it('offers Fetch, which with a root fetches that repository only', () => {
    expect(repositoryMenuEntry('gittree.fetch')?.label).toBe('Fetch');
    expect(REPOSITORY_MENU.map((e) => e.command)).not.toContain('gittree.fetch.all');
  });
});

describe('repositoryMenuDto', () => {
  it('draws a rule before each new group, never before the first entry', () => {
    const dto = repositoryMenuDto();
    expect(dto.map((d) => d.id)).toEqual(REPOSITORY_MENU.map((e) => e.command));
    expect(dto[0]?.separator).toBeUndefined();
    expect(dto.filter((d) => d.separator === true).map((d) => d.label)).toEqual([
      'Update Repository…',
      'Commit',
      'New Branch…',
      'Stash Changes…',
      'Manage Remotes…',
    ]);
  });
});

describe('repositoryMenuEntry', () => {
  it('knows only the menu\'s own commands', () => {
    expect(repositoryMenuEntry('gittree.push.dialog')?.label).toBe('Push…');
    expect(repositoryMenuEntry('gittree.branches.open')).toBeUndefined();
    expect(repositoryMenuEntry('workbench.action.reloadWindow')).toBeUndefined();
    expect(repositoryMenuEntry(42)).toBeUndefined();
    expect(repositoryMenuEntry(undefined)).toBeUndefined();
  });
});
