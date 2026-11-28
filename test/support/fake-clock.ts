import type { Clock } from '../../src/server/clock.ts';

export class FakeClock implements Clock {
  private current: number;

  constructor(start = '2026-01-01T09:00:00.000Z') {
    this.current = Date.parse(start);
  }

  now(): Date {
    return new Date(this.current);
  }

  advance(ms: number): void {
    this.current += ms;
  }
}
