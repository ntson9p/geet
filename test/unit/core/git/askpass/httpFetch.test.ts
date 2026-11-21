import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AskpassServer, type AskpassPrompt } from '../../../../../src/core/git/askpass/server';
import { GitError } from '../../../../../src/core/git/errors';
import { createGitExecutor, type GitExecutorImpl } from '../../../../../src/core/git/executor';

/**
 * P0-T8 acceptance: an https-style fetch against a token-protected local
 * fixture remote succeeds without any terminal prompt — credentials flow
 * git → askpass.sh → askpass.cjs → pipe → resolver.
 *
 * The remote is a bare repo served over git's dumb-HTTP protocol by a plain
 * node server enforcing Basic auth.
 */

const USER = 'testuser';
const PASS = 'p@ss w0rd+special';

let scratch: string;
let httpServer: http.Server;
let url: string;
let askpass: AskpassServer;
let prompts: AskpassPrompt[] = [];

function sh(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' },
  });
}

beforeAll(async () => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'geet-askpass-e2e-'));

  // Upstream repo with one commit → bare "remote" prepared for dumb HTTP.
  const work = path.join(scratch, 'work');
  fs.mkdirSync(work);
  sh(work, 'init');
  sh(work, 'config', 'user.email', 't@t.dev');
  sh(work, 'config', 'user.name', 'T');
  sh(work, 'config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(work, 'f.txt'), 'hello\n');
  sh(work, 'add', '.');
  sh(work, 'commit', '-m', 'served commit');
  const bare = path.join(scratch, 'remote.git');
  sh(scratch, 'clone', '--bare', work, bare);
  sh(bare, 'update-server-info');

  // Static file server over the bare repo, Basic-auth protected.
  const expected = 'Basic ' + Buffer.from(`${USER}:${PASS}`).toString('base64');
  httpServer = http.createServer((req, res) => {
    if (req.headers.authorization !== expected) {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="geet-test"' });
      res.end('auth required');
      return;
    }
    // Strip the smart-HTTP service query: a plain-text response makes git
    // fall back to the dumb protocol these files serve.
    const rel = decodeURIComponent(
      (req.url ?? '/').split('?')[0]?.replace(/^\/remote\.git/, '') ?? '/',
    );
    const file = path.join(bare, rel);
    if (!path.resolve(file).startsWith(path.resolve(bare)) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  await new Promise<void>((r) => httpServer.listen(0, '127.0.0.1', r));
  const address = httpServer.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  url = `http://127.0.0.1:${address.port}/remote.git`;

  askpass = await AskpassServer.start(
    (p) => {
      prompts.push(p);
      return Promise.resolve(p.kind === 'username' ? USER : p.kind === 'password' ? PASS : undefined);
    },
    { shimDir: path.join(process.cwd(), 'shims') },
  );
}, 60_000);

afterAll(() => {
  askpass?.dispose();
  httpServer?.close();
  try {
    fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    /* tmp */
  }
});

async function makeConsumer(git: GitExecutorImpl): Promise<string> {
  const consumer = path.join(scratch, `consumer-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(consumer);
  await git.exec(consumer, ['init']);
  return consumer;
}

/** Neutralize any configured credential helper (Git for Windows ships GCM). */
const NO_HELPER = ['-c', 'credential.helper='];

describe('askpass end-to-end with real git over authed HTTP', () => {
  it('fetch succeeds without terminal prompts, credentials via askpass', async () => {
    prompts = [];
    const git = await createGitExecutor({}, { baseEnv: () => askpass.env });
    expect(git).toBeDefined();
    const consumer = await makeConsumer(git!);
    const result = await git!.exec(
      consumer,
      [...NO_HELPER, 'fetch', url, 'HEAD'],
      { env: { GIT_CONFIG_NOSYSTEM: '1' } },
    );
    expect(result.exitCode).toBe(0);
    expect(prompts.map((p) => p.kind)).toEqual(['username', 'password']);
    // The fetched tip must actually exist locally now.
    const head = await git!.exec(consumer, ['rev-parse', 'FETCH_HEAD']);
    expect(head.stdout.trim()).toMatch(/^[0-9a-f]{40}$/);
  }, 60_000);

  it('without the askpass bridge the same fetch fails as a classified auth error', async () => {
    const git = await createGitExecutor({});
    expect(git).toBeDefined();
    const consumer = await makeConsumer(git!);
    const err = await git!
      .exec(consumer, [...NO_HELPER, 'fetch', url, 'HEAD'], {
        env: { GIT_CONFIG_NOSYSTEM: '1' },
      })
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    expect(err).toBeInstanceOf(GitError);
    expect((err as GitError).kind).toBe('auth');
  }, 60_000);
});
