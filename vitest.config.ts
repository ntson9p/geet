import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/unit/**/*.test.ts'],
    // P0-T1 lands before the first parser suites (P0-T2/T3); keep the gate
    // green until then.
    passWithNoTests: true,
  },
});
