/**
 * The README's screenshots, one scene each (docs/screenshots.md). `prepare`
 * sets up what every scene shares — three changelists, a commit message, the
 * Log on the `web` repository with every branch — then each scene lays the
 * window out for itself, takes its image, and puts back what it changed for
 * the scenes after it.
 *
 * A scene's `files` are the images it writes to docs/images/; the README
 * shows each of them (test/unit/scripts/screenshots.test.ts).
 */
import { CONFLICT } from './demoHistory.mjs';

/** @typedef {ReturnType<typeof import('./driver.mjs').createDriver>} Driver */
/** @typedef {import('@playwright/test').Frame} Frame */

/** The changelists the Commit window shows, and the files in each. */
export const CHANGELISTS = [
  { name: 'Meal planner', files: { web: ['src/planner/WeekView.tsx', 'src/planner/usePlanner.ts'], api: ['src/routes/plans.ts'] } },
  { name: 'Cart coupons', files: { web: ['src/cart/totals.ts'] } },
  { name: 'Local proxy, do not commit', files: { web: ['vite.config.ts'] } },
];

/** What Ava is about to commit. */
export const COMMIT_MESSAGE = 'Plan a week of meals\n\nA week view with drag and drop between days, and an endpoint\nthat removes a planned meal.';

/** The commit the Log shows in detail, and the one the interactive rebase starts from. */
export const LOG_COMMIT = 'Make a shopping list from the week’s meals';

/**
 * The rebase scene's plan, oldest commit first: before pushing, each fix is
 * folded into the commit it fixes. (Only fixups: the editor's summary reads
 * "1 squashes" for one squash, a plural it always adds.)
 */
export const REBASE_PLAN = [
  { subject: 'Make a shopping list from the week’s meals', action: 'pick' },
  { subject: 'Ignore case when adding up ingredients', action: 'fixup' },
  { subject: 'Show the calories of each day', action: 'pick' },
  { subject: 'Count calories per serving, not per meal', action: 'fixup' },
];

/** @param {string} s */
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

/** @param {string} s */
const exactly = (s) => new RegExp(`^${escapeRegExp(s)}$`, 'u');

/** The Commit window's rows. */
function commitWindow(/** @type {Driver} */ d, /** @type {Frame} */ f) {
  const rows = '[data-testid="commit-tree"] [role="treeitem"]';
  return {
    frame: f,
    /** A file's row, by its repository and path. */
    file: (repo, rel) =>
      f.locator(
        `${rows}[data-vscode-context*='"webviewSection":"commitFile"'][data-vscode-context*='${repo}","relPath":"${rel}","relPaths"']`,
      ),
    /** A changelist's own row. */
    list: (name) => f.locator(`${rows}[aria-level="1"]`, { has: f.locator('.gt-tree-name', { hasText: exactly(name) }) }),
    /** Scrolls the tree, and only the tree, until `row` is in view. */
    async reveal(row) {
      await row.waitFor({ timeout: 15000 });
      await row.evaluate((el) => {
        el.scrollIntoView({ block: 'nearest' });
        document.scrollingElement?.scrollTo(0, 0);
      });
      await d.sleep(250);
    },
    async waitForRows(n = 3) {
      const ok = await d.waitFor(async () => ((await f.locator(rows).count()) >= n ? true : undefined), 30000);
      if (!ok) throw new Error('the Commit window shows no changes');
    },
  };
}

/** The main Log tab's parts. */
function logTab(/** @type {Frame} */ f) {
  const tab = '[data-testid="log-tab-log"]';
  return {
    frame: f,
    tab: f.locator(tab),
    /** A commit's row, by its subject. */
    row: (subject) => f.locator(`${tab} [data-gt-row]`, { has: f.locator('.gt-log-subject', { hasText: exactly(subject) }) }),
    details: f.locator(`${tab} [data-testid="details-panel"]`),
  };
}

/**
 * Lays the window out: its size, the side bar (and its width), the panel (and
 * where its top edge is, or maximized).
 *
 * @param {Driver} d
 * @param {{ width: number, height: number, sidebar?: number | false, panel?: number | 'max' | false }} l
 */
