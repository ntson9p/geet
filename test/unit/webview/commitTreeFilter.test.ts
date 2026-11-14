/**
 * POST-P14ce: the Commit window's list narrowed to the repositories picked in
 * the Repositories panel. The host sends only theirs, and `filter` says what is
 * left out; the tree keeps the shape a workspace of several repositories has,
 * so a pick changes which repositories are listed, never how. What the bar
 * says is repoFilter.test.ts's; what it looks like, commit.spec.ts's.
 */
import { describe, expect, it } from 'vitest';
import {
  UNVERSIONED_GROUP_ID,
  type CommitChangeDto,
  type CommitFilterRepoDto,
  type CommitGroupDto,
  type CommitRepoDto,
  type CommitStateDto,
} from '../../../src/shared/protocol';
import {
  assembleCommitTree,
  collapsedAll,
  groupByOf,
  groupRowContext,
  isRowOfRepository,
  multiRepoOf,
  repositoryOfRow,
} from '../../../webview-ui/src/commit/commitTree';

const API = 'D:/repos/api';
const WEB = 'D:/repos/web';
const DOCS = 'D:/repos/docs';

function change(path: string, kind: CommitChangeDto['kind'] = 'modified', checked = kind !== 'untracked'): CommitChangeDto {
  return { path, code: '.M', kind, checked };
}

function list(id: string, name: string, changes: CommitChangeDto[]): CommitGroupDto {
  return { id, name, isActive: id === 'default', isDefault: id === 'default', checkable: true, changes };
}

function repo(root: string, label: string, colorIdx: number, changes: CommitChangeDto[]): CommitRepoDto {
  return {
    root,
    label,
    colorIdx,
    head: { branch: 'main' },
    groups: [list('default', 'Changes', changes), list(UNVERSIONED_GROUP_ID, 'Unversioned Files', [])],
  };
}

const api = repo(API, 'shop-api', 0, [change('src/server.ts'), change('package.json')]);
const web = repo(WEB, 'shop-web', 1, [change('src/App.tsx'), change('index.html', 'modified', false)]);
const docs = repo(DOCS, 'docs', 2, []);

function summary(r: CommitRepoDto): CommitFilterRepoDto {
  const changes = r.groups.flatMap((g) => g.changes);
  return { root: r.root, label: r.label, colorIdx: r.colorIdx, changes: changes.length, ticked: changes.filter((c) => c.checked).length };
}

function state(repos: CommitRepoDto[], overrides: Partial<CommitStateDto> = {}): CommitStateDto {
  return {
    repos,
    activeRepo: repos[0]?.root,
    targets: [],
    message: '',
    amend: false,
    signing: false,
    busy: false,
    modifiedCount: 0,
    checkedCount: 0,
    paradigm: 'changelists',
    ...overrides,
  };
}

/** The list narrowed to `shown`, the rest of the three left out, as the host sends it. */
function narrowed(shown: CommitRepoDto[], overrides: Partial<CommitStateDto> = {}): CommitStateDto {
  const hidden = [api, web, docs].filter((r) => !shown.includes(r));
  return state(shown, { filter: { shown: shown.map(summary), hidden: hidden.map(summary) }, ...overrides });
}

describe('a list narrowed to the repositories picked keeps the shape of several (POST-P14ce)', () => {
  it('counts the workspace, not the list, as several repositories', () => {
    expect(multiRepoOf(narrowed([api]))).toBe(true);
    expect(multiRepoOf(state([api, web]))).toBe(true);
    expect(multiRepoOf(state([api]))).toBe(false);
  });

  it('keeps the repository row over the files, which one repository alone does not draw', () => {
    const model = assembleCommitTree(narrowed([api]));
    expect(model.nodes.map((n) => n.path)).toEqual([`@n:${API}`]);
    const row = model.nodes[0]!;
    expect(row.kind === 'dir' ? row.children.map((c) => [c.name, c.depth]) : []).toEqual([
      ['package.json', 1],
      ['server.ts', 1],
    ]);
    expect(model.groups.get(`@n:${API}`)?.shows).toBe('repository');
  });

  it('keeps the grouping asked for: repositories first, or changelists over their repositories', () => {
    expect(groupByOf(narrowed([api], { groupBy: 'repository' }))).toBe('repository');
    expect(assembleCommitTree(narrowed([api], { groupBy: 'repository' })).nodes.map((n) => n.path)).toEqual([
      `@r:${API}`,
    ]);
    const byList = assembleCommitTree(narrowed([api], { groupBy: 'changelist' }));
    expect(byList.groupBy).toBe('changelist');
    expect(byList.groups.has(`@g:@default@r:${API}`)).toBe(true);
  });

  it('gives a file the path it has in the whole list: what is open or selected is found again', () => {
    const whole = assembleCommitTree(state([api, web, docs]));
    const part = assembleCommitTree(narrowed([api]));
    for (const path of part.files.keys()) expect(whole.files.has(path)).toBe(true);
    expect(part.files.has(`@n:${API}/src/server.ts`)).toBe(true);
    expect([...part.files.values()].every((ref) => ref.repoRoot === API)).toBe(true);
  });

  it('knows which repositories it leaves out, and the one it shows alone', () => {
    const one = assembleCommitTree(narrowed([api]));
    expect(one.hiddenRoots).toEqual([WEB, DOCS]);
    expect(one.shownRoots).toEqual([API]);
    expect(one.onlyRepo).toBe(API);
    const two = assembleCommitTree(narrowed([api, web]));
    expect(two.hiddenRoots).toEqual([DOCS]);
    expect(two.onlyRepo).toBeUndefined();
    const all = assembleCommitTree(state([api, web, docs]));
    expect(all.hiddenRoots).toEqual([]);
    expect(all.onlyRepo).toBeUndefined();
  });

  it('draws nothing for a repository shown with nothing to commit', () => {
    expect(assembleCommitTree(narrowed([docs])).nodes).toEqual([]);
    expect(assembleCommitTree(narrowed([docs])).files.size).toBe(0);
  });
});

