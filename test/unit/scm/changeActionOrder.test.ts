/**
 * POST-QA: the keyboard change popup — Enter takes the first item, and it was
 * Rollback.
 */
import { describe, expect, it } from 'vitest';
import { CHANGE_ACTIONS } from '../../../src/scm/gutter/changeActionOrder';

describe('the change popup’s actions', () => {
  const ids = CHANGE_ACTIONS.map((a) => (a.kind === 'separator' ? '—' : a.id));

  it('starts with Stage, so Enter changes nothing on disk', () => {
    expect(ids[0]).toBe('stage');
  });

  it('keeps Rollback last, set apart by a separator', () => {
    expect(ids).toEqual(['stage', 'commitView', '—', 'rollback']);
  });

  it('names the hunk commands that take the change', () => {
    const commands = CHANGE_ACTIONS.flatMap((a) => (a.kind === 'action' ? [a.command] : []));
    expect(commands).toEqual(['gittree.hunk.stage', 'gittree.hunk.openCommitView', 'gittree.hunk.rollback']);
  });
});
