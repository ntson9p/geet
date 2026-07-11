/**
 * Minimal typed event/disposable primitives, shape-compatible with the vscode
 * API (an Event<T> is a function taking a listener and returning a
 * Disposable). Lives outside vscode so the domain core stays unit-testable.
 */

export interface Disposable {
  dispose(): void;
}

export type Event<T> = (listener: (e: T) => void) => Disposable;

export class Emitter<T> implements Disposable {
  private listeners = new Set<(e: T) => void>();
  private disposed = false;

  readonly event: Event<T> = (listener) => {
    if (this.disposed) return { dispose: () => undefined };
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  };

  fire(e: T): void {
    if (this.disposed) return;
    for (const l of [...this.listeners]) {
      try {
        l(e);
      } catch (err) {
        // A misbehaving listener must not break other subscribers.
        console.error('GitTree: event listener threw', err);
      }
    }
  }

  dispose(): void {
    this.disposed = true;
    this.listeners.clear();
  }
}

export class DisposableStore implements Disposable {
  private items: Disposable[] = [];
  private disposed = false;

  add<T extends Disposable>(d: T): T {
    if (this.disposed) {
      d.dispose();
    } else {
      this.items.push(d);
    }
    return d;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const items = this.items;
    this.items = [];
    for (let i = items.length - 1; i >= 0; i--) {
      try {
        items[i]?.dispose();
      } catch (err) {
        console.error('GitTree: dispose threw', err);
      }
    }
  }
}
