import * as path from 'node:path';
import * as fs from 'node:fs';
import Mocha from 'mocha';

export function run(): Promise<void> {
  const mocha = new Mocha({ ui: 'tdd', color: true, timeout: 60_000 });
  const only = process.env['GITTREE_TEST_ONLY'];
  if (only !== undefined && only.length > 0) mocha.grep(only);

  const testsRoot = __dirname;
  const entries = fs.readdirSync(testsRoot, { recursive: true, encoding: 'utf8' });
  for (const entry of entries.sort()) {
    if (entry.endsWith('.test.js')) {
      mocha.addFile(path.join(testsRoot, entry));
    }
  }

  return new Promise((resolve, reject) => {
    mocha.run((failures) => {
      if (failures > 0) {
        reject(new Error(`${failures} integration test(s) failed.`));
      } else {
        resolve();
      }
    });
  });
}
