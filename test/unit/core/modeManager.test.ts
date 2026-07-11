import { describe, expect, it } from 'vitest';
import {
  ModeManager,
  type ConsentChoice,
  type GitTreeMode,
  type ModeManagerDeps,
} from '../../../src/core/modeManager';

interface Harness {
  mm: ModeManager;
  writes: Array<boolean | undefined>;
  persisted: () => Exclude<GitTreeMode, 'unset'> | undefined;
  dialogCalls: () => number;
  fired: GitTreeMode[];
}

function harness(opts: {
  persisted?: Exclude<GitTreeMode, 'unset'>;
  settingOverride?: Exclude<GitTreeMode, 'unset'>;
  dialogAnswer?: ConsentChoice;
} = {}): Harness {
  let persisted = opts.persisted;
  let dialogCalls = 0;
  const writes: Array<boolean | undefined> = [];
  const deps: ModeManagerDeps = {
    getPersisted: () => persisted,
    persist: (m) => {
      persisted = m;
    },
    getSettingOverride: () => opts.settingOverride,
    showConsentDialog: () => {
      dialogCalls++;
      return Promise.resolve(opts.dialogAnswer ?? 'later');
    },
    setBuiltinGitEnabled: (enabled) => {
      writes.push(enabled);
      return Promise.resolve();
    },
  };
  const mm = new ModeManager(deps);
  const fired: GitTreeMode[] = [];
  mm.onDidChangeMode((m) => fired.push(m));
  return { mm, writes, persisted: () => persisted, dialogCalls: () => dialogCalls, fired };
}

describe('ModeManager consent flow', () => {
  it('starts unset with companion behavior', () => {
    const { mm } = harness();
    expect(mm.mode).toBe('unset');
    expect(mm.effectiveMode).toBe('companion');
  });

  it('accepting takeover writes git.enabled=false, persists, fires', async () => {
    const h = harness({ dialogAnswer: 'takeover' });
    await h.mm.ensurePrompted();
    expect(h.writes).toEqual([false]);
    expect(h.persisted()).toBe('takeover');
    expect(h.mm.mode).toBe('takeover');
    expect(h.mm.effectiveMode).toBe('takeover');
    expect(h.fired).toEqual(['takeover']);
  });

  it('declining ("Keep both") never touches git.enabled and persists companion', async () => {
    const h = harness({ dialogAnswer: 'companion' });
    await h.mm.ensurePrompted();
    expect(h.writes).toEqual([]); // built-in untouched
    expect(h.persisted()).toBe('companion');
    expect(h.mm.mode).toBe('companion');
  });

  it('"later" performs no writes, stays unset, does not re-prompt this session', async () => {
    const h = harness({ dialogAnswer: 'later' });
    await h.mm.ensurePrompted();
    await h.mm.ensurePrompted();
    expect(h.dialogCalls()).toBe(1);
    expect(h.writes).toEqual([]);
    expect(h.persisted()).toBeUndefined();
    expect(h.mm.mode).toBe('unset');
  });

  it('a persisted decision short-circuits the prompt', async () => {
    const h = harness({ persisted: 'companion', dialogAnswer: 'takeover' });
    await h.mm.ensurePrompted();
    expect(h.dialogCalls()).toBe(0);
    expect(h.mm.mode).toBe('companion');
  });

  it('an explicit setting override wins over persisted state', () => {
    const h = harness({ persisted: 'companion', settingOverride: 'takeover' });
    expect(h.mm.mode).toBe('takeover');
  });

  it('leaving takeover restores git.enabled (removes the override)', async () => {
    const h = harness({ persisted: 'takeover' });
    await h.mm.adopt('companion');
    expect(h.writes).toEqual([undefined]);
    expect(h.persisted()).toBe('companion');
    expect(h.fired).toEqual(['companion']);
  });

  it('does not persist takeover when the git.enabled write fails', async () => {
    let persisted: Exclude<GitTreeMode, 'unset'> | undefined;
    const mm = new ModeManager({
      getPersisted: () => persisted,
      persist: (m) => {
        persisted = m;
      },
      getSettingOverride: () => undefined,
      showConsentDialog: () => Promise.resolve('takeover'),
      setBuiltinGitEnabled: () => Promise.reject(new Error('settings write failed')),
    });
    await expect(mm.ensurePrompted()).rejects.toThrow('settings write failed');
    expect(persisted).toBeUndefined();
    expect(mm.mode).toBe('unset');
  });

  it('refreshFromSetting applies explicit config edits as consent', async () => {
    let override: Exclude<GitTreeMode, 'unset'> | undefined;
    const writes: Array<boolean | undefined> = [];
    let persisted: Exclude<GitTreeMode, 'unset'> | undefined;
    const mm = new ModeManager({
      getPersisted: () => persisted,
      persist: (m) => {
        persisted = m;
      },
      getSettingOverride: () => override,
      showConsentDialog: () => Promise.resolve('later'),
      setBuiltinGitEnabled: (e) => {
        writes.push(e);
        return Promise.resolve();
      },
    });
    override = 'takeover';
    await mm.refreshFromSetting();
    expect(mm.mode).toBe('takeover');
    expect(writes).toEqual([false]);
    override = 'companion';
    await mm.refreshFromSetting();
    expect(mm.mode).toBe('companion');
    expect(writes).toEqual([false, undefined]);
  });
});
