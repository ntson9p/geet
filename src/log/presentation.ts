/**
 * The settings behind the Git tool window's two ref-presentation menus: the
 * Commits pane's `Presentation Settings ▾ · Tag Names` and the Branches pane's
 * `Branches Pane Settings · Show Tags`. Nothing here imports `vscode`, so the
 * rules are unit-testable; `LogViewProvider` does the reading and writing.
 */
import type { LogPresentationDto } from '../shared/protocol';

export type PresentationKey = keyof LogPresentationDto;

export interface PresentationSetting {
  readonly section: string;
  readonly key: string;
  /**
   * Where a toggle writes when no scope holds a value yet. IntelliJ keeps Tag
   * Names IDE-wide (it sits in Settings, under Version Control › Log) and Show
   * Tags with the project, so the first toggle lands in the same place.
   */
  readonly scope: 'global' | 'workspace';
}

export const PRESENTATION_SETTINGS: Readonly<Record<PresentationKey, PresentationSetting>> = {
  showTagNames: { section: 'gittree.log', key: 'showTagNames', scope: 'global' },
  showTags: { section: 'gittree.branches', key: 'showTags', scope: 'workspace' },
};

/** The parts of `WorkspaceConfiguration.inspect()` the choice depends on. */
export interface InspectedSetting {
  readonly globalValue?: unknown;
  readonly workspaceValue?: unknown;
}

/**
 * The scope a menu toggle writes to. A scope that already holds a value wins,
 * the more specific one first: writing anywhere less specific would leave the
 * effective value where it was, and the checkbox would look dead.
 */
export function writeScope(
  inspected: InspectedSetting | undefined,
  preferred: 'global' | 'workspace',
  hasWorkspace: boolean,
): 'global' | 'workspace' {
  if (hasWorkspace && inspected?.workspaceValue !== undefined) return 'workspace';
  if (inspected?.globalValue !== undefined) return 'global';
  // Workspace settings need a workspace; without one, the user's own settings
  // are the only place left.
  return preferred === 'workspace' && hasWorkspace ? 'workspace' : 'global';
}

/** What a `log/setPresentation` request may change: known keys with boolean values. */
export function presentationPatch(params: unknown): Partial<LogPresentationDto> {
  const patch: Partial<LogPresentationDto> = {};
  if (params === null || typeof params !== 'object') return patch;
  const p = params as Record<string, unknown>;
  for (const key of Object.keys(PRESENTATION_SETTINGS) as PresentationKey[]) {
    const value = p[key];
    if (typeof value === 'boolean') patch[key] = value;
  }
  return patch;
}
