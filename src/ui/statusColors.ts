/**
 * Host half of the file-status palette (P11-T8): reads the
 * `gittree.colors.<status>` override block and ships a validated map to the
 * webview surfaces (commit window state, Shelve dialog params). An invalid
 * value is dropped rather than injected into a style attribute — the value
 * lands in CSS, so only color-shaped strings pass.
 */
import * as vscode from 'vscode';

export const STATUS_KINDS = [
  'added',
  'modified',
  'deleted',
  'renamed',
  'untracked',
  'conflicted',
] as const;

export type StatusKind = (typeof STATUS_KINDS)[number];

/** #rgb / #rrggbb / #rrggbbaa, or a plain CSS color keyword. */
const COLOR_SHAPE = /^(#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?([0-9a-fA-F]{2})?|[a-zA-Z]{3,25})$/;

export function isValidStatusColor(value: string): boolean {
  return COLOR_SHAPE.test(value);
}

export function statusColorOverrides(): Partial<Record<StatusKind, string>> {
  const config = vscode.workspace.getConfiguration('gittree.colors');
  const out: Partial<Record<StatusKind, string>> = {};
  for (const kind of STATUS_KINDS) {
    const raw = config.get<string>(kind, '').trim();
    if (raw.length > 0 && isValidStatusColor(raw)) out[kind] = raw;
  }
  return out;
}
