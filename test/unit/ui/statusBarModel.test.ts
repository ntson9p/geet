import { describe, expect, it } from 'vitest';
import { EMPTY_SNAPSHOT, type RepoSnapshot } from '../../../src/core/model/repositoryModel';
import type { StatusEntry } from '../../../src/core/model/statusEntry';
import {
  conflictCount,
  formatCount,
  opLabel,
  renderStatusBarText,
  resolveStatusBarMode,
} from '../../../src/ui/statusBarModel';

/**
 * POST-P14r, branded by POST-P14t. These cover two separate properties.
 *
 * **Cost.** The widget rendered `$(arrow-down) 26050 $(arrow-up) 10893` the
 * moment a fetch told it how far behind it was. Most of these tests are about
 * what the widget is *allowed to cost*. (That was not, as POST-P14r believed,
 * why the button disappeared — a shared `StatusBarItem` id was, fixed in
 * POST-P14s. The caps are still right; the diagnosis was not.)
 *
 * **Identity.** The compact button used VS Code's own `$(git-branch)` glyph,
 * unlabelled, beside VS Code's own branch widget — so it read as a duplicate
 * of that widget instead of as Geet.
 */

const snap = (over: Partial<RepoSnapshot> = {}): RepoSnapshot => ({
  ...EMPTY_SNAPSHOT,
  headRef: 'develop',
  ...over,
});

const unmerged = (path: string): StatusEntry =>
  ({ kind: 'unmerged', path }) as unknown as StatusEntry;

describe('resolveStatusBarMode', () => {
  it('auto defers to the built-in Git widget when there is one', () => {
    expect(resolveStatusBarMode('auto', true)).toBe('button');
  });

  it('auto takes over the readout when nothing else is drawing one', () => {
    expect(resolveStatusBarMode('auto', false)).toBe('full');
  });

  it('an explicit choice is never second-guessed', () => {
    // The point of the setting is the user overruling our detection, which
    // cannot see an entry hidden from the status bar's own context menu.
    for (const present of [true, false]) {
      expect(resolveStatusBarMode('button', present)).toBe('button');
      expect(resolveStatusBarMode('full', present)).toBe('full');
      expect(resolveStatusBarMode('off', present)).toBe('off');
    }
  });
});

describe('formatCount', () => {
  it('caps at 99+, as IntelliJ does', () => {
    expect(formatCount(0)).toBe('0');
    expect(formatCount(99)).toBe('99');
    expect(formatCount(100)).toBe('99+');
    expect(formatCount(26050)).toBe('99+');
  });
});

