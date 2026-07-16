/** P10-T4: the telemetry schema gate — content-free by construction. */
import { describe, expect, it } from 'vitest';
import {
  durationBucket,
  sanitizeEvent,
  Telemetry,
  TELEMETRY_SCHEMA,
  type TelemetryEventName,
} from '../../../src/core/telemetry';

function collector(): { events: { name: string; props: Record<string, string> }[]; sender: { send: (n: TelemetryEventName, p: Record<string, string>) => void } } {
  const events: { name: string; props: Record<string, string> }[] = [];
  return { events, sender: { send: (name, props) => void events.push({ name, props }) } };
}

describe('sanitizeEvent (allowlist serializer)', () => {
  it('drops unknown events entirely', () => {
    expect(sanitizeEvent('totally.made.up', { kind: 'auth' })).toBeUndefined();
  });

  it('strips keys outside the event schema', () => {
    const clean = sanitizeEvent('op.errorKind', {
      kind: 'auth',
      repoPath: 'C:/secret/repo',
      message: 'fatal: something private',
    });
    expect(clean).toEqual({ name: 'op.errorKind', props: { kind: 'auth' } });
  });

  it('rejects string values that are not short slugs — paths, shas, messages', () => {
    for (const leak of [
      'C:\\Users\\alice\\repo',
      '/home/alice/repo',
      'fix the login bug',
      '0123456789abcdef0123456789abcdef01234567',
      'UPPERCASE',
      'a'.repeat(40),
    ]) {
      const clean = sanitizeEvent('feature.firstUse', { feature: leak });
      expect(clean?.props['feature'], leak).toBeUndefined();
    }
  });

  it('accepts slugs, numbers and booleans', () => {
    expect(sanitizeEvent('op.duration', { bucket: 'lt400ms', destructive: true })).toEqual({
      name: 'op.duration',
      props: { bucket: 'lt400ms', destructive: 'true' },
    });
    expect(sanitizeEvent('activation', { syncBucket: 'lt100ms' })?.props).toEqual({
      syncBucket: 'lt100ms',
    });
  });

  it('every schema value is itself a valid slug list', () => {
    for (const keys of Object.values(TELEMETRY_SCHEMA)) {
      for (const k of keys) expect(k).toMatch(/^[a-zA-Z]+$/);
    }
  });
});

describe('durationBucket', () => {
  it('buckets coarsely', () => {
    expect(durationBucket(0)).toBe('lt100ms');
    expect(durationBucket(99)).toBe('lt100ms');
    expect(durationBucket(100)).toBe('lt400ms');
    expect(durationBucket(999)).toBe('lt1s');
    expect(durationBucket(4999)).toBe('lt5s');
    expect(durationBucket(60_000)).toBe('ge5s');
  });
});

describe('Telemetry gates', () => {
  it('sends only when BOTH the env and the setting allow', () => {
    const { events, sender } = collector();
    let env = false;
    let setting = false;
    const t = new Telemetry({ envEnabled: () => env, settingEnabled: () => setting, sender });

    expect(t.event('activation', { syncBucket: 'lt100ms' })).toBe(false);
    env = true;
    expect(t.event('activation', { syncBucket: 'lt100ms' })).toBe(false);
    setting = true;
    expect(t.event('activation', { syncBucket: 'lt100ms' })).toBe(true);
    env = false;
    expect(t.event('activation', { syncBucket: 'lt100ms' })).toBe(false);
    expect(events).toHaveLength(1);
  });

  it('featureFirstUse dedupes per session', () => {
    const { events, sender } = collector();
    const t = new Telemetry({ envEnabled: () => true, settingEnabled: () => true, sender });
    expect(t.featureFirstUse('playground')).toBe(true);
    expect(t.featureFirstUse('playground')).toBe(false);
    expect(events).toHaveLength(1);
  });
});
