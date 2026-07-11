import * as fs from 'node:fs';
import * as path from 'node:path';

/** Reads a captured git-output fixture (see test/unit/fixtures/git/capture.mjs). */
export function fixture(name: string): string {
  return fs.readFileSync(path.join(process.cwd(), 'test/unit/fixtures/git', name), 'utf8');
}
