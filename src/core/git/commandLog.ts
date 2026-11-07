/**
 * Structured git-command ring (P12-T8): every executor run — argv, exit code,
 * duration, output head — for the Console tab. The `GitTree` output channel
 * stays as-is; this is a structured mirror, capped at 2000 entries.
 *
 * Redaction is mandatory and happens BEFORE anything enters the buffer:
 * URL userinfo (`https://user:token@host` → `https://***@host`), askpass
 * handshake/token values, and `--author=` identities. vscode-free and
 * unit-tested.
 */
import { Emitter, type Event } from '../util/events';

export interface CommandRun {
  ts: number;
  argv: readonly string[];
  exitCode: number;
  durationMs: number;
  stdout: string;
  stderr: string;
  /** The repository root it ran for. */
  repo?: string;
}

export interface CommandLogEntry {
  seq: number;
  ts: number;
  argv: string[];
  exitCode: number;
  durationMs: number;
  /** Redacted stderr+stdout head. */
  output: string;
  /** The repository root it ran for (POST-QA: the Console names it, as IntelliJ's `[root]`). */
  repo?: string;
}

const OUTPUT_HEAD = 2000;
const DEFAULT_LIMIT = 2000;

/** Redacts one text blob: URL userinfo, askpass values, author identities. */
export function redactText(text: string): string {
  return (
    text
      // scheme://user[:secret]@host → scheme://***@host
      .replace(/((?:https?|ftps?|ssh):\/\/)[^/@\s]+(?::[^/@\s]*)?@/gi, '$1***@')
      // ASKPASS-ish env/handshake values: VAR=secret, token=secret, token: secret
      .replace(/([A-Z_]*ASKPASS[A-Z_]*[=:]\s*)\S+/gi, '$1***')
      .replace(/((?:token|password|secret)[=:]\s*)\S+/gi, '$1***')
      // --author=Name <email> (single argv token or inside a line)
      .replace(/--author=[^\n]*?(?=(\s--|\s-[a-zA-Z]|\n|$))/g, '--author=***')
  );
}

export function redactArgv(argv: readonly string[]): string[] {
  return argv.map((a) => {
    if (a.startsWith('--author=')) return '--author=***';
    return redactText(a);
  });
}

/**
 * Entries as the Console shows them: each one's repository by name, as
 * IntelliJ's console says `[root] git …` (POST-QA), where `nameOf` knows it —
 * with one repository open it names none, there being nothing to tell apart.
 */
export function withRepoNames(
  entries: readonly CommandLogEntry[],
  nameOf: (root: string) => string | undefined,
): CommandLogEntry[] {
  return entries.map((e) => {
    if (e.repo === undefined) return e;
    const { repo, ...rest } = e;
    const name = nameOf(repo);
    return name !== undefined ? { ...rest, repo: name } : rest;
  });
}

export class CommandLog {
  private readonly buffer: CommandLogEntry[] = [];
  private seq = 0;
  private readonly _onDidChange = new Emitter<void>();
  readonly onDidChange: Event<void> = this._onDidChange.event;

  constructor(private readonly limit = DEFAULT_LIMIT) {}

  push(run: CommandRun): void {
    const head = `${run.stderr}${run.stderr.length > 0 && run.stdout.length > 0 ? '\n' : ''}${run.stdout}`;
    const entry: CommandLogEntry = {
      seq: ++this.seq,
      ts: run.ts,
      argv: redactArgv(run.argv),
      exitCode: run.exitCode,
      durationMs: run.durationMs,
      output: redactText(head.slice(0, OUTPUT_HEAD)),
      ...(run.repo !== undefined ? { repo: run.repo } : {}),
    };
    this.buffer.push(entry);
    if (this.buffer.length > this.limit) {
      this.buffer.splice(0, this.buffer.length - this.limit);
    }
    this._onDidChange.fire();
  }

  entries(): readonly CommandLogEntry[] {
    return this.buffer;
  }

  /** Delta read for the webview: everything newer than `seq`. */
  entriesAfter(seq: number): CommandLogEntry[] {
    return this.buffer.filter((e) => e.seq > seq);
  }

  get size(): number {
    return this.buffer.length;
  }

  clear(): void {
    this.buffer.length = 0;
    this._onDidChange.fire();
  }

  dispose(): void {
    this._onDidChange.dispose();
  }
}
