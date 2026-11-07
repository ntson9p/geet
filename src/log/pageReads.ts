/**
 * One Log tab session's page requests, made idempotent.
 *
 * The webview asks for page N once it holds pages 0 to N-1, and the host pages
 * on its own to reveal a commit. A request can also come twice: the RPC client
 * re-posts every request still unanswered when the view is shown again
 * (`rehydrate`), and a page read waits behind any git operation running in the
 * repository, so the read a commit started is still unanswered if the panel is
 * hidden and shown during the push after it. Read twice, a page was laid out
 * twice. The graph's lanes carried on from the first copy, the host's row store
 * held every commit twice, and the second copy replaced the first on screen.
 *
 * So a request for a page:
 * - being read waits for that read, and the rows go out once (`join`);
 * - already sent gets every row sent so far, as page 0 (`replay`);
 * - past the next one was meant for a session a reset has replaced, so
 *   nothing is read or sent (`stale`);
 * - that is the next one is read (`read`).
 *
 * vscode-free so it can be tested on its own.
 */
export type PageRequest = 'join' | 'replay' | 'stale' | 'read';

export interface PageActions {
  /** Reads `page`, sends it, and moves the session's next page on. */
  read(): Promise<void>;
  /** Sends every row the session has sent, as page 0. */
  replay(): void;
}

export class PageReads {
  private readonly inFlight = new Map<number, Promise<void>>();

  /**
   * @param nextPage the first page the session has not sent
   * @returns what the request amounted to, and when it is done
   */
  request(page: number, nextPage: number, act: PageActions): { kind: PageRequest; done: Promise<void> } {
    const running = this.inFlight.get(page);
    if (running !== undefined) return { kind: 'join', done: running };
    if (page < nextPage) {
      act.replay();
      return { kind: 'replay', done: Promise.resolve() };
    }
    if (page > nextPage) return { kind: 'stale', done: Promise.resolve() };
    const done: Promise<void> = act.read().finally(() => {
      if (this.inFlight.get(page) === done) this.inFlight.delete(page);
    });
    this.inFlight.set(page, done);
    return { kind: 'read', done };
  }

  /** Whether `page` is being read. */
  isReading(page: number): boolean {
    return this.inFlight.has(page);
  }
}
