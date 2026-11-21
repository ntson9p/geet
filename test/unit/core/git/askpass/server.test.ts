import { spawn } from 'node:child_process';
import * as net from 'node:net';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AskpassServer,
  classifyPrompt,
  type AskpassPrompt,
} from '../../../../../src/core/git/askpass/server';

const SHIM_DIR = path.join(process.cwd(), 'shims');

let servers: AskpassServer[] = [];
afterEach(() => {
  for (const s of servers) s.dispose();
  servers = [];
});

async function startServer(
  resolver: (p: AskpassPrompt) => Promise<string | undefined>,
): Promise<AskpassServer> {
  const server = await AskpassServer.start(resolver, { shimDir: SHIM_DIR });
  servers.push(server);
  return server;
}

/** Acts exactly like the shim: one JSON line out, one JSON line back. */
function pipeRequest(pipe: string, payload: unknown): Promise<{ ok: boolean; value?: string; error?: string }> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(pipe);
    socket.setEncoding('utf8');
    let buffer = '';
    socket.on('connect', () => socket.write(JSON.stringify(payload) + '\n'));
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      const idx = buffer.indexOf('\n');
      if (idx !== -1) {
        socket.destroy();
        resolve(JSON.parse(buffer.slice(0, idx)) as { ok: boolean; value?: string; error?: string });
      }
    });
    socket.on('error', reject);
  });
}

describe('classifyPrompt', () => {
  it('classifies username prompts with host', () => {
    expect(classifyPrompt("Username for 'https://github.com': ")).toEqual({
      prompt: "Username for 'https://github.com': ",
      kind: 'username',
      host: 'https://github.com',
    });
  });
  it('classifies password prompts with host', () => {
    expect(classifyPrompt("Password for 'https://bob@gitlab.example.com': ").kind).toBe('password');
    expect(classifyPrompt("Password for 'https://bob@gitlab.example.com': ").host).toBe(
      'https://bob@gitlab.example.com',
    );
  });
  it('classifies everything else as other', () => {
    expect(classifyPrompt("Enter passphrase for key '/home/u/.ssh/id_ed25519': ").kind).toBe('other');
  });
});

describe('AskpassServer pipe protocol', () => {
  it('round-trips username and password through a mock client', async () => {
    const seen: AskpassPrompt[] = [];
    const server = await startServer((p) => {
      seen.push(p);
      return Promise.resolve(p.kind === 'username' ? 'testuser' : 's3cret');
    });
    const u = await pipeRequest(server.pipe, {
      v: 1,
      token: server.authToken,
      prompt: "Username for 'https://example.com': ",
    });
    expect(u).toEqual({ ok: true, value: 'testuser' });
    const p = await pipeRequest(server.pipe, {
      v: 1,
      token: server.authToken,
      prompt: "Password for 'https://example.com': ",
    });
    expect(p).toEqual({ ok: true, value: 's3cret' });
    expect(seen.map((s) => s.kind)).toEqual(['username', 'password']);
    expect(seen[0]?.host).toBe('https://example.com');
  });

  it('rejects a bad token without calling the resolver', async () => {
    let calls = 0;
    const server = await startServer(() => {
      calls++;
      return Promise.resolve('nope');
    });
    const res = await pipeRequest(server.pipe, { v: 1, token: 'wrong', prompt: 'Username' });
    expect(res.ok).toBe(false);
    expect(res.error).toBe('unauthorized');
    expect(calls).toBe(0);
  });

  it('denies when the resolver returns undefined or throws', async () => {
    const server = await startServer(() => Promise.resolve(undefined));
    expect((await pipeRequest(server.pipe, { v: 1, token: server.authToken, prompt: 'x' })).ok).toBe(false);

    const failing = await startServer(() => Promise.reject(new Error('boom')));
    const res = await pipeRequest(failing.pipe, { v: 1, token: failing.authToken, prompt: 'x' });
    expect(res.ok).toBe(false);
    expect(res.error).toBe('resolver failed');
  });

  it('answers malformed requests with an error instead of hanging', async () => {
    const server = await startServer(() => Promise.resolve('x'));
    const raw = await new Promise<string>((resolve, reject) => {
      const socket = net.connect(server.pipe);
      socket.setEncoding('utf8');
      let buf = '';
      socket.on('connect', () => socket.write('this is not json\n'));
      socket.on('data', (c: string) => {
        buf += c;
        if (buf.includes('\n')) {
          socket.destroy();
          resolve(buf);
        }
      });
      socket.on('error', reject);
    });
    expect((JSON.parse(raw) as { ok: boolean }).ok).toBe(false);
  });

  it('drives the real askpass.cjs shim end to end', async () => {
    const server = await startServer((p) =>
      Promise.resolve(p.kind === 'username' ? 'shimuser' : undefined),
    );
    const run = (prompt: string): Promise<{ code: number; stdout: string }> =>
      new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [path.join(SHIM_DIR, 'askpass.cjs'), prompt], {
          env: {
            ...process.env,
            GEET_ASKPASS_PIPE: server.pipe,
            GEET_ASKPASS_TOKEN: server.authToken,
          },
        });
        let stdout = '';
        child.stdout.on('data', (c: Buffer) => (stdout += c.toString()));
        child.on('error', reject);
        child.on('close', (code) => resolve({ code: code ?? -1, stdout }));
      });

    const ok = await run("Username for 'https://example.com': ");
    expect(ok.code).toBe(0);
    expect(ok.stdout).toBe('shimuser\n');

    const denied = await run("Password for 'https://example.com': ");
    expect(denied.code).toBe(1);
    expect(denied.stdout).toBe('');
  });
});
