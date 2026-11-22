/** P10-T4: sanitized issue bodies + per-kind docs coverage. */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildIssueBody,
  DOCS_BASE,
  ERROR_DOCS,
  hashPaths,
  NEW_ISSUE_BASE,
  newIssueUrl,
  type IssueInfo,
} from '../../../src/core/errorUx';
import type { GitErrorKind } from '../../../src/core/git/errors';

const KINDS: GitErrorKind[] = [
  'index-lock',
  'would-overwrite-checkout',
  'merge-conflict',
  'auth',
  'not-fast-forward',
  'no-upstream',
  'unknown',
];

const info = (over: Partial<IssueInfo> = {}): IssueInfo => ({
  extensionVersion: '0.0.1',
  vscodeVersion: '1.129.0',
  os: 'win32 10.0.26200',
  gitVersion: '2.28.0.windows.1',
  capabilities: { fsmonitor: false, commitGraph: true },
  traceTail: [
    'exec git status in D:\\Users\\alice\\secret-project',
    'watch event /home/alice/repo/src/index.ts',
    'session repo=C:\\work\\client-repo',
    'queue: pull done in 812ms',
  ],
  ...over,
});

describe('hashPaths', () => {
  it('replaces Windows, POSIX, UNC and ~ paths with hashes', () => {
    for (const line of [
      'error at C:\\Users\\alice\\repo\\file.ts',
      'reading /home/alice/.gitconfig now',
      'share \\\\server\\repo mounted',
      'config ~/dotfiles/gitconfig loaded',
    ]) {
      const out = hashPaths(line);
      expect(out).toMatch(/#[0-9a-f]{8}/);
      expect(out).not.toMatch(/alice|server|dotfiles/);
    }
  });

  it('leaves path-free text alone', () => {
    expect(hashPaths('queue: pull done in 812ms')).toBe('queue: pull done in 812ms');
  });
});

describe('buildIssueBody / newIssueUrl', () => {
  it('keeps versions, caps and kinds; hashes every path in the trace tail', () => {
    const body = buildIssueBody(info({ errorKind: 'auth' }));
    expect(body).toContain('Geet: 0.0.1');
    expect(body).toContain('git: 2.28.0.windows.1');
    expect(body).toContain('fsmonitor=false');
    expect(body).toContain('error kind: auth');
    expect(body).toContain('queue: pull done in 812ms');
    expect(body).not.toMatch(/alice|secret-project|client-repo/);
  });

  it('url-encodes the whole body into the new-issue link', () => {
    const url = newIssueUrl(info());
    expect(url).toMatch(/^https:\/\/github\.com\/ntson9p\/geet\/issues\/new\?/);
    expect(decodeURIComponent(url)).not.toMatch(/secret-project/);
  });
});

describe('ERROR_DOCS', () => {
  it('every GitErrorKind deep-links a docs page', () => {
    for (const kind of KINDS) {
      expect(ERROR_DOCS[kind], kind).toMatch(/^https:\/\/.+\/docs\/.+\.md/);
    }
  });
});

// POST-P14cu: both went to a placeholder repository that does not exist.
describe('Help and Report Issue open the repository package.json names', () => {
  const root = path.resolve(__dirname, '../../..');
  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as {
    repository: { url: string };
    bugs: { url: string };
  };

  it('Report Issue opens a new issue there', () => {
    expect(NEW_ISSUE_BASE).toBe(`${pkg.bugs.url}/new`);
    expect(newIssueUrl(info()).startsWith(`${pkg.bugs.url}/new?`)).toBe(true);
  });

  it('Help opens the docs on its main branch', () => {
    expect(DOCS_BASE).toBe(`${pkg.repository.url.replace(/\.git$/u, '')}/blob/main/docs`);
  });

  /** GitHub's anchor for a heading: lower case, punctuation dropped, each space a hyphen. */
  const anchor = (heading: string): string =>
    heading
      .trim()
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\p{M}\p{Pc} -]/gu, '')
      .replace(/ /gu, '-');

  it('every Help link names a file in docs/ and a heading in it', () => {
    // A renamed heading (the rename to Geet changed some) breaks its link silently.
    expect(anchor('Can I use GitHub Enterprise / self-hosted GitLab?')).toBe(
      'can-i-use-github-enterprise--self-hosted-gitlab',
    );
    for (const kind of KINDS) {
      const link = ERROR_DOCS[kind];
      expect(link.startsWith(`${DOCS_BASE}/`), kind).toBe(true);
      const [file, hash] = link.slice(`${DOCS_BASE}/`.length).split('#');
      const full = path.join(root, 'docs', file!);
      expect(existsSync(full), `${kind}: docs/${file}`).toBe(true);
      if (hash === undefined) continue;
      const anchors = readFileSync(full, 'utf8')
        .split('\n')
        .flatMap((line) => /^#{1,6}\s+(.+?)\s*#*\s*$/u.exec(line)?.slice(1) ?? [])
        .map(anchor);
      expect(anchors, `${kind}: docs/${file}#${hash}`).toContain(hash);
    }
  });
});
