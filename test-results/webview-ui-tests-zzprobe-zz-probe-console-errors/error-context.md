# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: webview-ui\tests\zzprobe.spec.ts >> zz probe console errors
- Location: webview-ui\tests\zzprobe.spec.ts:4:1

# Error details

```
Error: page.goto: Protocol error (Page.navigate): Cannot navigate to invalid URL
Call log:
  - navigating to "/demo.html", waiting until "load"

```

# Test source

```ts
  1  | import { test } from '@playwright/test';
  2  | import { mockVsCodeApiScript } from './mockVsCode';
  3  | 
  4  | test('zz probe console errors', async ({ page }) => {
  5  |   const errors: string[] = [];
  6  |   page.on('console', (msg) => {
  7  |     if (msg.type() === 'error') errors.push(msg.text());
  8  |   });
  9  |   page.on('pageerror', (err) => errors.push(`PAGEERROR: ${err.message}`));
  10 |   await page.addInitScript(mockVsCodeApiScript);
> 11 |   await page.goto('/demo.html');
     |              ^ Error: page.goto: Protocol error (Page.navigate): Cannot navigate to invalid URL
  12 |   await page.waitForTimeout(2500);
  13 |   console.log('CONSOLE ERRORS:\n' + errors.join('\n---\n'));
  14 | });
  15 | 
```