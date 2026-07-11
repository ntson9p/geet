import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  timeout: 30_000,
  fullyParallel: true,
  retries: process.env.CI ? 1 : 0,
  use: {
    baseURL: 'http://127.0.0.1:5173',
    trace: 'on',
    viewport: { width: 1024, height: 768 },
  },
  webServer: {
    command: 'npm run dev',
    url: 'http://127.0.0.1:5173/demo.html',
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
