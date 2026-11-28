import type {
  AgentRunner,
  ReviewOutcome,
  RunEvent,
  RunMode,
  RunOutcome,
  RunRequest,
} from '../../src/server/agent-runner.ts';

type Handler = (req: RunRequest) => Promise<RunOutcome | ReviewOutcome> | RunOutcome | ReviewOutcome;

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

// Scriptable per call: queue a handler per mode; each start() takes the next one.
export class FakeAgentRunner implements AgentRunner {
  readonly calls: RunRequest[] = [];
  private queues = new Map<RunMode, Handler[]>();

  script(mode: RunMode, handler: Handler): this {
    const queue = this.queues.get(mode) ?? [];
    queue.push(handler);
    this.queues.set(mode, queue);
    return this;
  }

  async *start(req: RunRequest): AsyncIterable<RunEvent> {
    this.calls.push(req);
    const handler = this.queues.get(req.mode)?.shift();
    if (!handler) throw new Error(`fake AgentRunner has no script left for a ${req.mode}`);
    yield { type: 'text', text: `fake ${req.mode} started` };
    yield { type: 'result', result: await handler(req) };
  }
}
