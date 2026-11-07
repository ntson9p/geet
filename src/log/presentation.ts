/**
 * The settings behind the Git tool window's presentation menus: the Commits
 * pane's `Presentation Settings ▾` (Graph, Compact References View, Tag Names,
 * References on the Left, Columns ▸ Author · Hash · Date) and the Branches
 * pane's `Branches Pane Settings · Show Tags` — plus two that only the Settings
 * editor changes, the Date column's format and the filter dropdowns' look.
 * Nothing here imports `vscode`, so the rules are unit-testable;
 * `LogViewProvider` does the reading and writing.
 */
import {
  LOG_DATE_FORMATS,
  LOG_FILTER_CHIPS,
  type LogPresentationDto,
  type LogPresentationToggle,
} from '../shared/protocol';
import { settingScope } from '../ui/settingScope';

/** A setting a menu row turns on and off. */
export type PresentationKey = LogPresentationToggle;

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
  // IntelliJ keeps these with Tag Names, IDE-wide (`VcsLogApplicationSettings`),
  // the visible columns included.
  compactReferences: { section: 'gittree.log', key: 'compactReferences', scope: 'global' },
  referencesOnLeft: { section: 'gittree.log', key: 'referencesOnLeft', scope: 'global' },
  showAuthorColumn: { section: 'gittree.log', key: 'columns.author', scope: 'global' },
  showDateColumn: { section: 'gittree.log', key: 'columns.date', scope: 'global' },
  showHashColumn: { section: 'gittree.log', key: 'columns.hash', scope: 'global' },
  // GitTree's own, kept with the columns it sits beside.
  showGraph: { section: 'gittree.log', key: 'showGraph', scope: 'global' },
};

/** A presentation setting that is one of a few values rather than on or off. */
export type PresentationChoiceKey = Exclude<keyof LogPresentationDto, PresentationKey>;

export interface PresentationChoice {
  readonly section: string;
  readonly key: string;
  readonly values: readonly string[];
}

/** Changed in the Settings editor only: no menu offers them. */
export const PRESENTATION_CHOICES: Readonly<Record<PresentationChoiceKey, PresentationChoice>> = {
  dateFormat: { section: 'gittree.log', key: 'dateFormat', values: LOG_DATE_FORMATS },
  filterChips: { section: 'gittree.log', key: 'filterChips', values: LOG_FILTER_CHIPS },
};

/** The full setting id behind a presentation key, e.g. `gittree.log.columns.hash`. */
export function settingId(name: PresentationKey | PresentationChoiceKey): string {
  const { section, key } =
    name in PRESENTATION_SETTINGS
      ? PRESENTATION_SETTINGS[name as PresentationKey]
      : PRESENTATION_CHOICES[name as PresentationChoiceKey];
  return `${section}.${key}`;
}

/** Every setting a view draws from: a change to any of them is pushed to it. */
export function presentationSettingIds(): string[] {
  return [
    ...(Object.keys(PRESENTATION_SETTINGS) as PresentationKey[]),
    ...(Object.keys(PRESENTATION_CHOICES) as PresentationChoiceKey[]),
  ].map(settingId);
}

/**
 * The presentation the settings describe. `read` gives a setting's effective
 * value; one of the wrong type, or a value the setting does not offer (a typo
 * in settings.json), falls back to the default rather than reaching a view.
 */
export function readPresentation(
  read: (section: string, key: string) => unknown,
  defaults: LogPresentationDto,
): LogPresentationDto {
  const out: LogPresentationDto = { ...defaults };
  for (const name of Object.keys(PRESENTATION_SETTINGS) as PresentationKey[]) {
    const { section, key } = PRESENTATION_SETTINGS[name];
    const value = read(section, key);
    if (typeof value === 'boolean') out[name] = value;
  }
  const choice = (name: PresentationChoiceKey): string | undefined => {
    const { section, key, values } = PRESENTATION_CHOICES[name];
    const value = read(section, key);
    return typeof value === 'string' && values.includes(value) ? value : undefined;
  };
  const dateFormat = choice('dateFormat');
  if (dateFormat !== undefined) out.dateFormat = dateFormat as LogPresentationDto['dateFormat'];
  const filterChips = choice('filterChips');
  if (filterChips !== undefined) out.filterChips = filterChips as LogPresentationDto['filterChips'];
  return out;
}

/** The parts of `WorkspaceConfiguration.inspect()` the choice depends on. */
export interface InspectedSetting {
  readonly globalValue?: unknown;
  readonly workspaceValue?: unknown;
}

/**
 * The scope a menu toggle writes to. A workspace that already holds a value
 * keeps it, or the effective value would stay where it was and the checkbox
 * would look dead. Anything else goes to the user's own settings — never a new
 * value in the repository's `.vscode/settings.json` (POST-QA), whatever scope
 * the setting is listed with.
 */
export function writeScope(
  inspected: InspectedSetting | undefined,
  _preferred: 'global' | 'workspace',
  hasWorkspace: boolean,
): 'global' | 'workspace' {
  return hasWorkspace && settingScope(inspected) === 'workspace' ? 'workspace' : 'global';
}

/**
 * What a `log/setPresentation` request may change: known toggles with boolean
 * values. The two choices are the Settings editor's alone.
 */
export function presentationPatch(params: unknown): Partial<Pick<LogPresentationDto, PresentationKey>> {
  const patch: Partial<Pick<LogPresentationDto, PresentationKey>> = {};
  if (params === null || typeof params !== 'object') return patch;
  const p = params as Record<string, unknown>;
  for (const key of Object.keys(PRESENTATION_SETTINGS) as PresentationKey[]) {
    const value = p[key];
    if (typeof value === 'boolean') patch[key] = value;
  }
  return patch;
}