async function layout(d, l) {
  await d.viewport({ width: l.width, height: l.height });
  const sidebarShown = await d.isShown('.part.sidebar');
  if ((l.sidebar !== false) !== sidebarShown) await d.command('View: Toggle Primary Side Bar Visibility');
  if (typeof l.sidebar === 'number') await d.dragEdge('sidebar', 48 + l.sidebar);
  const panelShown = await d.isShown('.part.panel');
  if ((l.panel !== false && l.panel !== undefined) !== panelShown) await d.command('View: Toggle Panel Visibility');
  if (l.panel !== false && l.panel !== undefined) {
    const panel = await d.partBox('.part.panel');
    const maximized = panel.height > l.height * 0.7;
    if ((l.panel === 'max') !== maximized) await d.command('View: Toggle Maximized Panel');
    if (typeof l.panel === 'number') await d.dragEdge('panel', l.panel);
  }
}

/**
 * What every scene needs: the changelists, the message, the Log on web.
 *
 * @param {Driver} d
 */
export async function prepare(d) {
  const { page } = d;
  await page.locator('.activitybar .action-item a[aria-label^="GitTree"]').first().waitFor({ timeout: 90000 });
  await d.dismissOverlays();
  // Notifications would sit in the images: an unfocused window never times them out.
  await d.command('Notifications: Toggle Do Not Disturb Mode');
  await d.command('GitTree: Focus on Commit View');
  const cw = commitWindow(d, await d.frame('[data-testid="commit-tree"]'));
  await cw.waitForRows();

  for (const list of CHANGELISTS) {
    await d.command('GitTree: New Changelist…');
    await d.answer(list.name);
    await d.answer(''); // no comment
  }
  for (const list of CHANGELISTS) {
    for (const [repo, files] of Object.entries(list.files)) {
      // One repository per move: the menu moves the selected files of the row's repository.
      for (const [i, rel] of files.entries()) {
        const row = cw.file(repo, rel);
        await cw.reveal(row);
        await d.clickRaw(row.locator('.gt-tree-name'), { modifiers: i === 0 ? [] : ['Control'] });
      }
      const first = cw.file(repo, files[0]);
      await cw.reveal(first);
      await d.clickRaw(first.locator('.gt-tree-name'), { button: 'right' });
      await d.contextMenuItem('Move to Another Changelist…');
      await d.pick(list.name);
      const moved = await d.waitFor(async () => {
        const row = cw.list(list.name);
        return (await row.count()) > 0 && /\d+ files?$/u.test((await row.getAttribute('aria-label')) ?? '');
      }, 10000);
      if (!moved) throw new Error(`could not move ${files.join(', ')} to ${list.name}`);
    }
  }
  // Only the meal planner goes into this commit.
  for (const list of CHANGELISTS.slice(1)) {
    const row = cw.list(list.name);
    await cw.reveal(row);
    if ((await row.getAttribute('aria-checked')) !== 'false') {
      await d.clickRaw(row.locator('.gt-tree-check'));
      const unticked = await d.waitFor(async () => ((await row.getAttribute('aria-checked')) === 'false' ? true : undefined), 8000);
      if (!unticked) throw new Error(`could not untick ${list.name}`);
    }
  }
  await typeMessage(d, cw);

  // The Log: web, the repository with the most history, and every branch in it.
  await d.command('GitTree: Focus on Log View');
  const log = logTab(await d.frame('[data-testid="log-tab-log"] [data-gt-row]'));
  await d.clickRaw(log.tab.locator('[data-testid="filter-paths"]'));
  await d.clickRaw(log.frame.locator('[data-testid="filter-paths-panel"] input[data-testid="filter-root-web"]'));
  await d.keys('Escape');
  const onWeb = await d.waitFor(async () => ((await log.row(LOG_COMMIT).count()) > 0 ? true : undefined), 15000);
  if (!onWeb) throw new Error('the Log did not move to web');
  await d.clickRaw(log.tab.locator('[data-testid="filter-branch"]'));
  await d.clickRaw(log.frame.locator('label.gt-filter-preset', { hasText: 'All branches' }).first());
  await d.keys('Escape');
  await d.sleep(1500);
  await d.parkMouse();
}

