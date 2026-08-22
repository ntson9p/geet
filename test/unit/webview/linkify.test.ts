import { describe, expect, it } from 'vitest';
import { linkifyBody, signatureLabel } from '../../../webview-ui/src/log/linkify';

describe('linkifyBody (P12-T4)', () => {
  it('links URLs and leaves surrounding text intact', () => {
    const out = linkifyBody('see https://x.dev/a?b=1 for more');
    expect(out).toEqual([
      { text: 'see ' },
      { text: 'https://x.dev/a?b=1', href: 'https://x.dev/a?b=1' },
      { text: ' for more' },
    ]);
  });

  it('links configured issue keys through the URL template', () => {
    const out = linkifyBody('fixes GT-42 properly', {
      pattern: 'GT-\\d+',
      url: 'https://t.example/browse/$0',
    });
    expect(out).toEqual([
      { text: 'fixes ' },
      { text: 'GT-42', href: 'https://t.example/browse/GT-42' },
      { text: ' properly' },
    ]);
  });

  it('a URL wins over an overlapping issue match', () => {
    const out = linkifyBody('https://t.example/GT-42', {
      pattern: 'GT-\\d+',
      url: 'https://t.example/browse/$0',
    });
    expect(out).toEqual([
      { text: 'https://t.example/GT-42', href: 'https://t.example/GT-42' },
    ]);
  });

  it('an invalid user pattern disables issues but keeps URLs', () => {
    const out = linkifyBody('GT-1 https://x.dev', { pattern: '[', url: 'x/$0' });
    expect(out.map((s) => s.href)).toEqual([undefined, 'https://x.dev']);
  });

  it('plain text yields one unlinked segment; empty yields none', () => {
    expect(linkifyBody('no links here')).toEqual([{ text: 'no links here' }]);
    expect(linkifyBody('')).toEqual([]);
  });
});

describe('signatureLabel (P12-T4)', () => {
  it('maps the %G? letters IntelliJ-style', () => {
    expect(signatureLabel('G')).toBe('Good signature');
    expect(signatureLabel('B')).toBe('BAD signature');
    expect(signatureLabel('U')).toBe('Signature: unverified');
    expect(signatureLabel('E')).toBe('Signature: cannot be checked');
    expect(signatureLabel('N')).toBeUndefined();
    expect(signatureLabel(undefined)).toBeUndefined();
  });
});
