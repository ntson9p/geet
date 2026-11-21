/**
 * Onboarding wiring (P10-T3): walkthrough opener, playground generator and
 * the per-minor "What's new" notification. Called from
 * registerPhase10Hardening — P10 keeps a single phase entry point (§0.6).
 */
import * as vscode from 'vscode';
import type { Core } from '../core/core';
import type { Telemetry } from '../core/telemetry';
import { generatePlayground } from './playground';
import { walkthroughId } from './walkthrough';
import { maybeShowWhatsNew } from './whatsNew';

export interface OnboardingDebugHooks {
  generatePlayground: () => Promise<string | undefined>;
}

export function registerOnboarding(
  context: vscode.ExtensionContext,
  core: Core,
  telemetry?: Telemetry,
): OnboardingDebugHooks {
  context.subscriptions.push(
    vscode.commands.registerCommand('geet.openWalkthrough', () => {
      telemetry?.featureFirstUse('walkthrough');
      return vscode.commands.executeCommand(
        'workbench.action.openWalkthrough',
        walkthroughId(context.extension.id),
        false,
      );
    }),
    vscode.commands.registerCommand('geet.generatePlayground', () => {
      telemetry?.featureFirstUse('playground');
      return generatePlayground(core);
    }),
  );

  void maybeShowWhatsNew(context);

  return { generatePlayground: () => generatePlayground(core) };
}
