/**
 * vscode-side credential resolution for askpass prompts (master P0-T8 step 2):
 * github.com HTTPS → vscode.authentication GitHub session; otherwise
 * SecretStorage, then an input box with an optional "remember" follow-up.
 * Answers are cached per host for the session.
 */
import * as vscode from 'vscode';
import type { AskpassPrompt, CredentialResolver } from './server';

interface HostCredentials {
  username?: string;
  password?: string;
}

const SECRET_PREFIX = 'geet.credential.';

export function createCredentialResolver(
  context: vscode.ExtensionContext,
  trace: (line: string) => void,
): CredentialResolver {
  const sessionCache = new Map<string, HostCredentials>();

  return async (prompt: AskpassPrompt): Promise<string | undefined> => {
    const host = prompt.host ?? '';
    if (prompt.kind === 'other') {
      // ssh passphrases and exotic prompts: straight to the user.
      return vscode.window.showInputBox({
        prompt: prompt.prompt,
        password: true,
        ignoreFocusOut: true,
      });
    }

    const cached = sessionCache.get(host) ?? {};
    const cachedValue = prompt.kind === 'username' ? cached.username : cached.password;
    if (cachedValue !== undefined) return cachedValue;

    // GitHub HTTPS: answer both prompts from the built-in auth provider.
    if (isGitHubHost(host)) {
      try {
        const session = await vscode.authentication.getSession('github', ['repo'], {
          createIfNone: true,
        });
        if (session) {
          const creds: HostCredentials = { username: 'x-access-token', password: session.accessToken };
          sessionCache.set(host, creds);
          return prompt.kind === 'username' ? creds.username : creds.password;
        }
      } catch (err) {
        trace(`askpass: github auth session unavailable (${String(err)}), falling back`);
      }
    }

    // Stored credentials.
    const secret = await context.secrets.get(SECRET_PREFIX + host);
    if (secret !== undefined) {
      try {
        const stored = JSON.parse(secret) as HostCredentials;
        const value = prompt.kind === 'username' ? stored.username : stored.password;
        if (value !== undefined) {
          sessionCache.set(host, { ...sessionCache.get(host), ...stored });
          return value;
        }
      } catch {
        // corrupt entry — ignore
      }
    }

    // Ask the user.
    const value = await vscode.window.showInputBox({
      prompt: prompt.prompt,
      password: prompt.kind === 'password',
      ignoreFocusOut: true,
      placeHolder: host,
    });
    if (value === undefined) return undefined;
    const updated: HostCredentials = { ...sessionCache.get(host) };
    if (prompt.kind === 'username') updated.username = value;
    else updated.password = value;
    sessionCache.set(host, updated);

    if (prompt.kind === 'password' && host.length > 0) {
      // Non-blocking remember offer.
      const remember = vscode.l10n.t('Remember');
      void vscode.window
        .showInformationMessage(vscode.l10n.t('Remember credentials for {0}?', host), remember)
        .then(async (choice) => {
          if (choice === remember) {
            await context.secrets.store(SECRET_PREFIX + host, JSON.stringify(updated));
          }
        });
    }
    return value;
  };
}

function isGitHubHost(host: string): boolean {
  try {
    const url = new URL(host);
    return (
      url.protocol === 'https:' &&
      (url.hostname === 'github.com' || url.hostname.endsWith('.github.com'))
    );
  } catch {
    return false;
  }
}
