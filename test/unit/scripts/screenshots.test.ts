/**
 * POST-P14cs: the README's screenshots are taken again by `npm run
 * screenshots` (docs/screenshots.md). Held here: the demo they show is made
 * up and comes out the same on every run, the run never uses the user's own
 * git or VS Code set-up, and the README shows only images the scenes make.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  clearDemoFolder,
  defaultWorkFolder,
  gitConfigText,
  gitDate,
  gitEnv,
  ME,
  PEOPLE,
  REMOTE_BASE,
} from '../../../scripts/screenshots/demo.mjs';
import { CONFLICT, HISTORY, SHOWCASE_FILE, text, WORKING_TREE } from '../../../scripts/screenshots/demoHistory.mjs';
import { CHANGELISTS, LOG_COMMIT, REBASE_PLAN, SCENES } from '../../../scripts/screenshots/scenes.mjs';
import { cleanEnv, SETTINGS, VIEWPORT, VSCODE_VERSION } from '../../../scripts/screenshots/vscode.mjs';

const root = path.resolve(__dirname, '../../..');
const read = (rel: string): string => readFileSync(path.join(root, rel), 'utf8');

describe('the demo team', () => {
  it('is made up: every address is on example.com', () => {
    const people = Object.values(PEOPLE);
    expect(people.length).toBeGreaterThan(3);
    for (const person of people) expect(person.email, person.name).toMatch(/^[a-z.]+@example\.com$/u);
  });

  it("the one at the keyboard is the demo's git user, from the demo's own gitconfig", () => {
    const config = gitConfigText('C:/work/remotes');
    expect(config).toContain(`\tname = ${PEOPLE[ME].name}\n`);
    expect(config).toContain(`\temail = ${PEOPLE[ME].email}\n`);
  });
});

describe('git in the demo', () => {
  it("reads only the demo's gitconfig: no system or global configuration of the user's", () => {
    const env = gitEnv('/work', { PATH: '/bin', HOME: '/home/someone' });
    expect(env['GIT_CONFIG_NOSYSTEM']).toBe('1');
    expect(env['GIT_CONFIG_GLOBAL']).toBe(path.join('/work', 'gitconfig'));
    expect(env['GIT_TERMINAL_PROMPT']).toBe('0');
    expect(env['PATH']).toBe('/bin');
  });

  it("drops the caller's own git variables: a hook's GIT_DIR or an author would leak in", () => {
    const env = gitEnv('/work', { GIT_DIR: '/elsewhere/.git', GIT_AUTHOR_NAME: 'Someone Real', git_index_file: 'x', PATH: '/bin' });
    expect(Object.keys(env).filter((k) => /^git_/iu.test(k)).sort()).toEqual([
      'GIT_CONFIG_GLOBAL',
      'GIT_CONFIG_NOSYSTEM',
      'GIT_TERMINAL_PROMPT',
    ]);
  });

  it('sends the made-up origins to the bare repositories on disk, keeps LF, and never signs', () => {
    const config = gitConfigText('C:/work/remotes');
    expect(REMOTE_BASE).toMatch(/^https:\/\/git\.example\.com\//u);
    expect(config).toContain(`[url "C:/work/remotes/"]\n\tinsteadOf = ${REMOTE_BASE}\n`);
    expect(config).toMatch(/\tautocrlf = false\n/u);
    expect(config).toMatch(/\[commit\]\n\tgpgsign = false\n/u);
    expect(config).toMatch(/\[tag\]\n\tgpgsign = false\n/u);
  });

  it('dates a step in its author’s time zone, and refuses a date it cannot read', () => {
    expect(gitDate('2026-08-04 09:12', 'mei')).toBe('2026-08-04T09:12:00+08:00');
    expect(gitDate('2026-10-20 10:40', 'diego')).toBe('2026-10-20T10:40:00-03:00');
    expect(() => gitDate('2026-8-4 9:12', 'mei')).toThrow(/bad date/u);
  });
});

describe('the demo history', () => {
  const steps = Object.entries(HISTORY).flatMap(([repo, list]) => list.map((step) => ({ repo, step })));

  it('is three repositories: web, api and shared', () => {
    expect(Object.keys(HISTORY).sort()).toEqual(['api', 'shared', 'web']);
  });

  it('names only people of the team, on dates git takes: the same commits on every run', () => {
    for (const { repo, step } of steps) {
      if (step.op !== 'commit' && step.op !== 'merge' && step.op !== 'tag') continue;
      expect(Object.keys(PEOPLE), `${repo}: ${JSON.stringify(step).slice(0, 80)}`).toContain(step.who);
      expect(() => gitDate(step.when, step.who as keyof typeof PEOPLE)).not.toThrow();
      expect(step.message.trim()).not.toBe('');
    }
  });

  it('leaves uncommitted changes in web and api, the diff scene’s file among them', () => {
    expect(Object.keys(WORKING_TREE['web'] ?? {})).toContain(SHOWCASE_FILE.file);
    expect(Object.keys(WORKING_TREE['api'] ?? {}).length).toBeGreaterThan(0);
    expect(SHOWCASE_FILE.repo).toBe('web');
  });

  it('has the branch the merge scene merges, and both sides change the file it conflicts in', () => {
    const list = HISTORY[CONFLICT.repo] ?? [];
    expect(list.some((s) => s.op === 'branch' && s.name === CONFLICT.branch)).toBe(true);
    const touching = list.filter((s) => s.op === 'commit' && CONFLICT.file in s.files);
    expect(touching.length).toBeGreaterThanOrEqual(3);
  });

  it('writes no file text with a carriage return or a tab: the demo is LF and spaces', () => {
    const texts = [
      ...steps.flatMap(({ step }) => (step.op === 'commit' ? Object.values(step.files) : [])),
      ...Object.values(WORKING_TREE).flatMap((files) => Object.values(files)),
    ].filter((t): t is string => typeof t === 'string');
    for (const t of texts) {
      expect(t).not.toMatch(/[\r\t]/u);
      expect(t.endsWith('\n')).toBe(true);
    }
  });
});

describe('text', () => {
  it("drops the indentation the template's own lines share", () => {
    expect(text`
      a {
        b;
      }
    `).toBe('a {\n  b;\n}\n');
  });

  it('keeps an inserted value as it is, and makes one blank line of several', () => {
    const lines = ['  x,', '  y,'].join('\n');
    expect(text`
      [
      ${lines}
      ]


      z
    `).toBe('[\n  x,\n  y,\n]\n\nz\n');
  });
});

describe('the scenes and the demo agree', () => {
  const subjects = (repo: string): string[] =>
    (HISTORY[repo] ?? []).flatMap((s) => (s.op === 'commit' ? [s.message.split('\n')[0] ?? ''] : []));

  it("the rebase starts from a commit of web's checked-out branch and lists its last four, oldest first", () => {
    const web = subjects('web');
    const plan = REBASE_PLAN.map((p) => p.subject);
    const at = web.indexOf(plan[0] ?? '');
    expect(at).toBeGreaterThan(-1);
    expect(web.slice(at, at + plan.length)).toEqual(plan);
    // The editor refuses squash or fixup on the first commit.
    expect(REBASE_PLAN[0]?.action).toBe('pick');
  });

  it('the commit the Log and the Push dialog select is in web', () => {
    expect(subjects('web')).toContain(LOG_COMMIT);
  });

  it('every file a changelist holds is one the demo leaves changed', () => {
    for (const list of CHANGELISTS) {
      for (const [repo, files] of Object.entries(list.files)) {
        for (const file of files) expect(Object.keys(WORKING_TREE[repo] ?? {}), `${list.name}: ${repo}/${file}`).toContain(file);
      }
    }
  });

  it('scene names and their images are each used once', () => {
    const names = SCENES.map((s) => s.name);
    const files = SCENES.flatMap((s) => [...s.files]);
    expect(new Set(names).size).toBe(names.length);
    expect(new Set(files).size).toBe(files.length);
    for (const file of files) expect(file).toMatch(/^[a-z-]+\.png$/u);
  });
});

describe('the work folder', () => {
  it('is outside the user folder on Windows: Geet shows full paths, and the images would name the user', () => {
    expect(defaultWorkFolder('win32', { SystemDrive: 'C:' }, 'C:\\Users\\someone\\AppData\\Local\\Temp')).toBe(
      'C:\\geet-screenshots',
    );
    expect(defaultWorkFolder('win32', { SystemDrive: 'D:' }, 'D:\\temp')).toBe('D:\\geet-screenshots');
    expect(defaultWorkFolder('win32', {}, 'C:\\temp')).toBe('C:\\geet-screenshots');
  });

  it('is in the temp folder elsewhere, whose path names nobody', () => {
    expect(defaultWorkFolder('linux', {}, '/tmp')).toBe('/tmp/geet-screenshots');
    expect(defaultWorkFolder('darwin', {}, '/var/folders/xy/T')).toBe('/var/folders/xy/T/geet-screenshots');
  });
});

describe('clearDemoFolder', () => {
  const made: string[] = [];
  const tmp = (): string => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'geet-shots-test-'));
    made.push(dir);
    return dir;
  };
  afterEach(() => {
    for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('deletes a demo folder an earlier run made', () => {
    const dir = path.join(tmp(), 'demo');
    mkdirSync(path.join(dir, 'pantry'), { recursive: true });
    writeFileSync(path.join(dir, '.geet-screenshots'), '');
    clearDemoFolder(dir);
    expect(existsSync(dir)).toBe(false);
  });

  it('refuses a folder with anything else in it, and leaves it alone', () => {
    const dir = tmp();
    writeFileSync(path.join(dir, 'important.txt'), 'keep me');
    expect(() => clearDemoFolder(dir)).toThrow(/not a demo folder/u);
    expect(readFileSync(path.join(dir, 'important.txt'), 'utf8')).toBe('keep me');
  });
});

describe('the scratch VS Code', () => {
  it('drops what a VS Code terminal sets, which would hand the window to that VS Code', () => {
    const env = cleanEnv({ PATH: '/bin', VSCODE_IPC_HOOK_CLI: '/tmp/x.sock', ELECTRON_RUN_AS_NODE: '1', VSCODE_PID: '1' });
    expect(env).toEqual({ PATH: '/bin' });
  });

  it('is a pinned version at a fixed size, drawn at twice the pixels', () => {
    expect(VSCODE_VERSION).toMatch(/^\d+\.\d+\.\d+$/u);
    expect(VIEWPORT.scale).toBe(2);
  });

  it('has a fixed theme, no prompts of its own, and VS Code’s Git off', () => {
    expect(SETTINGS['workbench.colorTheme']).toBe('Default Dark Modern');
    expect(SETTINGS['git.enabled']).toBe(false);
    expect(SETTINGS['geet.whatsNew.enabled']).toBe(false);
    expect(SETTINGS['update.mode']).toBe('none');
    expect(SETTINGS['telemetry.telemetryLevel']).toBe('off');
  });
});

describe('the README’s images', () => {
  const readme = read('README.md');
  // Markdown images and <img src>, the two forms vsce rewrites to the repository's copy.
  const shown = [
    ...[...readme.matchAll(/!\[[^\]]*\]\(([^)]+)\)/gu)].map((m) => m[1] ?? ''),
    ...[...readme.matchAll(/<img[^>]+src="([^"]+)"/gu)].map((m) => m[1] ?? ''),
  ];

  it('are the ones the scenes make, each a PNG in docs/images', () => {
    const made = new Set(SCENES.flatMap((s) => s.files.map((f) => `docs/images/${f}`)));
    expect(shown.length).toBeGreaterThan(3);
    for (const src of shown) {
      expect(made.has(src), src).toBe(true);
      const bytes = readFileSync(path.join(root, src));
      expect(bytes.subarray(1, 4).toString('latin1'), src).toBe('PNG');
    }
  });

  it('every image a scene makes is on disk, and the README shows it', () => {
    for (const scene of SCENES) {
      for (const file of scene.files) {
        expect(existsSync(path.join(root, 'docs', 'images', file)), file).toBe(true);
        expect(shown, file).toContain(`docs/images/${file}`);
      }
    }
  });

  it('stay out of the VSIX: the Marketplace page loads them from GitHub', () => {
    expect(read('.vscodeignore').split(/\r?\n/u)).toContain('docs/**');
  });

  it('are paths vsce can rewrite: relative, and only letters, digits, dots, dashes and slashes', () => {
    // vsce rewrites <img src> only when the path matches [/.\w\s#-]+.
    for (const src of shown) expect(src).toMatch(/^[\w-]+(\/[\w.-]+)+$/u);
  });
});
