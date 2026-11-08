/**
 * What a line-staging action says when it had nothing to do (POST-QA F1).
 * Success stays quiet, as IntelliJ's does: the bar or the diff changes in
 * front of the user the moment it finishes.
 */
import * as vscode from 'vscode';
import type { StageLinesOutcome } from './stageLines';
import { showInfo } from '../../ui/notices';

export function reportStageOutcome(outcome: StageLinesOutcome, direction: 'stage' | 'unstage' = 'stage'): void {
  if (outcome === 'notInIndex') {
    void vscode.window.showWarningMessage(
      direction === 'stage'
        ? vscode.l10n.t('This file is not in the index yet. Stage the whole file instead.')
        : vscode.l10n.t('This file has nothing staged to unstage.'),
    );
  } else if (outcome === 'nothing') {
    showInfo(
      direction === 'stage'
        ? vscode.l10n.t('Nothing to stage here: these lines already match the index.')
        : vscode.l10n.t('Nothing to unstage here: these lines are not staged.'),
    );
  }
}
