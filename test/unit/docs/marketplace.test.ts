/**
 * POST-P14cr: what the Marketplace listing and the published extension rest on,
 * held so a later edit cannot quietly undo it. POST-P14ct: the name, Geet (GitTree
 * before: the Marketplace already had a "Git Tree").
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '../../..');
const read = (rel: string): string => readFileSync(path.join(root, rel), 'utf8');

interface Manifest {
  name: string;
  displayName: string;
  description: string;
  version: string;
  publisher: string;
  icon: string;
  repository: { type: string; url: string };
  homepage: string;
  bugs: { url: string };
  capabilities: {
    virtualWorkspaces: boolean;
    untrustedWorkspaces: { supported: boolean; description: string };
  };
}
const pkg = JSON.parse(read('package.json')) as Manifest;
const nls = JSON.parse(read('package.nls.json')) as Record<string, string>;
const REPO = 'https://github.com/ntson9p/geet';

describe('the Marketplace manifest', () => {
  it('is published as ntson9p.geet, listed as "Geet for Git"', () => {
    expect(pkg.publisher).toBe('ntson9p');
    expect(pkg.name).toBe('geet');
    // Git's trademark policy allows "[Product Name] for Git"; "Git" inside a word it does not.
    expect(pkg.displayName).toBe('Geet for Git');
  });

  it('names the real repository: vsce points the README’s links and images there', () => {
    expect(pkg.repository).toEqual({ type: 'git', url: `${REPO}.git` });
    expect(pkg.homepage).toBe(`${REPO}#readme`);
    expect(pkg.bugs.url).toBe(`${REPO}/issues`);
    // The placeholder those links went to before.
    expect(JSON.stringify(pkg)).not.toContain('gittree/git-tree-vsix');
  });

  it('stays off in Restricted Mode and in virtual workspaces, and says why', () => {
    expect(pkg.capabilities.virtualWorkspaces).toBe(false);
    expect(pkg.capabilities.untrustedWorkspaces.supported).toBe(false);
    const key = /^%(.+)%$/u.exec(pkg.capabilities.untrustedWorkspaces.description)?.[1];
    expect(key).toBeDefined();
    expect(nls[key!]).toMatch(/git/u);
  });

  it('lists no feature that was not built', () => {
    // GitHub/GitLab review was skipped by decision (README, section 7).
    expect(pkg.description).not.toMatch(/review/iu);
  });

  it('has a PNG icon of its own (the Marketplace refuses an SVG one)', () => {
    expect(pkg.icon).toMatch(/\.png$/u);
    const bytes = readFileSync(path.join(root, pkg.icon));
    expect(bytes.subarray(1, 4).toString('latin1')).toBe('PNG');
  });

  it("package-lock.json's own name and version are package.json's", () => {
    const lock = JSON.parse(read('package-lock.json')) as {
      name: string;
      version: string;
      packages: Record<string, { name?: string; version?: string }>;
    };
    expect(lock.name).toBe(pkg.name);
    expect(lock.packages['']?.name).toBe(pkg.name);
    expect(lock.version).toBe(pkg.version);
    expect(lock.packages['']?.version).toBe(pkg.version);
  });
});

const files = (dir: string, pattern: RegExp): string[] =>
  readdirSync(path.join(root, dir)).flatMap((name) => {
    const rel = path.join(dir, name);
    return statSync(path.join(root, rel)).isDirectory() ? files(rel, pattern) : pattern.test(name) ? [rel] : [];
  });

/** What a user gets and sees: the manifest and its strings, the README, the licence, the code, the webviews, `media/`, the shims. */
const shipped = (): string[] => [
  'package.json',
  'package.nls.json',
  'README.md',
  'LICENSE',
  ...files('src', /\.ts$/u),
  ...files(path.join('webview-ui', 'src'), /\.(tsx?|css)$/u),
  ...readdirSync(path.join(root, 'webview-ui')).filter((n) => n.endsWith('.html')).map((n) => path.join('webview-ui', n)),
  ...files('media', /\.(svg|json)$/u),
  ...files('shims', /./u),
];

