/**
 * POST-P14cr: what the Marketplace listing and the published extension rest on,
 * held so a later edit cannot quietly undo it.
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
const REPO = 'https://github.com/ntson9p/git-tree';

describe('the Marketplace manifest', () => {
  it('is published as ntson9p.gittree', () => {
    expect(pkg.publisher).toBe('ntson9p');
    expect(pkg.name).toBe('gittree');
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

  it("package-lock.json's own version is package.json's", () => {
    const lock = JSON.parse(read('package-lock.json')) as { version: string; packages: Record<string, { version?: string }> };
    expect(lock.version).toBe(pkg.version);
    expect(lock.packages['']?.version).toBe(pkg.version);
  });
});

describe('the extension ID is never written into the code', () => {
  // It is `<publisher>.gittree`; a literal one broke the walkthrough when the publisher changed.
  const sources = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const full = path.join(dir, name);
      return statSync(full).isDirectory() ? sources(full) : /\.tsx?$/u.test(name) ? [full] : [];
    });

  it('no source file names one, old or new', () => {
    const found = [...sources(path.join(root, 'src')), ...sources(path.join(root, 'webview-ui', 'src'))]
      .filter((file) => /\b(gittree|ntson9p)\.gittree\b/u.test(readFileSync(file, 'utf8')))
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

  it('says GitTree is not affiliated with JetBrains', () => {
    expect(readme).toMatch(/not affiliated with or endorsed by JetBrains/u);
  });
});
