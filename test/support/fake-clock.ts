import type { Clock } from '../../src/server/clock.ts';

type Timer = { at: number; fire: () => void };

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

  setTimer(ms: number, fire: () => void): () => void {
    const timer = { at: this.current + ms, fire };
    this.timers.add(timer);
    return () => this.timers.delete(timer);
  }

  advance(ms: number): void {
    this.current += ms;
    for (;;) {
      const due = [...this.timers].filter((t) => t.at <= this.current).sort((a, b) => a.at - b.at)[0];
      if (!due) return;
      this.timers.delete(due);
      due.fire();
    }
  }
}
