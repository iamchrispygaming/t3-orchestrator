import type { Clock } from '../../src/server/clock.ts';

type Timer = { at: number; fire: () => unknown };

// Time moves only when a test calls advance(), which fires every timer it passes.
export class FakeClock implements Clock {
  private current: number;
  private timers = new Set<Timer>();

  constructor(start = '2026-01-01T09:00:00.000Z') {
    this.current = Date.parse(start);
  }

  now(): Date {
    return new Date(this.current);
  }

  setTimer(ms: number, fire: () => unknown): () => void {
    const timer = { at: this.current + ms, fire };
    this.timers.add(timer);
    return () => this.timers.delete(timer);
  }

  // Fires synchronously; the promise settles once whatever the fired timers returned
  // has (a timer that starts async work, like a cleanup, can return its promise).
  advance(ms: number): Promise<void> {
    this.current += ms;
    const fired: unknown[] = [];
    for (;;) {
      const due = [...this.timers].filter((t) => t.at <= this.current).sort((a, b) => a.at - b.at)[0];
      if (!due) return Promise.all(fired).then(() => undefined);
      this.timers.delete(due);
      fired.push(due.fire());
    }
  }
}
