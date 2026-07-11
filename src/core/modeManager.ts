/**
 * ModeManager (master §3): owns the coexistence strategy with the built-in
 * git extension. State machine: unset → prompt-once → takeover | companion.
 * `git.enabled` is written ONLY on explicit takeover consent (Marketplace
 * policy), and restored when the user leaves takeover mode.
 *
 * vscode-free: persistence, dialog and settings writes are injected
 * (wired in core.ts) so the state machine is unit-testable.
 */
import { Emitter, type Event } from './util/events';

export type GitTreeMode = 'unset' | 'takeover' | 'companion';
export type ConsentChoice = 'takeover' | 'companion' | 'later';

export interface ModeManagerDeps {
  /** workspaceState-backed persisted decision. */
  getPersisted(): Exclude<GitTreeMode, 'unset'> | undefined;
  persist(mode: Exclude<GitTreeMode, 'unset'>): Promise<void> | void;
  /** Explicit `gittree.mode` setting; undefined when "auto". */
  getSettingOverride(): Exclude<GitTreeMode, 'unset'> | undefined;
  /** One-time modal: "Use GitTree" / "Keep both" / dismiss = later. */
  showConsentDialog(): Promise<ConsentChoice>;
  /** Writes `git.enabled` at workspace scope; undefined removes the override. */
  setBuiltinGitEnabled(enabled: boolean | undefined): Promise<void>;
  trace?(line: string): void;
}

export class ModeManager {
  private _mode: GitTreeMode;
  private promptedThisSession = false;
  private readonly _onDidChangeMode = new Emitter<GitTreeMode>();
  readonly onDidChangeMode: Event<GitTreeMode> = this._onDidChangeMode.event;

  constructor(private readonly deps: ModeManagerDeps) {
    this._mode = deps.getSettingOverride() ?? deps.getPersisted() ?? 'unset';
  }

  get mode(): GitTreeMode {
    return this._mode;
  }

  /**
   * What UI-registering modules act on: while undecided, behave as companion
   * (never disturb the built-in experience without consent, §3).
   */
  get effectiveMode(): 'takeover' | 'companion' {
    return this._mode === 'takeover' ? 'takeover' : 'companion';
  }

  /**
   * Shows the one-time consent modal if no decision exists. "Later" leaves
   * the state unset (re-prompted next session, not this one) and performs no
   * writes of any kind.
   */
  async ensurePrompted(): Promise<void> {
    if (this._mode !== 'unset' || this.promptedThisSession) return;
    this.promptedThisSession = true;
    const choice = await this.deps.showConsentDialog();
    if (choice === 'later') {
      this.deps.trace?.('mode consent deferred (later)');
      return;
    }
    await this.adopt(choice);
  }

  /** Applies an explicit decision (consent dialog, setting change, command). */
  async adopt(mode: Exclude<GitTreeMode, 'unset'>): Promise<void> {
    const prev = this._mode;
    if (mode === 'takeover') {
      // Consent given — flip the built-in off first; if that write fails we
      // don't persist, so the state stays consistent.
      await this.deps.setBuiltinGitEnabled(false);
    } else if (prev === 'takeover') {
      // Leaving takeover: hand the workspace back to the built-in extension.
      await this.deps.setBuiltinGitEnabled(undefined);
    }
    await this.deps.persist(mode);
    this._mode = mode;
    if (prev !== mode) {
      this.deps.trace?.(`mode: ${prev} → ${mode}`);
      this._onDidChangeMode.fire(mode);
    }
  }

  /** Config-change hook: an explicit gittree.mode edit is explicit consent. */
  async refreshFromSetting(): Promise<void> {
    const override = this.deps.getSettingOverride();
    if (override !== undefined && override !== this._mode) {
      await this.adopt(override);
    }
  }

  dispose(): void {
    this._onDidChangeMode.dispose();
  }
}