/**
 * Types the commit message, the subject line in view. GitTree keeps a draft per
 * repository (the active editor's), so a scene that opens an editor types it again.
 */
async function typeMessage(/** @type {Driver} */ d, /** @type {ReturnType<typeof commitWindow>} */ cw) {
  const message = cw.frame.locator('textarea[data-testid="commit-message"]');
  if ((await message.inputValue()) !== COMMIT_MESSAGE) await message.fill(COMMIT_MESSAGE);
  await message.evaluate((el) => {
    const box = /** @type {HTMLTextAreaElement} */ (el);
    box.setSelectionRange(0, 0);
    box.scrollTop = 0;
    box.blur();
  });
  // The box sends its text after a 250 ms pause, or when it loses focus.
  await d.sleep(400);
}

/**
 * @typedef {{ name: string, title: string, files: string[], run: (d: Driver) => Promise<void>, cleanUp?: (d: Driver) => Promise<void> }} Scene
 */

/**
 * Shows or folds the Log's Branches pane (folded, it is a slim bar and the commits get its room).
 *
 * @param {Driver} d
 * @param {ReturnType<typeof logTab>} log
 * @param {boolean} shown
 */
async function logBranchesPane(d, log, shown) {
  const open = log.tab.locator('[data-testid="pane-branches"] button[aria-label="Collapse Branches"]');
  const folded = log.tab.locator('[data-testid="pane-branches-collapsed"] button[aria-label="Expand Branches"]');
  if (shown && (await folded.count()) > 0) await d.clickRaw(folded);
  if (!shown && (await open.count()) > 0) await d.clickRaw(open);
}

