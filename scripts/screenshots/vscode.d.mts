export const VSCODE_VERSION: string;
export const VIEWPORT: { readonly width: number; readonly height: number; readonly scale: number };
export const SETTINGS: Readonly<Record<string, unknown>>;
export function cleanEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
export function sleep(ms: number): Promise<void>;