describe("a repository row's menu, narrowed to it alone (POST-P14ce)", () => {
  it('says the list shows it alone, so the menu offers Show All Repositories', () => {
    const model = assembleCommitTree(narrowed([api]));
    expect(groupRowContext(model, `@n:${API}`)).toMatchObject({ webviewSection: 'commitRepository', repoShownAlone: true });
  });

  it('does not, shown among others or with every repository', () => {
    const two = assembleCommitTree(narrowed([api, web]));
    expect(groupRowContext(two, `@n:${API}`)).toMatchObject({ repoShownAlone: false });
    const all = assembleCommitTree(state([api, web, docs]));
    expect(groupRowContext(all, `@n:${WEB}`)).toMatchObject({ repoShownAlone: false });
  });
});

describe('Collapse All, narrowed (POST-P14ce)', () => {
  it("shuts the rows shown and leaves those of the repositories left out as they were, and the other groupings'", () => {
    const model = assembleCommitTree(narrowed([api], { groupByDirectory: true }));
    const open = new Set([
      `@n:${API}`,
      `@n:${API}/src`,
      `@n:${WEB}`,
      `@n:${WEB}/src`,
      `@n:${DOCS}`,
      `@r:${API}`,
      '@g:@default',
    ]);
    expect([...collapsedAll(model, open)].sort()).toEqual(
      [`@n:${WEB}`, `@n:${WEB}/src`, `@n:${DOCS}`, `@r:${API}`, '@g:@default'].sort(),
    );
  });

  it('shuts every row of the grouping when nothing is left out, as before', () => {
    const model = assembleCommitTree(state([api, web]));
    const open = new Set([`@n:${API}`, `@n:${WEB}/src`, '@g:@default']);
    expect([...collapsedAll(model, open)]).toEqual(['@g:@default']);
  });

  it('with changelists first, shuts the list rows and leaves a left-out repository under them as it was', () => {
    const model = assembleCommitTree(narrowed([api], { groupBy: 'changelist' }));
    const open = new Set(['@g:@default', `@g:@default@r:${API}`, `@g:@default@r:${WEB}`, `@g:@default@r:${WEB}/src`]);
    expect([...collapsedAll(model, open)].sort()).toEqual([`@g:@default@r:${WEB}`, `@g:@default@r:${WEB}/src`].sort());
  });

  it('tells a repository inside another apart from it', () => {
    const outer = 'D:/w/app';
    const inner = 'D:/w/app/vendor/lib';
    const shown = repo(inner, 'lib', 0, [change('x.ts')]);
    const hidden = repo(outer, 'app', 1, [change('y.ts')]);
    const model = assembleCommitTree(
      state([shown], { filter: { shown: [summary(shown)], hidden: [summary(hidden)] } }),
    );
    const open = new Set([`@n:${inner}`, `@n:${inner}/sub`, `@n:${outer}`, `@n:${outer}/src`]);
    // The inner one's rows name the outer root too; the longest root is theirs.
    expect([...collapsedAll(model, open)].sort()).toEqual([`@n:${outer}`, `@n:${outer}/src`].sort());
  });
});

describe("whose a row is (POST-P14ce)", () => {
  it("is a repository's own row, and every row under it, in every grouping", () => {
    expect(isRowOfRepository(`@n:${API}`, API)).toBe(true);
    expect(isRowOfRepository(`@n:${API}/src/x.ts`, API)).toBe(true);
    expect(isRowOfRepository(`@n:${API}@g:@conflicts`, API)).toBe(true);
    expect(isRowOfRepository(`@r:${API}@g:@default/src`, API)).toBe(true);
    expect(isRowOfRepository(`@g:@default@r:${API}`, API)).toBe(true);
    expect(isRowOfRepository(`@g:@default@r:${API}/src`, API)).toBe(true);
  });

  it("is not a changelist's row spanning repositories, nor another repository whose root starts the same", () => {
    expect(isRowOfRepository('@g:@default', API)).toBe(false);
    expect(isRowOfRepository(`@n:${API}-docs`, API)).toBe(false);
    expect(isRowOfRepository(`@n:${API}-docs/x.ts`, API)).toBe(false);
    expect(isRowOfRepository(`@n:${WEB}/x.ts`, API)).toBe(false);
  });

  it('is the longest root a row names, a repository inside another being its own', () => {
    const outer = 'D:/w/app';
    const inner = 'D:/w/app/vendor/lib';
    expect(repositoryOfRow(`@n:${inner}/x.ts`, [outer, inner])).toBe(inner);
    expect(repositoryOfRow(`@n:${outer}/src/y.ts`, [outer, inner])).toBe(outer);
    expect(repositoryOfRow('@g:@default', [outer, inner])).toBeUndefined();
  });
});
