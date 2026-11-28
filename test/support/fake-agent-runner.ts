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

type Outcome = RunOutcome | ReviewOutcome | PlanOutcome;
// Events the fake Agent streams before its result; no result means the stream ends without one.
type Streamed = { events: RunEvent[]; result?: Outcome };
type Handler = (req: RunRequest) => Promise<Outcome | Streamed> | Outcome | Streamed;

// A Run that streams `events` first, then ends with `result` (or with no result).
export const streaming = (events: RunEvent[], result?: Outcome): Streamed => (result ? { events, result } : { events });

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

// Scriptable per call: queue a handler per mode; each start() takes the next one,
// falling back to the mode's `otherwise` handler once the queue is empty.
export class FakeAgentRunner implements AgentRunner {
  readonly calls: RunRequest[] = [];
  private queues = new Map<RunMode, Handler[]>();
  private fallbacks = new Map<RunMode, Handler>();

  otherwise(mode: RunMode, handler: Handler): this {
    this.fallbacks.set(mode, handler);
    return this;
  }

  script(mode: RunMode, handler: Handler): this {
    const queue = this.queues.get(mode) ?? [];
    queue.push(handler);
    this.queues.set(mode, queue);
    return this;
  }

  async *start(req: RunRequest): AsyncIterable<RunEvent> {
    this.calls.push(req);
    const handler = this.queues.get(req.mode)?.shift() ?? this.fallbacks.get(req.mode);
    if (!handler) throw new Error(`fake AgentRunner has no script left for a ${req.mode}`);
    yield { type: 'text', text: `fake ${req.mode} started` };
    const outcome = await handler(req);
    if (!('events' in outcome)) {
      yield { type: 'result', result: outcome };
      return;
    }
    yield* outcome.events;
    if (outcome.result) yield { type: 'result', result: outcome.result };
  }
}
