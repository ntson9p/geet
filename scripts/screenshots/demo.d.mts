export interface Person {
  readonly name: string;
  readonly email: string;
  readonly tz: string;
}
export const PEOPLE: Readonly<Record<'ava' | 'diego' | 'mei' | 'noah' | 'samir' | 'zara', Person>>;
export const ME: 'ava';
export const REMOTE_BASE: string;
export const WORKSPACE_NAME: string;
export function gitEnv(root: string, base?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
export function gitConfigText(remotes: string): string;
export function gitDate(when: string, who: keyof typeof PEOPLE): string;
export function defaultWorkFolder(platform?: NodeJS.Platform, env?: NodeJS.ProcessEnv, tmp?: string): string;
export function clearDemoFolder(dir: string): void;
export interface Demo {
  readonly root: string;
  readonly workspace: string;
  readonly remotes: string;
  readonly repos: Record<string, string>;
  readonly env: NodeJS.ProcessEnv;
}
export function buildDemo(root: string): Demo;
export function git(env: NodeJS.ProcessEnv, cwd: string, args: string[]): string;
