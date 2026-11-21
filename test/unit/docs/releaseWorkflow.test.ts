/**
 * POST-P14cx: the release workflow publishes with Trusted Publishing
 * (`vsce publish --oidc`), not a stored token. Azure DevOps is retiring the
 * "all accessible organizations" tokens the Marketplace took, and a policy on
 * the Marketplace names the repository, the workflow file and one environment,
 * which docs/releasing.md tells the owner to enter. These hold the workflow and
 * that table to each other. Plain text, so no YAML parser is needed.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '../../..');
const workflow = readFileSync(path.join(root, '.github', 'workflows', 'release.yml'), 'utf8').replace(/\r\n/gu, '\n');
const releasing = readFileSync(path.join(root, 'docs', 'releasing.md'), 'utf8').replace(/\r\n/gu, '\n');

/** A top-level job's lines, from its `  name:` line to the next job's. */
function job(name: string): string {
  const start = workflow.indexOf(`\n  ${name}:\n`);
  expect(start, `job ${name}`).toBeGreaterThan(-1);
  const rest = workflow.slice(start + 1);
  const next = /\n {2}[a-z][\w-]*:\n/u.exec(rest.slice(1));
  return next === null ? rest : rest.slice(0, next.index + 1);
}

/** A job's steps: each `- ` item with its `if:` and `run:`. */
function steps(block: string): Array<{ name: string; if: string; run: string }> {
  return block
    .split(/\n {6}- /u)
    .slice(1)
    .map((s) => ({
      name: /(?:^|\n) *name: (.+)/u.exec(s)?.[1] ?? '',
      if: /(?:^|\n) *if: (.+)/u.exec(s)?.[1] ?? '',
      run: /(?:^|\n) *run: (.+)/u.exec(s)?.[1] ?? '',
    }));
}

/** A row of the Trusted Publishing table in docs/releasing.md (indented: it sits in a list item). */
function policy(field: string): string | undefined {
  return new RegExp(`^ *\\| ${field} \\| \`([^\`]+)\` \\|$`, 'mu').exec(releasing)?.[1];
}

describe('the release workflow publishes with Trusted Publishing', () => {
  it('every vsce publish uses --oidc, and no token is read from anywhere', () => {
    // The commands that run, not the comments that mention them.
    const publishes = workflow.split('\n').filter((l) => /^\s*run: .*\bvsce publish\b/u.test(l));
    expect(publishes.length).toBe(2);
    for (const line of publishes) {
      expect(line).toMatch(/ --oidc\b/u);
      expect(line).not.toMatch(/ -p\b|--pat\b/u); // (`node -p` elsewhere is not a token)
    }
    expect(workflow).not.toMatch(/VSCE_PAT|secrets\./u);
  });

  it('only the publish job may ask for an OIDC token, from the one environment', () => {
    // Least privilege at the top; the publish job asks for its own.
    expect(workflow).toMatch(/\npermissions:\n {2}contents: read\n/u);
    const publish = job('publish');
    expect(publish).toMatch(/\n {4}environment: marketplace\n/u);
    expect(publish).toMatch(/\n {6}id-token: write\b/u);
    expect(publish).toMatch(/\n {6}contents: write\b/u); // the stable version's GitHub Release
    expect(workflow.match(/id-token: write/gu)).toHaveLength(1);
    expect(workflow.match(/\n {4}environment:/gu)).toHaveLength(1);
  });

  it('an odd minor goes to the pre-release channel; an even one is stable, with a GitHub Release', () => {
    const all = steps(job('publish'));
    const pre = all.filter((s) => s.if.includes("prerelease == 'true'"));
    const stable = all.filter((s) => s.if.includes("prerelease == 'false'"));
    expect(pre.map((s) => s.run)).toEqual(['npx vsce publish --pre-release --packagePath vsix/*.vsix --oidc']);
    expect(stable.map((s) => s.name)).toEqual([
      'Extract changelog section (stable)',
      'vsce publish (stable)',
      'GitHub Release with vsix + notes (stable)',
    ]);
    // The changelog is extracted before anything is published: a missing section stops it first.
    expect(stable[1]?.run).toBe('npx vsce publish --packagePath vsix/*.vsix --oidc');
  });
});

describe('docs/releasing.md tells the owner what the policy must name', () => {
  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as {
    publisher: string;
    repository: { url: string };
  };
  const [, owner, repo] = /github\.com\/([^/]+)\/([^/.]+)/u.exec(pkg.repository.url) ?? [];

  it('the repository package.json names', () => {
    expect(policy('Repository owner')).toBe(owner);
    expect(policy('Repository')).toBe(repo);
  });

  it('this workflow file and its environment', () => {
    expect(policy('Workflow')).toBe('release.yml');
    expect(policy('Environment')).toBe(/\n {4}environment: (\S+)\n/u.exec(job('publish'))?.[1]);
  });

  it('and the publisher is package.json’s', () => {
    expect(releasing).toContain(`publisher with the ID **\`${pkg.publisher}\`**`);
  });
});
