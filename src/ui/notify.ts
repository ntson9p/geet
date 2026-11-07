/**
 * Completion notifications (POST-P14ap) — IntelliJ's `VcsNotifier.notifySuccess`:
 * when an operation the user started has finished, one sentence says what it
 * did, in IntelliJ's words — *Fetch successful*, *Checked out main*, *Deleted
 * branch feature* — with the follow-up actions IntelliJ puts on it (`Restore`,
 * `Undo`, …).
 *
 * Before this, many GitTree operations finished in silence: the status-bar
 * spinner stopped and nothing said whether anything had happened. Background
 * work the user did not start (auto-fetch, refreshes) stays silent, as it is
 * in IntelliJ.
 *
 * Every notification raised here is also recorded, so integration tests can
 * read what the user was told (`recentNotifications`, exposed through the
 * `notifications` debug registry). `GITTREE_TEST_NOTIFICATION_ACTION` names an
 * action to run as if clicked — a toast cannot be clicked from a test.
 *
 * An operation run in several repositories at once says it once, as IntelliJ's
 * multi-root operations do: `collectNotifications` gathers what each
 * repository's run would have said, and `showCollected` says it together.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import * as vscode from 'vscode';
import { joinMessages } from '../scm/resultMessages';

/** A button on the notification, and what it does. */
export interface NotificationAction {
  readonly title: string;
  readonly run: () => unknown;
}

export interface RecordedNotification {
  readonly kind: 'info' | 'warning';
  readonly message: string;
  /** The action titles offered, in order. */
  readonly actions: readonly string[];
}

const RECENT_LIMIT = 100;
const recent: RecordedNotification[] = [];

function record(kind: RecordedNotification['kind'], message: string, actions: readonly NotificationAction[]): void {
  recent.push({ kind, message, actions: actions.map((a) => a.title) });
  if (recent.length > RECENT_LIMIT) recent.splice(0, recent.length - RECENT_LIMIT);
}

/** Runs an action, saying so when it fails — a click must never fail in silence. */
async function runAction(action: NotificationAction): Promise<void> {
  try {
    await action.run();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    void vscode.window.showErrorMessage(
      vscode.l10n.t('{0} failed: {1}', action.title, message.split('\n', 1)[0] ?? message),
    );
  }
}

/** A notification held back by `collectNotifications`. */
export interface CollectedNotification {
  readonly kind: RecordedNotification['kind'];
  readonly message: string;
  readonly actions: readonly NotificationAction[];
}

/**
 * The collector of the run in progress, scoped to that run's own async calls —
 * an unrelated operation finishing meanwhile still speaks for itself.
 */
const collecting = new AsyncLocalStorage<CollectedNotification[]>();

/** Runs `run`, holding back the notifications it raises; the caller decides what to say. */
export async function collectNotifications<T>(
  run: () => Promise<T>,
): Promise<{ result: T; collected: CollectedNotification[] }> {
  const collected: CollectedNotification[] = [];
  const result = await collecting.run(collected, run);
  return { result, collected };
}

/**
 * Says what was collected, once: the same message from every repository is
 * one notification (`Checked out develop`), different ones are joined. A
 * notification's actions survive only when it stands alone — `Restore` on
 * a summary of five deletions could not say which branch it restores.
 */
export function showCollected(collected: readonly CollectedNotification[]): void {
  if (collected.length === 0) return;
  if (collected.length === 1) {
    const only = collected[0]!;
    show(only.kind, only.message, only.actions);
    return;
  }
  const kind = collected.some((c) => c.kind === 'warning') ? 'warning' : 'info';
  show(kind, joinMessages(collected.map((c) => c.message)), []);
}

function show(
  kind: RecordedNotification['kind'],
  message: string,
  actions: readonly NotificationAction[],
): void {
  const collector = collecting.getStore();
  if (collector !== undefined) {
    collector.push({ kind, message, actions });
    return;
  }
  record(kind, message, actions);
  const seeded = process.env['GITTREE_TEST_NOTIFICATION_ACTION'];
  const picked = seeded !== undefined ? actions.find((a) => a.title === seeded) : undefined;
  if (picked) {
    void runAction(picked);
    return;
  }
  const titles = actions.map((a) => a.title);
  // Not awaited by callers: a notification with buttons stays pending until it
  // is dismissed, and the operation it reports has already finished.
  const shown =
    kind === 'warning'
      ? vscode.window.showWarningMessage(message, ...titles)
      : vscode.window.showInformationMessage(message, ...titles);
  void shown.then((choice) => {
    const action = actions.find((a) => a.title === choice);
    if (action) void runAction(action);
  });
}

/** An operation the user started went through. */
export function notifySuccess(message: string, ...actions: NotificationAction[]): void {
  show('info', message, actions);
}

/** It went through, with something the user should look at. */
export function notifyWarning(message: string, ...actions: NotificationAction[]): void {
  show('warning', message, actions);
}

/** Test seam: what was said, oldest first. */
export function recentNotifications(): readonly RecordedNotification[] {
  return [...recent];
}

/** Test seam: forget it, so a test reads only what its own action said. */
export function clearRecentNotifications(): void {
  recent.length = 0;
}

/** What the `notifications` debug registry exposes to integration tests. */
export interface NotificationsRegistry {
  recent: typeof recentNotifications;
  clear: typeof clearRecentNotifications;
}

export const notificationsRegistry: NotificationsRegistry = {
  recent: recentNotifications,
  clear: clearRecentNotifications,
};

/**
 * A notification's button clicked after what it offered has happened — from
 * the notification centre, say, once the operation it was about went on
 * without it (POST-QA): said in the status bar, not acted on.
 */
export function staleNotice(): void {
  void vscode.window.setStatusBarMessage(vscode.l10n.t('That has already been done.'), 4000);
}
