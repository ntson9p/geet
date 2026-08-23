/** P10-T4: sanitized issue bodies + per-kind docs coverage. */
import { describe, expect, it } from 'vitest';
import { buildIssueBody, ERROR_DOCS, hashPaths, newIssueUrl, type IssueInfo } from '../../../src/core/errorUx';
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
    expect(body).toContain('GitTree: 0.0.1');
    expect(body).toContain('git: 2.28.0.windows.1');
    expect(body).toContain('fsmonitor=false');
    expect(body).toContain('error kind: auth');
    expect(body).toContain('queue: pull done in 812ms');
    expect(body).not.toMatch(/alice|secret-project|client-repo/);
  });

  it('url-encodes the whole body into the new-issue link', () => {
    const url = newIssueUrl(info());
    expect(url).toMatch(/^https:\/\/github\.com\/gittree\/git-tree-vsix\/issues\/new\?/);
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
