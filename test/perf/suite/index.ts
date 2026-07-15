import * as path from 'node:path';
import * as fs from 'node:fs';
import Mocha from 'mocha';

export function run(): Promise<void> {
  // Benchmarks run medians of 5 over expensive fixtures — generous timeout.
  const mocha = new Mocha({ ui: 'tdd', color: true, timeout: 600_000 });

  const testsRoot = __dirname;
  const entries = fs.readdirSync(testsRoot, { recursive: true, encoding: 'utf8' });
  for (const entry of entries.sort()) {
    if (entry.endsWith('.perf.test.js')) {
      mocha.addFile(path.join(testsRoot, entry));
    }
  }

  return new Promise((resolve, reject) => {
    mocha.run((failures) => {
      if (failures > 0) {
        reject(new Error(`${failures} perf benchmark(s) failed.`));
      } else {
        resolve();
      }
    });
  });
}
