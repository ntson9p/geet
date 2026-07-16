/** P10-T3: the per-minor "What's new" gate. */
import { describe, expect, it } from 'vitest';
import { whatsNewDecision } from '../../../src/onboarding/whatsNewGate';

describe('whatsNewDecision', () => {
  it('fresh install: records the minor without showing', () => {
    expect(whatsNewDecision(undefined, '0.2.1')).toEqual({ minor: '0.2', show: false });
  });

  it('same minor (patch bumps included): silent', () => {
    expect(whatsNewDecision('0.2', '0.2.0')).toEqual({ minor: '0.2', show: false });
    expect(whatsNewDecision('0.2', '0.2.9')).toEqual({ minor: '0.2', show: false });
  });

  it('minor bump: shows once', () => {
    expect(whatsNewDecision('0.2', '0.3.0')).toEqual({ minor: '0.3', show: true });
  });

  it('major bump: shows too', () => {
    expect(whatsNewDecision('0.9', '1.0.0')).toEqual({ minor: '1.0', show: true });
  });

  it('downgrade: still just compares minors', () => {
    expect(whatsNewDecision('1.1', '1.0.5')).toEqual({ minor: '1.0', show: true });
  });
});
