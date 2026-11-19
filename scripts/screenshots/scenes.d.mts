export interface Scene {
  readonly name: string;
  readonly title: string;
  readonly files: readonly string[];
  run(d: unknown): Promise<void>;
  cleanUp?(d: unknown): Promise<void>;
}
export const SCENES: readonly Scene[];
export const CHANGELISTS: readonly { readonly name: string; readonly files: Readonly<Record<string, readonly string[]>> }[];
export const COMMIT_MESSAGE: string;
export const LOG_COMMIT: string;
export const REBASE_PLAN: readonly { readonly subject: string; readonly action: string }[];
export function prepare(d: unknown): Promise<void>;