/** @type {Scene[]} */
export const SCENES = [
  {
    name: 'hero',
    title: 'the whole window: the Commit window, a diff, and the Log',
    files: ['hero.png'],
    async run(d) {
      await layout(d, { width: 1440, height: 900, sidebar: 380, panel: 480 });
      await d.command('GitTree: Focus on Commit View');
      await d.setViewExpanded('Repositories', true);
      await d.setViewExpanded('Branches', true);
      // Room for the three changelists: VS Code's first split gives the Commit window less.
      await d.dragViewEdge('Repositories', 548);
      const cw = commitWindow(d, await d.frame('[data-testid="commit-tree"]'));
      // GitTree's diff of the coupon change, from its row's own menu.
      const totals = cw.file('web', 'src/cart/totals.ts');
      await cw.reveal(totals);
      await d.clickRaw(totals.locator('.gt-tree-name'), { button: 'right' });
      await d.contextMenuItem('Open Changes');
      await d.page.locator('.monaco-diff-editor').first().waitFor({ timeout: 15000 });
      // The diff opens on its first change, scrolled part-way into a line: from the top instead.
      await d.sleep(800);
      await d.keys('Control+Home');
      await typeMessage(d, cw);
      await cw.reveal(cw.list('Changes'));
      const log = logTab(await d.frame('[data-testid="log-tab-log"] [data-gt-row]'));
      await logBranchesPane(d, log, false);
      await d.clickRaw(log.row(LOG_COMMIT).locator('.gt-log-subject'));
      await log.details.waitFor({ timeout: 10000 });
      await d.sleep(1500);
      await d.parkMouse();
      await d.shot('hero.png');
    },
    async cleanUp(d) {
      await logBranchesPane(d, logTab(await d.frame('[data-testid="log-tab-log"] [data-gt-row]')), true);
    },
  },
  {
    name: 'commit',
    title: 'the Commit window: changelists, and a preview that leaves one change out',
    files: ['commit.png'],
    async run(d) {
      await layout(d, { width: 1280, height: 860, sidebar: 960, panel: false });
      await d.command('View: Close All Editors');
      await d.command('GitTree: Focus on Commit View');
      await d.setViewExpanded('Repositories', false);
      await d.setViewExpanded('Branches', false);
      const cw = commitWindow(d, await d.frame('[data-testid="commit-tree"]'));
      const unversioned = cw.list('Unversioned Files');
      if ((await unversioned.getAttribute('aria-expanded')) === 'true') await d.clickRaw(unversioned.locator('.gt-twistie'));
      const week = cw.file('web', 'src/planner/WeekView.tsx');
      await cw.reveal(week);
      await d.clickRaw(week.locator('.gt-tree-name'));
      const preview = cw.frame.locator('[data-testid="commit-preview"]');
      if ((await preview.count()) === 0) await d.clickRaw(cw.frame.locator('button[aria-label="Preview Diff"]'));
      await preview.waitFor({ timeout: 15000 });
      // The forgotten console.log stays out of the commit: the second of the file's three changes.
      const include = cw.frame.locator('[data-testid="diff-include-1"]');
      await include.waitFor({ timeout: 10000 });
      const state = () => include.locator('.gt-tricheck').getAttribute('data-state');
      if ((await state()) !== 'unchecked') await d.clickRaw(include);
      const left = await d.waitFor(async () => ((await state()) === 'unchecked' ? true : undefined), 8000);
      if (!left) throw new Error('could not leave the console.log out');
      await typeMessage(d, cw);
      await cw.reveal(cw.list('Changes'));
      await d.sleep(800);
      await d.parkMouse();
      await d.shot('commit.png', await d.partBox('.part.sidebar'));
    },
    async cleanUp(d) {
      const cw = commitWindow(d, await d.frame('[data-testid="commit-tree"]'));
      if ((await cw.frame.locator('[data-testid="commit-preview"]').count()) > 0) {
        await d.clickRaw(cw.frame.locator('button[aria-label="Preview Diff"]'));
      }
      await d.setViewExpanded('Repositories', true);
      await d.setViewExpanded('Branches', true);
    },
  },
  {
    name: 'log',
    title: 'the Log: branches, the commit graph, changed files and details',
    files: ['log.png'],
    async run(d) {
      await layout(d, { width: 1280, height: 760, sidebar: false, panel: 'max' });
      const log = logTab(await d.frame('[data-testid="log-tab-log"] [data-gt-row]'));
      await logBranchesPane(d, log, true);
      await d.clickRaw(log.row(LOG_COMMIT).locator('.gt-log-subject'));
      await log.details.waitFor({ timeout: 10000 });
      await d.sleep(1200);
      await d.parkMouse();
      await d.shot('log.png', await d.partBox('.part.panel'));
    },
    async cleanUp(d) {
      await layout(d, { width: 1440, height: 900, sidebar: 380, panel: 480 });
    },
  },
  {
    name: 'branches',
    title: 'the branches popup: actions first, then every repository and its branches',
    files: ['branches.png'],
    async run(d) {
      // Tall, so VS Code's logo in the empty editor area stays well below the popup.
      await layout(d, { width: 1280, height: 1400, sidebar: false, panel: false });
      await d.command('View: Close All Editors');
      await d.command('GitTree: Checkout Branch…');
      await d.pick('web');
      const popup = d.page.locator('.quick-input-widget');
      await popup.waitFor({ state: 'visible', timeout: 10000 });
      await d.sleep(1500);
      await d.parkMouse();
      const box = await popup.boundingBox();
      if (!box) throw new Error('no popup');
      const pad = 16;
      const y = Math.max(0, box.y - pad);
      await d.shot('branches.png', { x: box.x - pad, y, width: box.width + 2 * pad, height: box.y + box.height + pad - y });
    },
    async cleanUp(d) {
      await d.keys('Escape');
    },
  },
  {
    name: 'rebase',
    title: 'the interactive rebase editor, tidying a branch before it is pushed',
    files: ['rebase.png'],
    async run(d) {
      await layout(d, { width: 1440, height: 900, sidebar: false, panel: 480 });
      await d.command('View: Close All Editors');
      const log = logTab(await d.frame('[data-testid="log-tab-log"] [data-gt-row]'));
      await d.clickRaw(log.row(REBASE_PLAN[0].subject).locator('.gt-log-subject'), { button: 'right' });
      await d.contextMenuItem('Interactively Rebase from Here…');
      const editor = await d.frame('[data-testid="rebase-edit"]');
      await layout(d, { width: 1200, height: 420, sidebar: false, panel: false });
      for (const [i, step] of REBASE_PLAN.entries()) {
        const row = editor.locator(`[data-gt-rebase-row="${i}"]`);
        const subject = (await row.locator('.gt-rb-subject').textContent())?.trim();
        if (subject !== step.subject) throw new Error(`rebase row ${i} is "${subject}", not "${step.subject}"`);
        if (step.action !== 'pick') await row.locator('select').selectOption(step.action);
        await d.sleep(300);
      }
      await d.sleep(600);
      await d.parkMouse();
      await d.shot('rebase.png', await d.partBox('.part.editor'));
    },
    async cleanUp(d) {
      const editor = await d.frame('[data-testid="rebase-edit"]', 5000).catch(() => undefined);
      if (editor) await d.clickRaw(editor.locator('[data-testid="cancel"]'));
    },
  },
  {
    name: 'push',
    title: 'the Push dialog: two repositories at once, and the commands it will run',
    files: ['push.png'],
    async run(d) {
      await layout(d, { width: 1280, height: 700, sidebar: false, panel: false });
      await d.command('View: Close All Editors');
      await d.command('GitTree: Push…');
      const dialog = await d.frame('[data-testid="push-commits"]');
      for (const repo of ['api', 'web']) {
        const tick = dialog.locator(`input[data-testid="push-repo-${repo}"]`);
        if (!(await tick.isChecked())) await d.clickRaw(tick);
        const row = dialog.locator(`[data-testid="push-repo-row-${repo}"]`);
        if ((await row.getAttribute('aria-expanded')) !== 'true') await d.clickRaw(row.locator('.gt-push-chevron'));
      }
      await d.clickRaw(dialog.locator('[data-testid="push-commit-row"]', { hasText: LOG_COMMIT }).locator('.gt-push-subject'));
      await dialog.locator('[data-testid="push-details"]').waitFor({ timeout: 10000 });
      await d.sleep(800);
      await d.parkMouse();
      await d.shot('push.png', await d.partBox('.part.editor'));
    },
    async cleanUp(d) {
      const dialog = await d.frame('[data-testid="push-commits"]', 5000).catch(() => undefined);
      if (dialog) await d.clickRaw(dialog.getByRole('button', { name: 'Cancel' }));
    },
  },
  {
    name: 'merge',
    title: 'the three-pane merge editor on a real conflict',
    files: ['merge.png'],
    async run(d) {
      await layout(d, { width: 1600, height: 720, sidebar: false, panel: false });
      await d.command('View: Close All Editors');
      try {
        d.git(CONFLICT.repo, ['merge', '--no-edit', CONFLICT.branch]);
      } catch {
        // It stops on the conflict, as it should.
      }
      // GitTree notices the conflict and opens "Files Merged with Conflicts" by itself.
      const dialog = await d.frame('[data-testid="conflicts-list"]');
      await d.clickRaw(dialog.getByRole('button', { name: 'Merge…' }));
      await d.page.locator('.tab', { hasText: 'money (Theirs).ts' }).first().waitFor({ timeout: 20000 });
      await layout(d, { width: 1600, height: 720, sidebar: false, panel: false });
      await d.sleep(2000);
      await d.blur();
      await d.parkMouse();
      await d.shot('merge.png');
    },
    async cleanUp(d) {
      await d.command('Abort File Merge').catch(() => undefined);
      await d.command('Abort Operation').catch(() => undefined);
      await d.command('View: Close All Editors').catch(() => undefined);
    },
  },
  {
    name: 'blame',
    title: 'blame in the editor, shaded by age',
    files: ['blame.png'],
    async run(d) {
      await layout(d, { width: 1280, height: 760, sidebar: false, panel: false });
      await d.command('View: Close All Editors');
      await d.quickOpen('web/src/cart/totals.ts');
      await d.page.locator('.monaco-editor .view-lines').first().waitFor({ timeout: 15000 });
      await d.command('GitTree: Annotate with Git Blame');
      // Where three people and the uncommitted coupon change meet: lineTotal and its neighbours.
      await d.keys('Control+G');
      await d.answer(':38');
      await d.sleep(2500);
      await d.blur();
      await d.parkMouse();
      await d.shot('blame.png', await d.partBox('.part.editor'));
    },
    async cleanUp(d) {
      await d.command('GitTree: Annotate with Git Blame').catch(() => undefined);
    },
  },
];
