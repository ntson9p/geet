/**
 * The demo workspace the README's screenshots are taken in
 * (docs/screenshots.md): "pantry", a made-up meal-planning app kept in three
 * repositories — `web`, `api` and `shared` — each with an origin.
 *
 * Every commit, merge and tag is written with fixed people and fixed dates,
 * so a run makes the same commits, with the same hashes, on any machine and
 * on any day. Git runs with no system or global configuration of the user's:
 * only `<root>/gitconfig`, which this file writes. The people are invented and
 * their addresses are on example.com, so no real name or address can reach a
 * screenshot; the origins look like `https://git.example.com/pantry/web.git`
 * and are bare repositories under `<root>/remotes` (`url.<path>.insteadOf`).
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HISTORY, WORKING_TREE } from './demoHistory.mjs';

/** The made-up team. `ava` is the one at the keyboard: the demo's git user. */
export const PEOPLE = {
  ava: { name: 'Ava Thompson', email: 'ava.thompson@example.com', tz: '+01:00' },
  diego: { name: 'Diego Ramos', email: 'diego.ramos@example.com', tz: '-03:00' },
  mei: { name: 'Mei Lin', email: 'mei.lin@example.com', tz: '+08:00' },
  noah: { name: 'Noah Becker', email: 'noah.becker@example.com', tz: '+01:00' },
  samir: { name: 'Samir Haddad', email: 'samir.haddad@example.com', tz: '+02:00' },
  zara: { name: 'Zara Okafor', email: 'zara.okafor@example.com', tz: '+00:00' },
};
export const ME = 'ava';

/** Where the origins seem to live. */
export const REMOTE_BASE = 'https://git.example.com/pantry/';

/** The folder VS Code opens: one repository per subfolder. */
export const WORKSPACE_NAME = 'pantry';

/** A file in a folder this module made, so it only ever deletes its own. */
const MARKER = '.geet-screenshots';

/**
 * The environment every git call of the demo runs with, VS Code's included:
 * no system or global configuration but `<root>/gitconfig`, C-locale output,
 * no prompts, and nothing the caller's own git context could add.
 *
 * @param {string} root
 * @param {NodeJS.ProcessEnv} [base]
 * @returns {NodeJS.ProcessEnv}
 */
export function gitEnv(root, base = process.env) {
  /** @type {NodeJS.ProcessEnv} */
  const env = {};
  for (const [key, value] of Object.entries(base)) {
    if (/^GIT_/iu.test(key)) continue;
    env[key] = value;
  }
  return {
    ...env,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: path.join(root, 'gitconfig'),
    GIT_TERMINAL_PROMPT: '0',
    LC_ALL: 'C',
  };
}

/**
 * The only git configuration the demo sees.
 *
 * @param {string} remotes the folder of bare repositories, with forward slashes
 * @returns {string}
 */
export function gitConfigText(remotes) {
  const me = PEOPLE[ME];
  return [
    '[user]',
    `\tname = ${me.name}`,
    `\temail = ${me.email}`,
    '[init]',
    '\tdefaultBranch = main',
    '[core]',
    '\tautocrlf = false',
    '\tsafecrlf = false',
    '\tfsmonitor = false',
    '[commit]',
    '\tgpgsign = false',
    '[tag]',
    '\tgpgsign = false',
    '[advice]',
    '\tdetachedHead = false',
    '[gc]',
    '\tauto = 0',
    '[maintenance]',
    '\tauto = false',
    '[pull]',
    '\trebase = false',
    `[url "${remotes}/"]`,
    `\tinsteadOf = ${REMOTE_BASE}`,
    '',
  ].join('\n');
}

/**
 * `2026-08-04 09:12` in `who`'s time zone, as git takes a date.
 *
 * @param {string} when
 * @param {keyof typeof PEOPLE} who
 */
export function gitDate(when, who) {
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/u.test(when)) throw new Error(`bad date "${when}"`);
  return `${when.replace(' ', 'T')}:00${PEOPLE[who].tz}`;
}

/**
 * Where the demo (and the scratch VS Code's profile) go by default. Geet
 * shows a repository's full path in places, such as the Log's Changed Files,
 * so on Windows the demo goes to the root of the system drive: under the user
 * folder, the user's name would be in the images. Elsewhere the temp folder's
 * path names nobody.
 *
 * @param {NodeJS.Platform} [platform]
 * @param {NodeJS.ProcessEnv} [env]
 * @param {string} [tmp]
 */
export function defaultWorkFolder(platform = process.platform, env = process.env, tmp = os.tmpdir()) {
  if (platform === 'win32') return path.win32.join(`${env['SystemDrive'] ?? 'C:'}\\`, 'geet-screenshots');
  return path.posix.join(tmp, 'geet-screenshots');
}

/**
 * Deletes `dir` if it is missing, empty, or a demo this module built (it holds
 * the marker file) — never anything else.
 *
 * @param {string} dir
 */
export function clearDemoFolder(dir) {
  if (!fs.existsSync(dir)) return;
  const entries = fs.readdirSync(dir);
  if (entries.length > 0 && !entries.includes(MARKER)) {
    throw new Error(`${dir} is not empty and is not a demo folder this script made; pick another --work folder`);
  }
  // Windows can hold a file of a VS Code that has just been stopped for a moment.
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
}

