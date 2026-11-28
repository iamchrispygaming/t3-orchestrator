import type { PlanDraft, PlanQuestion } from '../../src/shared/api.ts';
import type {
  AgentRunner,
  PlanOutcome,
  ReviewOutcome,
  RunEvent,
  RunMode,
  RunOutcome,
  RunRequest,
} from '../../src/server/agent-runner.ts';

// Endings other than a result: the Agent's quota runs out, or it exits without a result.
type FakeEnding = { fake: 'quota-hit' } | { fake: 'no-result' };
type Result = RunOutcome | ReviewOutcome | PlanOutcome;
// Events the fake Agent streams first, then its result; no result means the stream
// ends without one, and `thenThrow` makes it crash after the events (a bad exit).
type Streamed = { events: RunEvent[]; result?: Result; thenThrow?: string };
type Outcome = Result | FakeEnding | Streamed;
type Handler = (req: RunRequest) => Promise<Outcome> | Outcome;

export const streaming = (events: RunEvent[], result?: Result, thenThrow?: string): Streamed => ({
  events,
  ...(result ? { result } : {}),
  ...(thenThrow ? { thenThrow } : {}),
});

// A quota reading, as the adapters report it mid-Run.
export const rateLimit = (
  agent: 'claude' | 'codex',
  status: 'allowed' | 'near-limit' | 'rejected',
  resetsAt?: Date,
): RunEvent => ({ type: 'rate-limit', agent, status, ...(resetsAt ? { resetsAt: resetsAt.toISOString() } : {}) });

const noUsage = { inputTokens: 0, outputTokens: 0 };

export const done = (over: Partial<RunOutcome> = {}): RunOutcome => ({
  kind: 'run',
  status: 'done',
  reason: '',
  prBody: '## Summary\n\nDone.',
  door: 'two-way',
  blastRadius: 'none',
  usage: noUsage,
  ...over,
});

export const approve = (over: Partial<ReviewOutcome> = {}): ReviewOutcome => ({
  kind: 'review',
  verdict: 'approve',
  findings: 'Looks good.',
  door: 'two-way',
  usage: noUsage,
  ...over,
});

// A Planner turn that asks a round of questions (and may already carry a draft).
export const round = (questions: PlanQuestion[], over: Partial<PlanOutcome> = {}): PlanOutcome => ({
  kind: 'plan',
  sessionId: 'fake-planner-session',
  message: 'A few questions first.',
  questions,
  draft: null,
  usage: noUsage,
  ...over,
});

// A Planner turn that asks nothing more and returns the draft.
export const drafted = (draft: PlanDraft, over: Partial<PlanOutcome> = {}): PlanOutcome =>
  round([], { message: 'Here is the draft.', draft, ...over });

// The quota runs out mid-Run: a `rejected` rate-limit event, then the stream ends.
export const quotaHit = (): FakeEnding => ({ fake: 'quota-hit' });
export const noResult = (): FakeEnding => ({ fake: 'no-result' });

// Never settles until the Run is aborted (time limit, server stop), then rejects like a killed process.
export const hang = (req: RunRequest): Promise<never> =>
  new Promise((_, reject) => {
    if (req.signal.aborted) reject(new Error('aborted'));
    req.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  });

export const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

type Script = {
  handler: Handler;
  // Runs as the Agent winds down, like a process exiting: after its last event,
  // when the engine closes the stream, or after an abort. It can be slow.
  shutdown?: (req: RunRequest) => Promise<void> | void;
};

// Scriptable per call: queue a handler per mode; each start() takes the next one,
// falling back to the mode's `otherwise` handler once the queue is empty.
// A handler that throws is a crash.
export class FakeAgentRunner implements AgentRunner {
  readonly calls: RunRequest[] = [];
  private queues = new Map<RunMode, Script[]>();
  private fallbacks = new Map<RunMode, Handler>();

  otherwise(mode: RunMode, handler: Handler): this {
    this.fallbacks.set(mode, handler);
    return this;
  }

  script(mode: RunMode, handler: Handler, options: Omit<Script, 'handler'> = {}): this {
    const queue = this.queues.get(mode) ?? [];
    queue.push({ handler, ...options });
    this.queues.set(mode, queue);
    return this;
  }

  async *start(req: RunRequest): AsyncIterable<RunEvent> {
    this.calls.push(req);
    const fallback = this.fallbacks.get(req.mode);
    const script: Script | undefined = this.queues.get(req.mode)?.shift() ?? (fallback && { handler: fallback });
    if (!script) throw new Error(`fake AgentRunner has no script left for a ${req.mode}`);
    try {
      yield { type: 'text', text: `fake ${req.mode} started` };
      const outcome = await script.handler(req);
      if ('events' in outcome) {
        yield* outcome.events;
        if (outcome.result) yield { type: 'result', result: outcome.result };
        if (outcome.thenThrow) throw new Error(outcome.thenThrow);
        return;
      }
      if ('fake' in outcome) {
        if (outcome.fake === 'quota-hit') yield { type: 'rate-limit', agent: req.tier.agent, status: 'rejected' };
        return;
      }
      yield { type: 'result', result: outcome };
    } finally {
      await script.shutdown?.(req);
    }
  }
}
