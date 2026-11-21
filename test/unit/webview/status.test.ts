import { describe, expect, it } from 'vitest';
import { dirStatusColor, statusColor, statusIcon, themeColor } from '../../../webview-ui/src/lib/status';

describe('status palette (P11-T8)', () => {
  it('defaults to the geet.color.* theme colors with a visible fallback', () => {
    expect(statusColor('added')).toBe(
      'var(--vscode-geet-color\\.added, var(--vscode-geet-color-added, var(--vscode-foreground)))',
    );
    expect(statusColor('conflicted')).toContain('geet-color\\.conflicted');
  });

  it('reads a theme color by the name VS Code gives it in a webview', () => {
    // Only the first dot of the id becomes a dash; the one left is escaped.
    expect(themeColor('geet.color.added', 'red')).toBe(
      'var(--vscode-geet-color\\.added, var(--vscode-geet-color-added, red))',
    );
    // An id with one dot is a plain name, as VS Code's own colors are.
    expect(themeColor('list.hoverBackground', 'red')).toBe(
      'var(--vscode-list-hoverBackground, var(--vscode-list-hoverBackground, red))',
    );
  });

  it('a geet.colors override wins over the theme', () => {
    expect(statusColor('modified', { modified: '#ff8800' })).toBe('#ff8800');
    // Another status stays on the theme.
    expect(statusColor('added', { modified: '#ff8800' })).toContain('geet-color\\.added');
  });

  it('an empty override falls through to the theme', () => {
    expect(statusColor('deleted', { deleted: '' })).toContain('geet-color\\.deleted');
  });

  it('untracked wears the added icon, conflicts warn', () => {
    expect(statusIcon('untracked')).toBe('diff-added');
    expect(statusIcon('conflicted')).toBe('warning');
    expect(statusIcon('renamed')).toBe('diff-renamed');
  });

  it('a single-status directory wears that status; mixed reads as modified', () => {
    expect(dirStatusColor(new Set(['added']))).toContain('geet-color\\.added');
    expect(dirStatusColor(new Set(['added', 'deleted']))).toContain('geet-color\\.modified');
    expect(dirStatusColor(new Set())).toBeUndefined();
    expect(dirStatusColor(new Set(['deleted']), { deleted: '#333333' })).toBe('#333333');
  });
});
