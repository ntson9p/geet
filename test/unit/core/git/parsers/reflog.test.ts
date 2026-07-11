import { describe, expect, it } from 'vitest';
import { parseCheckoutEvents, parseReflog } from '../../../../../src/core/git/parsers/reflog';
import { fixture } from './fixtures';

describe('reflog parsers (captured fixture)', () => {
  const raw = fixture('reflog-checkouts.bin');

  it('parses all reflog entries', () => {
    const entries = parseReflog(raw);
    expect(entries.length).toBe(7);
    expect(entries.every((e) => e.time > 1_700_000_000)).toBe(true);
    expect(entries[entries.length - 1]!.subject).toBe('commit (initial): base');
  });

  it('extracts only checkout events, newest first', () => {
    const events = parseCheckoutEvents(raw);
    expect(events).toHaveLength(4);
    expect(events[0]).toMatchObject({ from: 'feature/one', to: 'main' });
    expect(events[1]).toMatchObject({ from: 'main', to: 'feature/one' });
    // reset/commit entries are filtered out
    expect(events.every((e) => e.to === 'main' || e.to === 'feature/one')).toBe(true);
  });

  it('handles detached-HEAD checkout subjects (synthetic)', () => {
    const out = '1767323045\0checkout: moving from main to 6d93daf906024dea7ada173b685b437088fc686e\x1e\n';
    const [e] = parseCheckoutEvents(out);
    expect(e?.from).toBe('main');
    expect(e?.to).toBe('6d93daf906024dea7ada173b685b437088fc686e');
  });

  it('handles branch names containing " to " in the from side (synthetic)', () => {
    const out = '1767323045\0checkout: moving from how to do it to main\x1e\n';
    const [e] = parseCheckoutEvents(out);
    expect(e?.from).toBe('how to do it');
    expect(e?.to).toBe('main');
  });
});