/**
 * Builds the demo in `root` (deleted first if it is an older demo):
 * `root/remotes/<repo>.git`, `root/pantry/<repo>` and `root/gitconfig`.
 *
 * @param {string} root
 * @returns {{ root: string, workspace: string, remotes: string, repos: Record<string, string>, env: NodeJS.ProcessEnv }}
 */
export function buildDemo(root) {
  clearDemoFolder(root);
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, MARKER), 'Made by scripts/screenshots; deleted on the next run.\n');
  const remotes = path.join(root, 'remotes');
  const workspace = path.join(root, WORKSPACE_NAME);
  fs.mkdirSync(remotes, { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(path.join(root, 'gitconfig'), gitConfigText(remotes.replace(/\\/gu, '/')));
  const env = gitEnv(root);

  /** @type {Record<string, string>} */
  const repos = {};
  for (const [name, steps] of Object.entries(HISTORY)) {
    const dir = path.join(workspace, name);
    const bare = path.join(remotes, `${name}.git`);
    git(env, remotes, ['init', '-q', '--bare', '-b', 'main', bare]);
    fs.mkdirSync(dir, { recursive: true });
    git(env, dir, ['init', '-q', '-b', 'main']);
    git(env, dir, ['remote', 'add', 'origin', `${REMOTE_BASE}${name}.git`]);
    play(env, dir, steps);
    repos[name] = dir;
  }
  for (const [name, files] of Object.entries(WORKING_TREE)) writeFiles(repos[name], files);
  return { root, workspace, remotes, repos, env };
}

/**
 * Runs one repository's history: commits, branches, merges, tags, pushes.
 *
 * @param {NodeJS.ProcessEnv} env
 * @param {string} dir
 * @param {import('./demoHistory.mjs').Step[]} steps
 */
function play(env, dir, steps) {
  for (const step of steps) {
    switch (step.op) {
      case 'commit': {
        writeFiles(dir, step.files);
        git(env, dir, ['add', '-A']);
        git(stamped(env, step.who, step.when), dir, ['commit', '-q', '--no-verify', '-m', step.message]);
        break;
      }
      case 'branch':
        git(env, dir, ['branch', step.name, ...(step.from ? [step.from] : [])]);
        break;
      case 'checkout':
        git(env, dir, ['checkout', '-q', step.name]);
        break;
      case 'merge':
        git(stamped(env, step.who, step.when), dir, ['merge', '-q', '--no-ff', '--no-verify', '-m', step.message, step.name]);
        break;
      case 'tag':
        git(stamped(env, step.who, step.when), dir, ['tag', '-a', step.name, '-m', step.message, ...(step.at ? [step.at] : [])]);
        break;
      case 'push':
        // `<what>:refs/heads/<branch>` — a branch's state at this point of the story.
        git(env, dir, ['push', '-q', 'origin', `${step.what ?? 'HEAD'}:refs/heads/${step.branch}`]);
        break;
      case 'pushTags':
        git(env, dir, ['push', '-q', 'origin', '--tags']);
        break;
      case 'deleteBranch':
        git(env, dir, ['branch', '-q', '-D', step.name]);
        break;
      case 'resetBranch':
        // Moves a branch that is not checked out, e.g. main back behind its origin.
        git(env, dir, ['branch', '-q', '-f', step.name, step.to]);
        break;
      case 'fetch':
        git(env, dir, ['fetch', '-q', '--prune', '--tags', 'origin']);
        break;
      case 'track':
        git(env, dir, ['branch', '-q', `--set-upstream-to=origin/${step.upstream ?? step.name}`, step.name]);
        break;
      default:
        throw new Error(`unknown step ${JSON.stringify(step)}`);
    }
  }
}

/**
 * @param {NodeJS.ProcessEnv} env
 * @param {keyof typeof PEOPLE} who
 * @param {string} when
 */
function stamped(env, who, when) {
  const person = PEOPLE[who];
  if (!person) throw new Error(`nobody called ${who}`);
  const date = gitDate(when, who);
  return {
    ...env,
    GIT_AUTHOR_NAME: person.name,
    GIT_AUTHOR_EMAIL: person.email,
    GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_NAME: person.name,
    GIT_COMMITTER_EMAIL: person.email,
    GIT_COMMITTER_DATE: date,
  };
}

/**
 * @param {string} dir
 * @param {Record<string, string | null>} files a path's new text, or null to delete it
 */
function writeFiles(dir, files) {
  for (const [rel, text] of Object.entries(files)) {
    const file = path.join(dir, ...rel.split('/'));
    if (text === null) {
      fs.rmSync(file, { force: true });
      continue;
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  }
}

/**
 * @param {NodeJS.ProcessEnv} env
 * @param {string} cwd
 * @param {string[]} args
 * @returns {string}
 */
export function git(env, cwd, args) {
  try {
    return execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (error) {
    const err = /** @type {{ stderr?: string, stdout?: string, status?: number }} */ (error);
    throw new Error(`git ${args.join(' ')} (in ${cwd}) exited ${err.status}: ${err.stderr || err.stdout || ''}`);
  }
}
