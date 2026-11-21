/**
 * A scratch VS Code for the screenshots (docs/screenshots.md): the pinned
 * build `@vscode/test-electron` downloads into `.vscode-test/` (the cache
 * the integration tests use), started on the demo workspace with this
 * checkout as the extension under development, a fresh profile and the
 * settings below, then driven over the Chrome DevTools protocol with
 * Playwright (`@playwright/test`, a dependency of webview-ui).
 *
 * The window draws itself at a fixed size and scale through DevTools
 * emulation, whatever the screen it opens on, so every run's images have the
 * same size.
 */
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

/** The VS Code the screenshots are taken in. Change it on purpose: its look is in every image. */
export const VSCODE_VERSION = '1.146.0';

/** The window's size in CSS pixels, and how many image pixels each one gets. */
export const VIEWPORT = { width: 1440, height: 900, scale: 2 };

/**
 * The scratch profile's settings: a fixed theme, no welcome pages, tips,
 * update checks or AI prompts, VS Code's own Git off (Geet then shows its
 * full status-bar widget), and Geet's Commit window grouped by changelist.
 */
export const SETTINGS = {
  'workbench.colorTheme': 'Default Dark Modern',
  'window.titleBarStyle': 'native',
  'window.customTitleBarVisibility': 'never',
  'window.menuBarVisibility': 'hidden',
  'window.dialogStyle': 'custom',
  'window.menuStyle': 'custom',
  'window.restoreWindows': 'none',
  'workbench.startupEditor': 'none',
  'workbench.tips.enabled': false,
  'workbench.enableExperiments': false,
  'workbench.welcomePage.walkthroughs.openOnInstall': false,
  'workbench.tree.enableStickyScroll': false,
  'workbench.layoutControl.enabled': false,
  'workbench.secondarySideBar.defaultVisibility': 'hidden',
  'chat.disableAIFeatures': true,
  'chat.commandCenter.enabled': false,
  'editor.stickyScroll.enabled': false,
  'editor.cursorBlinking': 'solid',
  'editor.minimap.enabled': false,
  'editor.hover.enabled': false,
  'editor.lightbulb.enabled': 'off',
  'editor.occurrencesHighlight': 'off',
  'editor.selectionHighlight': false,
  'editor.guides.highlightActiveIndentation': false,
  'editor.matchBrackets': 'never',
  'editor.renderLineHighlight': 'none',
  'diffEditor.experimental.showMoves': false,
  'security.workspace.trust.enabled': false,
  'extensions.autoUpdate': false,
  'extensions.autoCheckUpdates': false,
  'extensions.ignoreRecommendations': true,
  'update.mode': 'none',
  'update.showReleaseNotes': false,
  'telemetry.telemetryLevel': 'off',
  'typescript.disableAutomaticTypeAcquisition': true,
  'typescript.validate.enable': false,
  'javascript.validate.enable': false,
  'npm.autoDetect': 'off',
  'git.enabled': false,
  'github.gitAuthentication': false,
  'geet.whatsNew.enabled': false,
  'geet.commit.groupBy': 'changelist',
  'geet.log.showTagNames': true,
};

/**
 * VS Code's executable for `version`, downloaded into `<root>/.vscode-test/` if it is not there yet.
 *
 * @param {string} root the extension's folder
 * @param {string} [version]
 * @returns {Promise<string>}
 */
export async function vscodeExecutable(root, version = VSCODE_VERSION) {
  const require = createRequire(path.join(root, 'package.json'));
  const { downloadAndUnzipVSCode } = require('@vscode/test-electron');
  return downloadAndUnzipVSCode({ version, cachePath: path.join(root, '.vscode-test') });
}

/**
 * Playwright, as webview-ui depends on it.
 *
 * @param {string} root
 * @returns {typeof import('@playwright/test')}
 */
export function playwright(root) {
  const require = createRequire(path.join(root, 'webview-ui', 'package.json'));
  return require('@playwright/test');
}

/**
 * `env` without what would make the new VS Code something else: the
 * variables a VS Code terminal sets (it would hand the window to that VS
 * Code, or run as plain Node).
 *
 * @param {NodeJS.ProcessEnv} env
 * @returns {NodeJS.ProcessEnv}
 */
export function cleanEnv(env) {
  /** @type {NodeJS.ProcessEnv} */
  const out = {};
  for (const [key, value] of Object.entries(env)) {
    if (/^(VSCODE_|ELECTRON_)/iu.test(key)) continue;
    out[key] = value;
  }
  return out;
}