describe('the old name, GitTree, is nowhere a user sees it', () => {
  // The CHANGELOG, the FAQ and the settings doc say it on purpose: they tell an old
  // build's user what became of it. Nothing else may.
  it('not in the manifest, the code, the webviews, the images, the README or the licence', () => {
    const seen = shipped();
    const found = seen.filter((rel) => /Git ?Tree/u.test(read(rel)));
    expect(found).toEqual([]);
    expect(seen.length).toBeGreaterThan(100);
  });

  it('the Command Palette says Geet: every command with a category has Geet’s', () => {
    const commands = (JSON.parse(read('package.json')) as { contributes: { commands: Array<{ category?: string }> } })
      .contributes.commands;
    const categories = new Set(commands.flatMap((c) => (c.category === undefined ? [] : [c.category])));
    expect([...categories]).toEqual(['Geet']);
  });
});

// POST-P14cy: the identifiers too. VS Code labels a setting from its key ("Gittree › …"
// until then), and command IDs show in Keyboard Shortcuts and settings.json. Renaming them
// once people had set them up would have needed a migration of their settings.
describe('the old identifiers, gittree.*, are nowhere a user sees them', () => {
  interface Contributes {
    commands: Array<{ command: string }>;
    configuration: Array<{ properties: Record<string, unknown> }>;
    views: Record<string, Array<{ id: string }>>;
    viewsContainers: Record<string, Array<{ id: string }>>;
    submenus: Array<{ id: string }>;
    colors: Array<{ id: string }>;
    walkthroughs: Array<{ id: string }>;
    keybindings: Array<{ command: string }>;
    languages: Array<{ id: string }>;
    grammars: Array<{ scopeName: string }>;
  }

  it('not in a file that ships, nor in the name of one', () => {
    const seen = shipped();
    expect(seen.filter((rel) => /gittree/iu.test(rel))).toEqual([]);
    expect(seen.filter((rel) => /gittree/iu.test(read(rel)))).toEqual([]);
  });

  it('every ID the manifest contributes starts with geet', () => {
    const c = (JSON.parse(read('package.json')) as { contributes: Contributes }).contributes;
    const dotted = [
      ...c.commands.map((x) => x.command),
      ...c.configuration.flatMap((s) => Object.keys(s.properties)),
      ...Object.values(c.views).flat().map((v) => v.id),
      ...c.submenus.map((s) => s.id),
      ...c.colors.map((s) => s.id),
      ...c.walkthroughs.map((s) => s.id),
      ...c.keybindings.map((k) => k.command),
    ];
    expect(dotted.length).toBeGreaterThan(300);
    expect(dotted.filter((id) => !id.startsWith('geet.'))).toEqual([]);
    // These have no dot to put after the name.
    expect(Object.values(c.viewsContainers).flat().map((v) => v.id).sort()).toEqual(['geet', 'geet-panel']);
    expect(c.languages.map((l) => l.id)).toEqual(['geet-commit-message']);
    expect(c.grammars.map((g) => g.scopeName)).toEqual(['text.geet-commit-message']);
  });
});

describe('the extension ID is never written into the code', () => {
  // It is `<publisher>.<name>`; a literal one broke the walkthrough when the publisher changed.
  const sources = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const full = path.join(dir, name);
      return statSync(full).isDirectory() ? sources(full) : /\.tsx?$/u.test(name) ? [full] : [];
    });

  it('no source file names one, old or new', () => {
    const found = [...sources(path.join(root, 'src')), ...sources(path.join(root, 'webview-ui', 'src'))]
      .filter((file) => /\b(gittree\.gittree|ntson9p\.gittree|ntson9p\.geet)\b/u.test(readFileSync(file, 'utf8')))
      .map((file) => path.relative(root, file));
    expect(found).toEqual([]);
  });
});

describe('the README, as the Marketplace page', () => {
  const readme = read('README.md');

  it('claims nothing about privacy that Generate Commit Message makes untrue', () => {
    expect(readme).not.toMatch(/nothing leaves your machine/iu);
    expect(readme).toMatch(/Generate Commit Message/u);
  });

  it('says Geet is not affiliated with JetBrains', () => {
    // `\s+`: the README wraps its lines, so a space can be a line break.
    expect(readme).toMatch(/not\s+affiliated\s+with\s+or\s+endorsed\s+by\s+JetBrains/u);
  });

  it('is titled "Geet for Git", and says Geet is not the Git project’s', () => {
    expect(readme.split('\n')[0]).toBe('# Geet for Git');
    // README.md breaks this line after "Git" (POST-P14cv: it failed in CI).
    expect(readme).toMatch(/not\s+affiliated\s+with\s+or\s+endorsed\s+by\s+the\s+Git\s+project/u);
  });
});
