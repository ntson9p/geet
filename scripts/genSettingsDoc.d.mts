/** Hand-written declarations for genSettingsDoc.mjs (used by the vitest gate). */
export interface ConfigurationProperty {
  type?: string | string[];
  description?: string;
  default?: unknown;
  enum?: unknown[];
  enumDescriptions?: string[];
  minimum?: number;
  scope?: string;
}

export interface ConfigurationSection {
  title: string;
  properties: Record<string, ConfigurationProperty>;
}

export interface SettingsPackage {
  contributes: { configuration: ConfigurationSection[] };
}

export function generateSettingsDoc(pkg: SettingsPackage, strings: Record<string, string>): string;
export function loadInputs(rootDir: string): { pkg: SettingsPackage; strings: Record<string, string> };
