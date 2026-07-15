/**
 * P10-T1: graph scroll frame time over the 100k-commit mock host. §13 asks
 * for 60 fps with canvas redraw ≤ 8 ms/frame; the observable proxy in a
 * headless browser is the rAF frame delta while continuously scrolling the
 * virtualized list — a redraw over budget shows up as missed frames. Median
 * must hold 60 fps (≤ 17.5 ms with headless jitter), p95 may miss at most one
 * frame (≤ 35 ms).
 */
import { expect, test, type Page } from '@playwright/test';
import { mockLogHostScript } from './mockLogHost';

async function openLog(page: Page): Promise<void> {
  await page.addInitScript(mockLogHostScript);
  await page.goto('/log.html');
  await expect(page.getByTestId('log-row-0')).toBeVisible();
}

test.describe('P10-T1 log scroll frame time', () => {
  test('median 60 fps while scrolling the 100k graph', async ({ page }) => {
    await openLog(page);
    const list = page.getByRole('listbox', { name: 'Commits' });
    await expect(list).toBeVisible();

    const deltas = await list.evaluate(async (el) => {
      const out: number[] = [];
      let last = performance.now();
      let frames = 0;
      await new Promise<void>((resolve) => {
        const step = (): void => {
          const now = performance.now();
          out.push(now - last);
          last = now;
          // ~12 rows/frame: a fast wheel scroll through the virtual list.
          el.scrollTop += 12 * 24;
          frames++;
          if (frames >= 120) {
            resolve();
            return;
          }
          requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
      });
      return out;
    });

    // Discard the first few frames (initial layout/hydration).
    const settled = deltas.slice(5);
    const sorted = [...settled].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)]!;
    const p95 = sorted[Math.min(sorted.length - 1, Math.ceil(0.95 * sorted.length) - 1)]!;
    console.log(`[perf] scroll frames: median ${median.toFixed(1)}ms, p95 ${p95.toFixed(1)}ms`);

    expect(median).toBeLessThanOrEqual(17.5); // 60 fps + headless timer jitter
    expect(p95).toBeLessThanOrEqual(35); // at most one missed frame at p95
  });
});
