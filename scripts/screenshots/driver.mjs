/**
 * What the scenes (scenes.mjs) do to the scratch VS Code: run a command from
 * the Command Palette, answer a quick pick or an input box, find a GitTree
 * webview, size the side bar and the panel, run git in a demo repository, and
 * save an image.
 *
 * Clicks inside webviews go to the frame's elements; layout-sensitive clicks
 * use the raw mouse at coordinates read from the frame, because
 * `locator.click()` first scrolls its element into view, which can nudge a
 * whole webview by a pixel (docs/screenshots.md).
 */
import fs from 'node:fs';
import path from 'node:path';
import { git } from './demo.mjs';
import { capture, sleep } from './vscode.mjs';

/**
 * @param {{ page: import('@playwright/test').Page, cdp: import('@playwright/test').CDPSession,
 *   demo: ReturnType<typeof import('./demo.mjs').buildDemo>, outDir: string, log: (...a: unknown[]) => void }} o
 */
export function createDriver(o) {
  const { page, cdp, demo, log } = o;
  const quickInput = page.locator('.quick-input-widget .monaco-inputbox input').first();

  /** Polls `fn` until it returns something truthy, or `timeout` runs out (then undefined). */
  const waitFor = async (fn, timeout = 20000, every = 150) => {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      try {
        const v = await fn();
        if (v) return v;
      } catch {
        // Not yet.
      }
      await sleep(every);
    }
    return undefined;
  };

  /** VS Code's first-run overlay ("Welcome to VS Code…") takes every click until it is closed. */
  const dismissOverlays = async () => {
    const overlay = page.locator('.onboarding-a-overlay.visible');
    for (let i = 0; i < 20 && (await overlay.count()) > 0; i++) {
      await page.keyboard.press('Escape');
      await sleep(500);
    }
  };

  const openQuickInput = async () => {
    await dismissOverlays();
    for (let attempt = 0; attempt < 5; attempt++) {
      // A click on the status bar's empty middle gives the window the keyboard without touching a view.
      const bar = await page.locator('.part.statusbar').boundingBox();
      if (bar) await page.mouse.click(bar.x + bar.width / 2, bar.y + bar.height / 2);
      await sleep(200);
      await page.keyboard.press(attempt % 2 === 0 ? 'F1' : 'Control+Shift+P');
      try {
        await quickInput.waitFor({ state: 'visible', timeout: 3000 });
        return;
      } catch {
        log('the Command Palette did not open; again');
      }
    }
    throw new Error('the Command Palette did not open');
  };

  /** Labels of the rows the quick input shows now. */
  const quickRows = () =>
    page.locator('.quick-input-list .monaco-list-row').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label') ?? ''));

  /** Types `text` into the quick input that is open and waits for the list to follow. */
  const typeQuick = async (text) => {
    await quickInput.click();
    await waitFor(() => page.evaluate(() => document.activeElement?.closest('.quick-input-widget') != null), 5000);
    await quickInput.fill(text);
    await waitFor(async () => (await quickInput.inputValue()) === text, 3000);
    await sleep(600);
  };

  /** Picks the row whose label is `label` (or starts with `label,`) in the open quick input. */
  const pick = async (label) => {
    const rows = page.locator('.quick-input-list .monaco-list-row');
    const at = await waitFor(async () => {
      const labels = await quickRows();
      const i = labels.findIndex((l) => l === label || l.startsWith(`${label},`));
      return i === -1 ? undefined : i + 1;
    }, 5000);
    if (at === undefined) {
      const labels = await quickRows();
      await page.keyboard.press('Escape');
      throw new Error(`no "${label}" in the quick pick: ${JSON.stringify(labels.slice(0, 10))}`);
    }
    await rows.nth(at - 1).click();
  };

  return {
    page,
    cdp,
    demo,
    log,
    waitFor,
    sleep,
    dismissOverlays,

    /** Runs a command by its palette label, such as `GitTree: Focus on Commit View`. */
    async command(label) {
      await openQuickInput();
      await typeQuick(`>${label}`);
      await pick(label);
      await sleep(400);
    },

    /** Answers the quick pick that is open by its row's label. */
    async pick(label) {
      await quickInput.waitFor({ state: 'visible', timeout: 10000 });
      await pick(label);
      await sleep(300);
    },

    /** Answers the input box that is open with `text` (an empty answer is just Enter). */
    async answer(text) {
      await quickInput.waitFor({ state: 'visible', timeout: 10000 });
      if (text === '') {
        await quickInput.click();
        await quickInput.fill('');
      } else {
        await typeQuick(text);
      }
      await page.keyboard.press('Enter');
      await sleep(500);
    },

    /** Expands or collapses a side bar view by its header's title (`Repositories`, `Branches`, …). */
    async setViewExpanded(title, expanded) {
      const header = page.locator('.part.sidebar .pane-header', {
        has: page.locator('.title', { hasText: new RegExp(`^${title}$`, 'u') }),
      });
      await header.first().waitFor({ timeout: 10000 });
      if ((await header.first().getAttribute('aria-expanded')) !== String(expanded)) {
        await header.first().click({ position: { x: 40, y: 10 } });
        await sleep(500);
      }
    },

    /** Whether a part of the workbench is showing: `.part.sidebar`, `.part.panel`, `.part.auxiliarybar`. */
    async isShown(selector) {
      return page.locator(selector).first().evaluate((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
      }).catch(() => false);
    },

    /** Draws the window at `v` CSS pixels from now on (twice the pixels in the images). */
    async viewport(v) {
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: v.width,
        height: v.height,
        deviceScaleFactor: v.scale ?? 2,
        mobile: false,
        screenWidth: v.width,
        screenHeight: v.height,
      });
      await sleep(800);
    },

    /** Presses keys in the window. */
    async keys(...keys) {
      for (const k of keys) {
        await page.keyboard.press(k);
        await sleep(120);
      }
    },

    /** The webview frame holding `selector`. */
    async frame(selector, timeout = 30000) {
      const found = await waitFor(async () => {
        for (const f of page.frames()) {
          if (f === page.mainFrame()) continue;
          try {
            if ((await f.locator(selector).count()) > 0) return f;
          } catch {
            // Detached while looking.
          }
        }
        return undefined;
      }, timeout);
      if (!found) throw new Error(`no webview shows ${selector}`);
      return found;
    },

    /** Where a frame's element is, in the window's CSS pixels. */
    async boxIn(frame, locator) {
      const outer = await (await frame.frameElement()).boundingBox();
      const inner = await locator.boundingBox();
      if (!outer || !inner) throw new Error('no box');
      return { x: inner.x, y: inner.y, width: inner.width, height: inner.height, frame: outer };
    },

    /**
     * Clicks a locator with the raw mouse (no scrolling into view), at its middle or at `dx`/`dy`
     * from its corner. `page.mouse` has no modifiers: they are held on the keyboard around the click.
     *
     * @param {import('@playwright/test').Locator} locator
     * @param {{ dx?: number, dy?: number, button?: 'left' | 'right', modifiers?: string[], settle?: number }} [opts]
     */
    async clickRaw(locator, opts = {}) {
      const box = await locator.boundingBox();
      if (!box) throw new Error('nothing to click');
      for (const key of opts.modifiers ?? []) await page.keyboard.down(key);
      await page.mouse.click(box.x + (opts.dx ?? box.width / 2), box.y + (opts.dy ?? box.height / 2), {
        button: opts.button ?? 'left',
      });
      for (const key of [...(opts.modifiers ?? [])].reverse()) await page.keyboard.up(key);
      await sleep(opts.settle ?? 300);
    },

    /** Clicks an item of VS Code's own context menu (drawn in the page with `window.menuStyle: custom`). */
    async contextMenuItem(label) {
      const item = page.locator('.context-view .monaco-menu .action-item:visible .action-label', { hasText: label }).first();
      await item.waitFor({ state: 'visible', timeout: 8000 });
      const labels = await page
        .locator('.context-view .monaco-menu .action-item:visible .action-label')
        .evaluateAll((els) => els.map((e) => (e.textContent ?? '').trim()));
      const at = labels.findIndex((l) => l === label);
      if (at === -1) throw new Error(`no "${label}" in the context menu: ${JSON.stringify(labels)}`);
      await page.locator('.context-view .monaco-menu .action-item:visible .action-label').nth(at).click();
      await sleep(400);
    },

    /**
     * Drags a sash: the side bar's right edge to `x`, or the panel's top edge to `y`.
     *
     * @param {'sidebar' | 'panel'} which
     * @param {number} to the edge's new position in CSS pixels
     */
    async dragEdge(which, to) {
      const part = which === 'sidebar' ? '.part.sidebar' : '.part.panel';
      const box = await page.locator(part).boundingBox();
      if (!box) throw new Error(`no ${which}`);
      const from = which === 'sidebar' ? { x: box.x + box.width, y: box.y + box.height / 2 } : { x: box.x + box.width / 2, y: box.y };
      const sash = await page
        .locator(which === 'sidebar' ? '.monaco-sash.vertical' : '.monaco-sash.horizontal')
        .evaluateAll(
          (els, p) =>
            els
              .map((e) => e.getBoundingClientRect())
              .filter((r) => r.width > 0 && r.height > 0)
              .filter((r) =>
                p.which === 'sidebar'
                  ? Math.abs(r.left + r.width / 2 - p.x) < 8 && p.y >= r.top && p.y <= r.bottom
                  : Math.abs(r.top + r.height / 2 - p.y) < 8 && p.x >= r.left && p.x <= r.right,
              )
              .map((r) => ({ x: r.left + r.width / 2, y: r.top + r.height / 2 }))[0] ?? null,
          { which, ...from },
        );
      if (!sash) throw new Error(`no sash on the ${which}'s edge`);
      const target = which === 'sidebar' ? { x: to, y: sash.y } : { x: sash.x, y: to };
      await page.mouse.move(sash.x, sash.y);
      await page.mouse.down();
      await page.mouse.move((sash.x + target.x) / 2, (sash.y + target.y) / 2, { steps: 5 });
      await page.mouse.move(target.x, target.y, { steps: 5 });
      await page.mouse.up();
      await sleep(600);
    },

    /**
     * Drags the top edge of a side bar view (found by its header's title) to `toY`, which
     * resizes it and the view above it.
     */
    async dragViewEdge(title, toY) {
      const header = page.locator('.part.sidebar .pane-header', {
        has: page.locator('.title', { hasText: new RegExp(`^${title}$`, 'u') }),
      });
      const top = (await header.first().boundingBox())?.y;
      if (top === undefined) throw new Error(`no ${title} view`);
      const sash = await page.locator('.part.sidebar .monaco-sash.horizontal').evaluateAll(
        (els, y) =>
          els
            .map((e) => e.getBoundingClientRect())
            .filter((r) => r.width > 0 && r.height > 0 && Math.abs(r.top + r.height / 2 - y) < 8)
            .map((r) => ({ x: r.left + r.width / 2, y: r.top + r.height / 2 }))[0] ?? null,
        top,
      );
      if (!sash) throw new Error(`no sash above the ${title} view`);
      await page.mouse.move(sash.x, sash.y);
      await page.mouse.down();
      await page.mouse.move(sash.x, (sash.y + toY) / 2, { steps: 5 });
      await page.mouse.move(sash.x, toY, { steps: 5 });
      await page.mouse.up();
      await sleep(600);
    },

    /** Opens a file of the workspace with Quick Open (Ctrl+P), by its path. */
    async quickOpen(file) {
      await dismissOverlays();
      const bar = await page.locator('.part.statusbar').boundingBox();
      if (bar) await page.mouse.click(bar.x + bar.width / 2, bar.y + bar.height / 2);
      await page.keyboard.press('Control+P');
      await quickInput.waitFor({ state: 'visible', timeout: 8000 });
      await typeQuick(file);
      await sleep(800);
      await page.keyboard.press('Enter');
      await sleep(800);
    },

    /** Takes the keyboard focus off whatever has it: an editor without focus draws no cursor. */
    async blur() {
      await page.evaluate(() => /** @type {HTMLElement | null} */ (document.activeElement)?.blur?.());
      await sleep(300);
    },

    /** Moves the mouse where it shows nothing: a hover left on a row would be in the image. */
    async parkMouse() {
      const bar = await page.locator('.part.statusbar').boundingBox();
      if (bar) await page.mouse.move(bar.x + bar.width - 2, bar.y + bar.height / 2);
      await sleep(250);
    },

    /** Runs git in one of the demo's repositories, with the demo's configuration. */
    git(repo, args) {
      return git(demo.env, demo.repos[repo], args);
    },

    /** Where a part of the window is (`.part.sidebar`, `.part.panel`, …). */
    async partBox(selector) {
      const box = await page.locator(selector).first().boundingBox();
      if (!box) throw new Error(`no ${selector}`);
      return box;
    },

    /**
     * Saves the window, or `clip` of it, as `<outDir>/<file>`.
     *
     * @param {string} file
     * @param {{ x: number, y: number, width: number, height: number }} [clip]
     */
    async shot(file, clip) {
      await sleep(400);
      const png = await capture(cdp, clip);
      const target = path.isAbsolute(file) ? file : path.join(o.outDir, file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, png);
      log(`saved ${file}${clip ? ` (${Math.round(clip.width)}×${Math.round(clip.height)})` : ''}`);
      return target;
    },
  };
}
