/**
 * Askpass bridge server (master §4 credentials): a token-authenticated named
 * pipe (Windows) / unix socket that the shims/askpass.cjs shim connects to.
 * Each connection carries one JSON-line request {v, token, prompt} and gets
 * one JSON-line response {ok, value?}.
 *
 * vscode-free: credential resolution is injected (vscode wiring in
 * credentialResolver.ts) so the wire protocol is unit-testable.
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Disposable } from '../../util/events';

export type AskpassPromptKind = 'username' | 'password' | 'other';

export interface AskpassPrompt {
  /** Raw prompt text from git, e.g. `Username for 'https://github.com': `. */
  prompt: string;
  kind: AskpassPromptKind;
  /** Host part when the prompt names one, e.g. `https://github.com`. */
  host?: string;
}

/** Resolves a prompt to an answer; undefined denies (git aborts auth). */
export type CredentialResolver = (prompt: AskpassPrompt) => Promise<string | undefined>;

export interface AskpassServerOptions {
  /** Directory containing askpass.sh/.cmd/.cjs. */
  shimDir: string;
  trace?: (line: string) => void;
}

export function classifyPrompt(prompt: string): AskpassPrompt {
  const username = /^Username for '([^']+)'/.exec(prompt);
  if (username?.[1] !== undefined) return { prompt, kind: 'username', host: username[1] };
  const password = /^Password for '([^']+)'/.exec(prompt);
  if (password?.[1] !== undefined) return { prompt, kind: 'password', host: password[1] };
  return { prompt, kind: 'other' };
}

export class AskpassServer implements Disposable {
  private constructor(
    private readonly server: net.Server,
    private readonly pipePath: string,
    private readonly token: string,
    private readonly options: AskpassServerOptions,
  ) {}

  static start(resolver: CredentialResolver, options: AskpassServerOptions): Promise<AskpassServer> {
    const nonce = crypto.randomBytes(8).toString('hex');
    const token = crypto.randomBytes(16).toString('hex');
    const pipePath =
      process.platform === 'win32'
        ? `\\\\.\\pipe\\geet-askpass-${nonce}`
        : path.join(os.tmpdir(), `geet-askpass-${nonce}.sock`);
    const trace = options.trace ?? (() => undefined);

    const server = net.createServer((socket) => {
      socket.setEncoding('utf8');
      let buffer = '';
      let handled = false;
      const deny = (error?: string): void => {
        if (socket.writable) socket.end(JSON.stringify({ ok: false, error }) + '\n');
        else socket.destroy();
      };
      socket.on('error', () => socket.destroy());
      socket.on('data', (chunk: string) => {
        if (handled) return;
        buffer += chunk;
        if (buffer.length > 64 * 1024) {
          handled = true;
          socket.destroy();
          return;
        }
        const idx = buffer.indexOf('\n');
        if (idx === -1) return;
        handled = true;
        let request: { token?: unknown; prompt?: unknown };
        try {
          request = JSON.parse(buffer.slice(0, idx)) as { token?: unknown; prompt?: unknown };
        } catch {
          deny('bad request');
          return;
        }
        if (typeof request.token !== 'string' || !timingSafeEquals(request.token, token)) {
          trace('askpass: rejected request with bad token');
          deny('unauthorized');
          return;
        }
        const promptText = typeof request.prompt === 'string' ? request.prompt : '';
        const classified = classifyPrompt(promptText);
        trace(`askpass: ${classified.kind} prompt for ${classified.host ?? '<unknown>'}`);
        resolver(classified).then(
          (value) => {
            if (value === undefined) {
              deny();
            } else if (socket.writable) {
              socket.end(JSON.stringify({ ok: true, value }) + '\n');
            }
          },
          (err: unknown) => {
            trace(`askpass: resolver failed: ${String(err)}`);
            deny('resolver failed');
          },
        );
      });
    });

    return new Promise<AskpassServer>((resolve, reject) => {
      server.once('error', reject);
      server.listen(pipePath, () => {
        server.removeListener('error', reject);
        if (process.platform !== 'win32') {
          try {
            fs.chmodSync(pipePath, 0o600);
            // Launcher scripts may lose their exec bit through packaging.
            for (const shim of ['askpass.sh', 'askpass.cjs']) {
              fs.chmodSync(path.join(options.shimDir, shim), 0o755);
            }
          } catch {
            // best effort
          }
        }
        resolve(new AskpassServer(server, pipePath, token, options));
      });
    });
  }

  /** Environment for every git spawn (executor baseEnv) — master P0-T8 step 1. */
  get env(): Record<string, string> {
    return {
      GIT_ASKPASS: path.join(this.options.shimDir, 'askpass.sh'),
      GEET_ASKPASS_PIPE: this.pipePath,
      GEET_ASKPASS_TOKEN: this.token,
      ELECTRON_RUN_AS_NODE: '1',
      VSCODE_GEET_NODE: process.execPath,
    };
  }

  get pipe(): string {
    return this.pipePath;
  }

  /** Test hook: the shared secret, needed by the mock pipe client tests. */
  get authToken(): string {
    return this.token;
  }

  dispose(): void {
    this.server.close();
    if (process.platform !== 'win32') {
      try {
        fs.unlinkSync(this.pipePath);
      } catch {
        // already gone
      }
    }
  }
}

function timingSafeEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}
