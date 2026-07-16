/**
 * Telemetry wrapper (P10-T4) — vscode-free and CONTENT-FREE by construction.
 *
 * Two gates must BOTH allow before anything reaches the sender: VS Code's own
 * telemetry level (`envEnabled`, from vscode.env.isTelemetryEnabled) and
 * GitTree's `gittree.telemetry.enabled` (default OFF).
 *
 * The schema below is the complete event allowlist. The serializer drops
 * unknown events, strips unknown keys, and rejects any string value that
 * does not look like a short lowercase slug — repo names, absolute paths,
 * shas, commit messages and file contents all fail that shape check, so a
 * mistaken caller cannot leak them.
 *
 * NOTE (owner constraint): no telemetry backend exists for this project.
 * The production sender is a no-op that at most traces locally; wiring a
 * real `@vscode/extension-telemetry` reporter (which needs an Application
 * Insights connection string) is a drop-in replacement of `TelemetrySender`
 * for whoever provisions one. See PHASE-10 Deviations.
 */

export const TELEMETRY_SCHEMA = {
  /** Fired once per session with the sync-path activation duration bucket. */
  'activation': ['syncBucket'],
  /** First use of a feature pillar this session (constant slugs only). */
  'feature.firstUse': ['feature'],
  /** One per finished mutation: duration histogram bucket, no labels. */
  'op.duration': ['bucket', 'destructive'],
  /** Classified failure kinds (GitErrorKind values), never messages. */
  'op.errorKind': ['kind'],
} as const;

export type TelemetryEventName = keyof typeof TELEMETRY_SCHEMA;

export type TelemetryProps = Record<string, string | number | boolean>;

export interface TelemetrySender {
  send(eventName: TelemetryEventName, props: Record<string, string>): void;
}

/** Histogram buckets for durations — coarse on purpose (content-free). */
export function durationBucket(ms: number): string {
  if (ms < 100) return 'lt100ms';
  if (ms < 400) return 'lt400ms';
  if (ms < 1000) return 'lt1s';
  if (ms < 5000) return 'lt5s';
  return 'ge5s';
}

/** Short lowercase slug — what every string value must look like. */
const SLUG = /^[a-z][a-z0-9-]{0,31}$/;

/**
 * Applies the allowlist: unknown event → undefined; unknown keys stripped;
 * numbers/booleans stringified; strings must be slugs or the KEY is dropped.
 */
export function sanitizeEvent(
  name: string,
  props: TelemetryProps,
): { name: TelemetryEventName; props: Record<string, string> } | undefined {
  if (!(name in TELEMETRY_SCHEMA)) return undefined;
  const eventName = name as TelemetryEventName;
  const allowed: readonly string[] = TELEMETRY_SCHEMA[eventName];
  const out: Record<string, string> = {};
  for (const key of allowed) {
    const v = props[key];
    if (v === undefined) continue;
    if (typeof v === 'number') {
      if (Number.isFinite(v)) out[key] = String(v);
    } else if (typeof v === 'boolean') {
      out[key] = String(v);
    } else if (SLUG.test(v)) {
      out[key] = v;
    }
  }
  return { name: eventName, props: out };
}

export interface TelemetryDeps {
  /** VS Code's global telemetry consent (telemetry.telemetryLevel). */
  envEnabled(): boolean;
  /** GitTree's own opt-in (`gittree.telemetry.enabled`, default false). */
  settingEnabled(): boolean;
  sender: TelemetrySender;
  trace?(line: string): void;
}

export class Telemetry {
  private readonly firstUses = new Set<string>();

  constructor(private readonly deps: TelemetryDeps) {}

  /** @returns true when the event passed both gates and the schema. */
  event(name: TelemetryEventName, props: TelemetryProps = {}): boolean {
    if (!this.deps.envEnabled() || !this.deps.settingEnabled()) return false;
    const clean = sanitizeEvent(name, props);
    if (!clean) return false;
    this.deps.sender.send(clean.name, clean.props);
    this.deps.trace?.(`[telemetry] ${clean.name} ${JSON.stringify(clean.props)}`);
    return true;
  }

  /** Deduplicated per session; `feature` must be a constant slug. */
  featureFirstUse(feature: string): boolean {
    if (this.firstUses.has(feature)) return false;
    this.firstUses.add(feature);
    return this.event('feature.firstUse', { feature });
  }
}

/** The shipped sender: nowhere to send (no backend) — a deliberate no-op. */
export const NOOP_SENDER: TelemetrySender = {
  send: () => undefined,
};
