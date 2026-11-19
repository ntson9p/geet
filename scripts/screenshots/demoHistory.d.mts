export type Step =
  | { op: 'commit'; who: string; when: string; message: string; files: Record<string, string | null> }
  | { op: 'branch'; name: string; from?: string }
  | { op: 'checkout'; name: string }
  | { op: 'merge'; name: string; who: string; when: string; message: string }
  | { op: 'tag'; name: string; who: string; when: string; message: string; at?: string }
  | { op: 'push'; branch: string; what?: string }
  | { op: 'pushTags' }
  | { op: 'deleteBranch'; name: string }
  | { op: 'resetBranch'; name: string; to: string }
  | { op: 'fetch' }
  | { op: 'track'; name: string; upstream?: string };
export function text(strings: TemplateStringsArray, ...values: unknown[]): string;
export const HISTORY: Readonly<Record<string, readonly Step[]>>;
export const WORKING_TREE: Readonly<Record<string, Readonly<Record<string, string>>>>;
export const CONFLICT: { readonly repo: string; readonly branch: string; readonly file: string };
export const SHOWCASE_FILE: { readonly repo: string; readonly file: string };