/**
 * Starts VS Code on `folder` and connects to it.
 *
 * @param {{ root: string, exe: string, folder: string, workDir: string, env: NodeJS.ProcessEnv,
 *   settings?: Record<string, unknown>, port?: number }} o
 */
export async function launch(o) {
  const userData = path.join(o.workDir, 'user-data');
  const extensions = path.join(o.workDir, 'extensions');
  fs.rmSync(userData, { recursive: true, force: true });
  fs.mkdirSync(path.join(userData, 'User'), { recursive: true });
  fs.mkdirSync(extensions, { recursive: true });
  fs.writeFileSync(path.join(userData, 'User', 'settings.json'), `${JSON.stringify(o.settings ?? SETTINGS, null, 2)}\n`);
  const port = o.port ?? 9333;
  const child = spawn(
    o.exe,
    [
      o.folder,
      `--user-data-dir=${userData}`,
      `--extensions-dir=${extensions}`,
      `--extensionDevelopmentPath=${o.root}`,
      `--remote-debugging-port=${port}`,
      '--new-window',
      '--disable-workspace-trust',
      '--skip-welcome',
      '--skip-release-notes',
    ],
    { env: cleanEnv(o.env), detached: true, stdio: 'ignore' },
  );
  child.unref();
  const vscode = { child, userData, port, browser: /** @type {import('@playwright/test').Browser | undefined} */ (undefined) };
  const { chromium } = playwright(o.root);
  for (let i = 0; i < 90 && !vscode.browser; i++) {
    try {
      vscode.browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    } catch {
      await sleep(1000);
    }
  }
  if (!vscode.browser) throw new Error(`VS Code did not open its DevTools port ${port}`);
  const browser = vscode.browser;
  /** @type {import('@playwright/test').Page | undefined} */
  let page;
  for (let i = 0; i < 120 && !page; i++) {
    page = browser
      .contexts()
      .flatMap((c) => c.pages())
      .find((p) => p.url().includes('workbench'));
    if (!page) await sleep(500);
  }
  if (!page) throw new Error('VS Code opened no workbench window');
  await page.waitForSelector('.monaco-workbench', { timeout: 90000 });
  return { ...vscode, browser, page };
}

/**
 * Draws the window at `VIEWPORT` from now on, whatever its real size.
 *
 * @param {import('@playwright/test').Page} page
 * @param {typeof VIEWPORT} [viewport]
 */
export async function emulateViewport(page, viewport = VIEWPORT) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: viewport.width,
    height: viewport.height,
    deviceScaleFactor: viewport.scale,
    mobile: false,
    screenWidth: viewport.width,
    screenHeight: viewport.height,
  });
  return cdp;
}

/**
 * A PNG of the window, or of `clip` (CSS pixels) in it.
 *
 * @param {import('@playwright/test').CDPSession} cdp
 * @param {{ x: number, y: number, width: number, height: number } | undefined} clip
 * @returns {Promise<Buffer>}
 */
export async function capture(cdp, clip) {
  const { data } = await cdp.send('Page.captureScreenshot', {
    format: 'png',
    fromSurface: true,
    captureBeyondViewport: false,
    ...(clip ? { clip: { ...roundClip(clip), scale: 1 } } : {}),
  });
  return Buffer.from(data, 'base64');
}

/** @param {{ x: number, y: number, width: number, height: number }} c */
function roundClip(c) {
  const x = Math.round(c.x);
  const y = Math.round(c.y);
  return { x, y, width: Math.round(c.x + c.width) - x, height: Math.round(c.y + c.height) - y };
}

/**
 * Stops the VS Code `launch` started: its process and every process under it.
 *
 * @param {{ child: import('node:child_process').ChildProcess, userData: string, browser?: import('@playwright/test').Browser }} vscode
 */
export async function stop(vscode) {
  await vscode.browser?.close().catch(() => undefined);
  const pid = vscode.child.pid;
  if (pid === undefined) return;
  try {
    if (process.platform === 'win32') {
      execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      process.kill(-pid, 'SIGKILL');
    }
  } catch {
    // Already gone.
  }
  if (process.platform === 'win32') {
    // Anything left that still names this run's profile, such as a process the tree lost.
    const script =
      `$M=${psQuote(vscode.userData)}; Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and ` +
      `$_.CommandLine.IndexOf($M, [System.StringComparison]::OrdinalIgnoreCase) -ge 0 } | ` +
      `ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop } catch {} }`;
    try {
      execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { stdio: 'ignore' });
    } catch {
      // Nothing to stop.
    }
  }
}

/** @param {string} s */
function psQuote(s) {
  return `'${s.replace(/'/gu, "''")}'`;
}

/** @param {number} ms */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