describe('renderStatusBarText — button mode', () => {
  it('is one constant-width affordance, whatever the repository is doing', () => {
    const clean = renderStatusBarText(snap(), false, 'button');
    const diverged = renderStatusBarText(
      snap({ behind: 26050, ahead: 10893, upstream: 'origin/develop' }),
      false,
      'button',
    );
    const detached = renderStatusBarText(
      snap({ detached: true, headSha: 'abcdef1234' }),
      false,
      'button',
    );
    expect(clean).toBe('$(list-tree) Geet $(chevron-down)');
    expect(diverged).toBe(clean);
    expect(detached).toBe(clean);
  });

  it('shows a fetch without changing size', () => {
    const idle = renderStatusBarText(snap(), false, 'button');
    const fetching = renderStatusBarText(snap(), true, 'button');
    // Only the mark swaps. The label and the chevron hold their position, so
    // there is no reflow at all — which is what makes the spinner look smooth.
    expect(fetching).toBe('$(sync~spin) Geet $(chevron-down)');
    // Same glyph count: one icon plus the chevron.
    expect(fetching.match(/\$\(/gu)?.length).toBe(idle.match(/\$\(/gu)?.length);
    expect(fetching).toContain(' Geet ');
    expect(fetching).toContain('$(chevron-down)');
  });

  /**
   * POST-P14t. The button was `$(git-branch)$(chevron-down)` — VS Code's own
   * branch glyph, unlabelled, two entries from VS Code's own branch widget. It
   * read as a duplicate of that widget rather than as Geet, and gave someone
   * who had just installed the extension nothing to aim at.
   */
  it('says whose button it is, in the product name and not a git glyph', () => {
    const text = renderStatusBarText(snap(), false, 'button');
    expect(text).toContain('Geet');
    // The mark must not be one of the glyphs already in this strip — ours was
    // literally the same codicon as the widget beside it.
    expect(text).not.toContain('$(git-branch)');
    expect(text).not.toContain('$(source-control)');
    // Still a menu opener, which is the whole claim the chevron makes.
    expect(text.endsWith('$(chevron-down)')).toBe(true);
  });

  it('carries no branch name or counts — VS Code is already showing those', () => {
    const text = renderStatusBarText(
      snap({ headRef: 'feature/very-long-branch-name', behind: 238 }),
      false,
      'button',
    );
    expect(text).not.toContain('feature');
    expect(text).not.toContain('238');
  });
});

describe('renderStatusBarText — the growth rule', () => {
  it('grows for an in-progress operation, in both modes', () => {
    const s = snap({ inProgressOp: { kind: 'rebase-apply', step: 2, total: 5 } as never });
    expect(renderStatusBarText(s, false, 'button')).toBe(
      '$(list-tree) Geet $(chevron-down) $(warning) REBASING 2/5',
    );
    expect(renderStatusBarText(s, false, 'full')).toContain('$(warning) REBASING 2/5');
  });

  it('grows for conflicts, and caps that count too', () => {
    const many = snap({ statusEntries: Array.from({ length: 400 }, (_, i) => unmerged(`f${i}`)) });
    expect(renderStatusBarText(many, false, 'button')).toBe(
      '$(list-tree) Geet $(chevron-down) $(error) 99+',
    );
  });

  it('grows for nothing else', () => {
    // Dirty, diverged, detached, no upstream: none of it earns a pixel,
    // because the built-in Git widget already reports all of it.
    const noisy = snap({
      detached: true,
      headSha: 'abcdef1',
      behind: 9999,
      ahead: 9999,
      upstreamGone: true,
      statusEntries: [{ kind: 'modified', path: 'a.ts' } as unknown as StatusEntry],
    });
    expect(renderStatusBarText(noisy, false, 'button')).toBe('$(list-tree) Geet $(chevron-down)');
  });
});

describe('renderStatusBarText — full mode', () => {
  it('names the branch, and the sha when detached', () => {
    expect(renderStatusBarText(snap(), false, 'full')).toBe('$(git-branch) develop');
    expect(
      renderStatusBarText(snap({ detached: true, headSha: 'abcdef1234567' }), false, 'full'),
    ).toBe('$(git-commit) abcdef1');
  });

  it('bounds the divergence counts — the defect that started this', () => {
    const text = renderStatusBarText(
      snap({ behind: 26050, ahead: 10893, upstream: 'origin/develop' }),
      false,
      'full',
    );
    expect(text).toBe('$(git-branch) develop $(arrow-down) 99+ $(arrow-up) 99+');
    expect(text).not.toContain('26050');
    // The old unbounded form was 38 characters; anything near that is a
    // regression of the bug, not a style preference.
    expect(text.length).toBeLessThan(56);
  });

  it('omits a zero side rather than printing it', () => {
    expect(renderStatusBarText(snap({ behind: 12, ahead: 0 }), false, 'full')).toBe(
      '$(git-branch) develop $(arrow-down) 12',
    );
    expect(renderStatusBarText(snap({ behind: 0, ahead: 16 }), false, 'full')).toBe(
      '$(git-branch) develop $(arrow-up) 16',
    );
    expect(renderStatusBarText(snap({ behind: 0, ahead: 0 }), false, 'full')).toBe(
      '$(git-branch) develop',
    );
  });

  it('caps a large one-sided count too — 238 behind is the reporter’s own case', () => {
    expect(renderStatusBarText(snap({ behind: 238, ahead: 0 }), false, 'full')).toBe(
      '$(git-branch) develop $(arrow-down) 99+',
    );
  });

  it('replaces the counts with a spinner while fetching', () => {
    const text = renderStatusBarText(snap({ behind: 238 }), true, 'full');
    expect(text).toBe('$(git-branch) develop $(sync~spin)');
    expect(text).not.toContain('arrow-down');
  });
});

describe('renderStatusBarText — off', () => {
  it('contributes nothing, even mid-rebase', () => {
    const s = snap({
      inProgressOp: { kind: 'rebase-apply', step: 1, total: 2 } as never,
      statusEntries: [unmerged('a.ts')],
    });
    expect(renderStatusBarText(s, false, 'off')).toBe('');
  });
});

describe('opLabel / conflictCount', () => {
  it('names each operation, with steps when git reports them', () => {
    expect(opLabel(snap())).toBeUndefined();
    expect(opLabel(snap({ inProgressOp: { kind: 'merge' } as never }))).toBe('MERGING');
    expect(opLabel(snap({ inProgressOp: { kind: 'cherry-pick' } as never }))).toBe(
      'CHERRY-PICKING',
    );
    expect(opLabel(snap({ inProgressOp: { kind: 'revert' } as never }))).toBe('REVERTING');
    expect(
      opLabel(snap({ inProgressOp: { kind: 'rebase-interactive', step: 3, total: 9 } as never })),
    ).toBe('REBASING 3/9');
  });

  it('counts only unmerged entries', () => {
    expect(
      conflictCount(
        snap({
          statusEntries: [
            unmerged('a.ts'),
            { kind: 'modified', path: 'b.ts' } as unknown as StatusEntry,
            unmerged('c.ts'),
          ],
        }),
      ),
    ).toBe(2);
  });
});
