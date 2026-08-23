import { describe, expect, it } from 'vitest';
import {
  migrateUnsetGitEnabled,
  MIGRATION_DONE_KEY,
  MODE_STATE_KEY,
  type UnsetGitEnabledDeps,
} from '../../../src/core/migrations/unsetGitEnabled';

function harness(initial: Record<string, unknown> = {}) {
  const state = new Map<string, unknown>(Object.entries(initial));
  const notices: string[] = [];
  let clears = 0;
  let failClear = false;
  const deps: UnsetGitEnabledDeps = {
    workspaceState: {
      get: <T,>(key: string) => state.get(key) as T | undefined,
      update: (key, value) => {
        if (value === undefined) state.delete(key);
        else state.set(key, value);
        return Promise.resolve();
      },
    },
    clearBuiltinGitEnabled: () => {
      clears++;
      return failClear ? Promise.reject(new Error('write failed')) : Promise.resolve();
    },
    notify: (m) => notices.push(m),
  };
  return {
    deps,
    state,
    notices,
    get clears() {
      return clears;
    },
    set failClear(v: boolean) {
      failClear = v;
    },
  };
}

describe('P14-T6 unset git.enabled migration', () => {
  it('restores a takeover workspace exactly once and explains why', async () => {
    const h = harness({ [MODE_STATE_KEY]: 'takeover' });
    expect(await migrateUnsetGitEnabled(h.deps)).toBe('restored');
    expect(h.clears).toBe(1);
    expect(h.state.get(MODE_STATE_KEY)).toBeUndefined();
    expect(h.state.get(MIGRATION_DONE_KEY)).toBe(true);
    expect(h.notices).toHaveLength(1);
    expect(h.notices[0]).toContain('git.enabled');

    // Idempotent: a second activation must not write or notify again.
    expect(await migrateUnsetGitEnabled(h.deps)).toBe('already-done');
    expect(h.clears).toBe(1);
    expect(h.notices).toHaveLength(1);
  });

  it('does nothing for a workspace that never consented', async () => {
    const h = harness();
    expect(await migrateUnsetGitEnabled(h.deps)).toBe('nothing-to-undo');
    // The whole point: never touch git.enabled for someone who did not set it.
    expect(h.clears).toBe(0);
    expect(h.notices).toEqual([]);
    expect(h.state.get(MIGRATION_DONE_KEY)).toBe(true);
  });

  it('does nothing for a companion workspace', async () => {
    const h = harness({ [MODE_STATE_KEY]: 'companion' });
    expect(await migrateUnsetGitEnabled(h.deps)).toBe('nothing-to-undo');
    expect(h.clears).toBe(0);
  });

  it('is not marked done when the settings write fails, so it retries', async () => {
    const h = harness({ [MODE_STATE_KEY]: 'takeover' });
    h.failClear = true;
    await expect(migrateUnsetGitEnabled(h.deps)).rejects.toThrow('write failed');
    // Marking it done here would leave the user disabled with no way back.
    expect(h.state.get(MIGRATION_DONE_KEY)).toBeUndefined();
    expect(h.state.get(MODE_STATE_KEY)).toBe('takeover');

    h.failClear = false;
    expect(await migrateUnsetGitEnabled(h.deps)).toBe('restored');
    expect(h.state.get(MIGRATION_DONE_KEY)).toBe(true);
  });

  it('only ever clears the override — it cannot set git.enabled to a value', async () => {
    // `clearBuiltinGitEnabled` takes no arguments by design: there is no way
    // for this module to write `true` or `false`, only to remove what GitTree
    // itself put there. Assert the contract through behaviour rather than
    // arity, so the test survives a signature tidy-up.
    const h = harness({ [MODE_STATE_KEY]: 'takeover' });
    await migrateUnsetGitEnabled(h.deps);
    expect(h.clears).toBe(1);
    expect(h.state.get(MODE_STATE_KEY)).toBeUndefined();
  });
});
