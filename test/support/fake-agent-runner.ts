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
type Handler = (req: RunRequest) => Promise<Outcome> | Outcome;

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
    yield { type: 'result', result: await handler(req) };
  }
}
