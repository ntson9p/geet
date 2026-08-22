import { describe, expect, it } from 'vitest';
import { dirStatusColor, statusColor, statusIcon } from '../../../webview-ui/src/lib/status';

describe('status palette (P11-T8)', () => {
  it('defaults to the theme gitDecoration variables with a visible fallback', () => {
    expect(statusColor('added')).toBe(
      'var(--vscode-gitDecoration-addedResourceForeground, var(--vscode-foreground))',
    );
    expect(statusColor('conflicted')).toContain('gitDecoration-conflictingResourceForeground');
  });

  it('a gittree.colors override wins over the theme', () => {
    expect(statusColor('modified', { modified: '#ff8800' })).toBe('#ff8800');
    // Another status stays on the theme.
    expect(statusColor('added', { modified: '#ff8800' })).toContain('gitDecoration-added');
  });

  it('an empty override falls through to the theme', () => {
    expect(statusColor('deleted', { deleted: '' })).toContain('gitDecoration-deleted');
  });

  it('untracked wears the added icon, conflicts warn', () => {
    expect(statusIcon('untracked')).toBe('diff-added');
    expect(statusIcon('conflicted')).toBe('warning');
    expect(statusIcon('renamed')).toBe('diff-renamed');
  });

  it('a single-status directory wears that status; mixed reads as modified', () => {
    expect(dirStatusColor(new Set(['added']))).toContain('gitDecoration-added');
    expect(dirStatusColor(new Set(['added', 'deleted']))).toContain('gitDecoration-modified');
    expect(dirStatusColor(new Set())).toBeUndefined();
    expect(dirStatusColor(new Set(['deleted']), { deleted: '#333333' })).toBe('#333333');
  });
});
