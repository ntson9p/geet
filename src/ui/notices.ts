/**
 * GitTree's plain notices (new-way-6): an information message with nothing to
 * click — *Fetch successful*, *Checked out main*, *Nothing to stash.* — shown
 * for `gittree.notifications.durationSeconds` while VS Code is in front, then
 * gone. `noticeTiming.ts` says how long, and why GitTree keeps the time
 * itself rather than leave it to VS Code.
 *
 * The price: VS Code cannot hide a notification on a timer and keep it in the
 * notification centre, and a progress notification leaves when it ends. So a
 * notice shown this way is written to GitTree's output instead (`setNoticeLog`).
 * Setting the time to 0 shows ordinary notifications again, which VS Code
 * hides on its own and keeps in the centre.
 *
 * Messages with buttons, warnings and errors are always ordinary
 * notifications: they ask for a decision, or say something went wrong.
 */
import * as vscode from 'vscode';
import { afterFocusedTime, noticeDurationMs, noticeLogLine, noticeSeconds, type WindowFocus } from './noticeTiming';

let log: ((line: string) => void) | undefined;

/** Where a timed notice is written down, since it leaves no entry in the notification centre. */
export function setNoticeLog(sink: ((line: string) => void) | undefined): void {
  log = sink;
}

const windowFocus: WindowFocus = {
  get focused() {
    return vscode.window.state.focused;
  },
  onDidChange: (listener) => vscode.window.onDidChangeWindowState((state) => listener(state.focused)),
};

/** The setting, read when a notice is shown: a change applies to the next one. */
function durationSeconds(): number {
  return noticeSeconds(vscode.workspace.getConfiguration('gittree.notifications').get<unknown>('durationSeconds'));
}

/**
 * Says `message`, an information message with no buttons: what GitTree says
 * when something you did is done, or had nothing to do. Not awaited: there is
 * nothing to answer.
 */
export function showInfo(message: string): void {
  const seconds = durationSeconds();
  if (seconds === 0) {
    void vscode.window.showInformationMessage(message);
    return;
  }
  log?.(noticeLogLine(message, new Date()));
  void vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: message },
    async (progress) => {
      // At 0% there is no bar to see. Left alone, a progress notification
      // draws the moving bar of work under way, which a notice of work done is not.
      progress.report({ increment: 0 });
      await afterFocusedTime(noticeDurationMs(message, seconds), windowFocus);
    },
  );
}
