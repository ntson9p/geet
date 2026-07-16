/** P10-T5: release-notes extraction + the shipped changelog stays parseable. */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { extractChangelog } from '../../../scripts/extractChangelog.mjs';

const root = path.resolve(__dirname, '../../..');

const SAMPLE = `# Changelog

intro text

## [0.2.0] — 2026-08-01

### Added
- thing two

## [0.0.1] — 2026-07-16

### Added
- thing one
`;

describe('extractChangelog', () => {
  it('returns exactly one version section', () => {
    const s = extractChangelog(SAMPLE, '0.2.0');
    expect(s).toContain('## [0.2.0]');
    expect(s).toContain('thing two');
    expect(s).not.toContain('thing one');
  });

  it('handles the last section and missing versions', () => {
    expect(extractChangelog(SAMPLE, '0.0.1')).toContain('thing one');
    expect(extractChangelog(SAMPLE, '9.9.9')).toBeUndefined();
  });

  it('the shipped CHANGELOG.md has a section for the current package version', () => {
    const version = (
      JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as { version: string }
    ).version;
    const changelog = readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
    const section = extractChangelog(changelog, version);
    expect(section, `CHANGELOG.md must document [${version}]`).toBeTypeOf('string');
  });
});
