/**
 * Error UX plumbing (P10-T4) — vscode-free: per-GitErrorKind docs deep-links
 * and the sanitized "Report issue" body builder. The vscode-facing dialog
 * (actionable copy, Help/Report buttons) lives in src/hardening/errorUx.ts.
 *
 * Sanitization contract for issue bodies: absolute paths (and home-relative
 * paths) are replaced by 8-hex-char sha256 stand-ins, so environment details
 * (versions, capabilities, error kinds, timings) survive but no path, repo
 * name or file name does.
 */
import { createHash } from 'node:crypto';
import type { GitErrorKind } from './git/errors';

/**
 * The repository's docs on GitHub. Like {@link NEW_ISSUE_BASE}, held by a unit test to
 * package.json's `repository`, and each link below to a heading that exists.
 */
export const DOCS_BASE = 'https://github.com/ntson9p/geet/blob/main/docs';

/** Every GitErrorKind has a docs anchor — the compiler enforces coverage. */
export const ERROR_DOCS: Record<GitErrorKind, string> = {
  'index-lock': `${DOCS_BASE}/faq.md#the-log-is-slow-on-a-gigantic-repository-what-helps`,
  'would-overwrite-checkout': `${DOCS_BASE}/migration-from-builtin.md#2-feature-equivalents`,
  'merge-conflict': `${DOCS_BASE}/keyboard.md#default-keybindings`,
  'auth': `${DOCS_BASE}/faq.md#can-i-use-github-enterprise--self-hosted-gitlab`,
  'not-fast-forward': `${DOCS_BASE}/migration-from-builtin.md#2-feature-equivalents`,
  'no-upstream': `${DOCS_BASE}/migration-from-builtin.md#2-feature-equivalents`,
  'unknown': `${DOCS_BASE}/faq.md`,
};

/** package.json's `bugs.url`, then `/new`. */
export const NEW_ISSUE_BASE = 'https://github.com/ntson9p/geet/issues/new';

/** Windows drive paths, UNC paths, POSIX absolute paths, ~-relative paths. */
const PATH_RE = /(?:[A-Za-z]:[\\/]|\\\\|\/(?!\/)|~[\\/])[^\s'"`|<>]*/g;

export function hashPaths(line: string): string {
  return line.replace(PATH_RE, (m) => `#${createHash('sha256').update(m).digest('hex').slice(0, 8)}`);
}

export interface IssueInfo {
  extensionVersion: string;
  vscodeVersion: string;
  os: string;
  gitVersion: string;
  /** Capability map — booleans only. */
  capabilities: Record<string, boolean>;
  /** Most recent trace lines (paths get hashed here). */
  traceTail: readonly string[];
  /** Optional classified kind when reporting from an error dialog. */
  errorKind?: GitErrorKind;
}

export function buildIssueBody(info: IssueInfo): string {
  const caps = Object.entries(info.capabilities)
    .map(([k, v]) => `${k}=${String(v)}`)
    .join(', ');
  const tail = info.traceTail.slice(-25).map((l) => hashPaths(l));
  return [
    '<!-- Pre-filled by Geet: paths are hashed; please describe what you did. -->',
    '## What happened',
    '',
    '',
    '## Environment',
    `- Geet: ${info.extensionVersion}`,
    `- VS Code: ${info.vscodeVersion}`,
    `- OS: ${info.os}`,
    `- git: ${info.gitVersion}`,
    `- capabilities: ${caps}`,
    ...(info.errorKind !== undefined ? [`- error kind: ${info.errorKind}`] : []),
    '',
    '## Trace tail (paths hashed)',
    '```',
    ...tail,
    '```',
  ].join('\n');
}

export function newIssueUrl(info: IssueInfo): string {
  const title = info.errorKind !== undefined ? `[${info.errorKind}] ` : '';
  const params = new URLSearchParams({ title, body: buildIssueBody(info) });
  return `${NEW_ISSUE_BASE}?${params.toString()}`;
}
