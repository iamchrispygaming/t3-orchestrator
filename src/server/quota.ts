// The quota component: the last quota reading per Agent, from the rate-limit
// events Runs and Reviews stream (Claude's in-session events today; the Codex
// adapter adds its readings later through the same event). It tells the engine
// which Agents are near their limit and calls back when one frees up.
import type { Agent } from '../shared/api.ts';
import type { RunEvent } from './agent-runner.ts';
import type { Clock } from './clock.ts';
import type { Store } from './store.ts';

export type QuotaReading = Omit<Extract<RunEvent, { type: 'rate-limit' }>, 'type' | 'agent'> & { seenAt: string };

// A near-limit or rejected reading without a reset time holds for one rolling
// usage window, the longest the subscriptions' short window lasts.
export const HOLD_WITHOUT_RESET_MS = 5 * 3_600_000;
const MAX_TIMER_MS = 2 ** 31 - 1; // setTimeout's limit; a longer wait re-arms

const AGENTS: Agent[] = ['claude', 'codex'];

export class Quota {
  private timers = new Map<Agent, () => void>();
  private store: Store;
  private clock: Clock;
  private onFreed: () => void;

  constructor(store: Store, clock: Clock, onFreed: () => void) {
    this.store = store;
    this.clock = clock;
    this.onFreed = onFreed;
  }

  // Arms a timer for every stored reading still in force (after a restart).
  start(): void {
    for (const agent of AGENTS) this.arm(agent);
  }

  stop(): void {
    for (const cancel of this.timers.values()) cancel();
    this.timers.clear();
  }

  record(event: Extract<RunEvent, { type: 'rate-limit' }>): void {
    const wasLimited = this.nearLimit(event.agent);
    const { type: _type, agent, ...reading } = event;
    this.store.setQuotaReading(agent, { ...reading, seenAt: this.clock.now().toISOString() });
    this.arm(agent);
    if (wasLimited && !this.nearLimit(agent)) this.onFreed();
  }

  // Near limit until the reading's reset time (or the fallback hold) passes, or an
  // `allowed` reading replaces it.
  nearLimit(agent: Agent): boolean {
    const freesAt = this.freesAt(agent);
    return freesAt !== undefined && this.clock.now().getTime() < freesAt;
  }

  private freesAt(agent: Agent): number | undefined {
    const reading = this.store.getQuotaReading(agent);
    if (!reading || reading.status === 'allowed') return undefined;
    return reading.resetsAt ? Date.parse(reading.resetsAt) : Date.parse(reading.seenAt) + HOLD_WITHOUT_RESET_MS;
  }

  private arm(agent: Agent): void {
    this.timers.get(agent)?.();
    this.timers.delete(agent);
    if (!this.nearLimit(agent)) return;
    const wait = this.freesAt(agent)! - this.clock.now().getTime();
    const cancel = this.clock.setTimer(Math.min(wait, MAX_TIMER_MS), () => {
      this.timers.delete(agent);
      if (this.nearLimit(agent)) this.arm(agent);
      else this.onFreed();
    });
    this.timers.set(agent, cancel);
  }
}
