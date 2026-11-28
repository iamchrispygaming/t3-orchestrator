import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RunRequest, Usage } from '../src/server/agent-runner.ts';
import { createServer, type Server } from '../src/server/server.ts';
import type { ModelTier, TicketState } from '../src/shared/api.ts';
import { createApiClient, type ApiClient, type EventStream } from '../src/web/api.ts';
import { approve, done, FakeAgentRunner, rateLimit, round, streaming } from './support/fake-agent-runner.ts';
import { FakeClock } from './support/fake-clock.ts';
import { FakeGitHub } from './support/fake-github.ts';
import { FakeNotifier } from './support/fake-notifier.ts';
import { commitFile, createBareRemote } from './support/git.ts';

// The default Ladder, least to most capable.
const claudeHaiku: ModelTier = { agent: 'claude', model: 'haiku', effort: 'medium' };
const codexSolLow: ModelTier = { agent: 'codex', model: 'gpt-6.2-sol', effort: 'low' };
const claudeSonnet: ModelTier = { agent: 'claude', model: 'sonnet', effort: 'medium' };
const codexSolHigh: ModelTier = { agent: 'codex', model: 'gpt-6.2-sol', effort: 'high' };

const hours = (n: number) => n * 3_600_000;

describe('usage, Cost and quota', () => {
  let root: string;
  let dataDir: string;
  let github: FakeGitHub;
  let agent: FakeAgentRunner;
  let clock: FakeClock;
  let server: Server;
  let api: ApiClient;
  let events: EventStream;
  let pump: Promise<void>;
  let seen: { issue: number; state: TicketState; tier: ModelTier }[];
  let waiters: { issue: number; state: TicketState; resolve: () => void }[];
  // What each Run streams before its result, by issue number; taken once per Run.
  let runEvents: Map<number, Parameters<typeof streaming>[0][]>;
  // Runs started, as [issue, tier].
  let started: [number, ModelTier][];
  // The usage each Run and Review reports, by issue number.
  let runUsage: Map<number, Usage>;
  let reviewUsage: Map<number, Usage>;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 't3o-test-'));
    dataDir = join(root, 'data');
    github = new FakeGitHub();
    const remoteRoot = join(root, 'remote');
    mkdirSync(remoteRoot);
    github.addRepo('acme', 'widgets', createBareRemote(remoteRoot));
    for (let n = 1; n <= 9; n++) github.addIssue('acme', 'widgets', { number: n, title: `Ticket ${n}`, body: `Do ${n}.` });
    agent = new FakeAgentRunner();
    clock = new FakeClock('2026-01-01T09:00:00.000Z');
    seen = [];
    waiters = [];
    runEvents = new Map();
    started = [];
    runUsage = new Map();
    reviewUsage = new Map();

    agent.otherwise('run', (req: RunRequest) => {
      const issue = Number(basename(req.cwd));
      started.push([issue, req.tier]);
      const scripted = runEvents.get(issue)?.shift() ?? [];
      if (scripted.some((e) => e.type === 'rate-limit' && e.status === 'rejected')) return streaming(scripted);
      commitFile(req.cwd, `issue-${issue}.txt`, `${started.length}\n`, `Work issue ${issue}`);
      return streaming(scripted, done(runUsage.has(issue) ? { usage: runUsage.get(issue)! } : {}));
    });
    agent.otherwise('review', (req: RunRequest) => {
      const issue = Number(basename(req.cwd));
      return approve(reviewUsage.has(issue) ? { usage: reviewUsage.get(issue)! } : {});
    });

    await start();
  });

  afterEach(async () => {
    await stop();
    rmSync(root, { recursive: true, force: true });
  });

  async function start() {
    server = createServer({
      env: { T3O_DATA_DIR: dataDir },
      github,
      agentRunner: agent,
      clock,
      notifier: new FakeNotifier(),
      log: () => {},
    });
    api = createApiClient((path, init) => Promise.resolve(server.app.request(path, init)));
    events = await api.events();
    expect((await events.next()).type).toBe('snapshot');
    pump = (async () => {
      for (;;) {
        const event = await events.next().catch(() => undefined);
        if (!event) return;
        if (event.type !== 'ticket') continue;
        const { issueNumber: issue, state, tier } = event.ticket;
        seen.push({ issue, state, tier });
        for (const w of waiters.filter((w) => w.issue === issue && w.state === state)) {
          waiters.splice(waiters.indexOf(w), 1);
          w.resolve();
        }
      }
    })();
  }

  async function stop() {
    await events.close();
    await pump;
    await server.close();
  }

  // Resolves on the Ticket's next arrival at `state` from now on.
  function next(issue: number, state: TicketState): Promise<void> {
    return new Promise((resolve) => waiters.push({ issue, state, resolve }));
  }

  async function addRepo() {
    return api.addTargetRepo({ owner: 'acme', name: 'widgets' });
  }

  async function register(repoId: number, issueNumber: number, tier: ModelTier = claudeHaiku) {
    const merged = next(issueNumber, 'merged');
    const ticket = await api.registerTicket({ repoId, issueNumber, tier, door: 'two-way' });
    return { ticket, merged };
  }

  async function until(condition: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!(await condition())) {
      if (Date.now() > deadline) throw new Error(`condition not met within ${timeoutMs} ms`);
      await new Promise((r) => setTimeout(r, 5));
    }
  }

  const inFuture = (ms: number) => new Date(clock.now().getTime() + ms);

  it("starts a Ticket on the other Agent's next more capable Model Tier when its Agent is near its limit", async () => {
    const repo = await addRepo();
    runEvents.set(1, [[rateLimit('claude', 'near-limit', inFuture(hours(3)))]]);
    await (await register(repo.id, 1)).merged;

    const { ticket, merged } = await register(repo.id, 2, claudeHaiku);
    await merged;

    expect(started).toEqual([
      [1, claudeHaiku],
      [2, codexSolLow],
    ]);
    expect((await api.getTicket(ticket.id)).tier).toEqual(codexSolLow);
    // From further up the Ladder, the move goes to the other Agent's next tier above.
    const sonnet = await register(repo.id, 3, claudeSonnet);
    await sonnet.merged;
    expect(started.at(-1)).toEqual([3, codexSolHigh]);
  });

  it('pauses Tickets while every Agent is near its limit and resumes them by itself when quota frees', async () => {
    const repo = await addRepo();
    runEvents.set(1, [[rateLimit('claude', 'near-limit', inFuture(hours(3)))]]);
    runEvents.set(2, [[rateLimit('codex', 'near-limit', inFuture(hours(1)))]]);
    await (await register(repo.id, 1)).merged;
    await (await register(repo.id, 2)).merged; // moved to Codex, which then nears its limit too

    const paused = next(3, 'paused');
    const { ticket, merged } = await register(repo.id, 3);
    await paused;
    expect((await api.getTicket(ticket.id)).state).toBe('paused');
    expect(started.map(([issue]) => issue)).toEqual([1, 2]);

    // Codex frees first: the Ticket resumes to Ready and moves to Codex.
    clock.advance(hours(1));
    await merged;
    const states = seen.filter((s) => s.issue === 3).map((s) => s.state);
    expect(states.filter((state, i) => state !== states[i - 1])).toEqual(['ready', 'paused', 'ready', 'running', 'reviewing', 'merged']);
    expect(started.at(-1)).toEqual([3, codexSolLow]);
  });

  it('resumes a Paused Ticket by hand at its own Model Tier, even with its Agent near its limit', async () => {
    const repo = await addRepo();
    runEvents.set(1, [[rateLimit('claude', 'near-limit', inFuture(hours(3)))]]);
    runEvents.set(2, [[rateLimit('codex', 'near-limit', inFuture(hours(3)))]]);
    await (await register(repo.id, 1)).merged;
    await (await register(repo.id, 2)).merged;
    const paused = next(3, 'paused');
    const { ticket, merged } = await register(repo.id, 3);
    await paused;

    const resumed = await api.resumeTicket(ticket.id);
    expect(resumed.state).not.toBe('paused');
    await merged;
    expect(started.at(-1)).toEqual([3, claudeHaiku]);

    // Only a Paused Ticket can be resumed.
    await expect(api.resumeTicket(ticket.id)).rejects.toThrow(/409/);
  });

  it('reruns a Run its quota stopped at the same Model Tier once that quota frees, without counting a failure', async () => {
    const repo = await addRepo();
    runEvents.set(1, [[rateLimit('claude', 'rejected', inFuture(hours(2)))]]);
    const paused = next(1, 'paused');
    const { ticket, merged } = await register(repo.id, 1);
    await paused;
    // Codex has quota, but the rerun stays on the tier the quota cut short.
    expect(started).toEqual([[1, claudeHaiku]]);

    clock.advance(hours(2));
    await merged;
    expect(started).toEqual([
      [1, claudeHaiku],
      [1, claudeHaiku],
    ]);
    const detail = await api.getTicket(ticket.id);
    expect(detail.tier).toEqual(claudeHaiku);
    expect(detail.runs.map((r) => [r.tier, r.outcome])).toEqual([
      [claudeHaiku, 'quota-hit'],
      [claudeHaiku, 'done'],
    ]);
  });

  it('keeps every Run and Review priced as Cost and tells the Planner the estimate per Model Tier, never the UI', async () => {
    const repo = await addRepo();
    // Claude reports dollars; Codex reports tokens, priced at gpt-6.2-sol's $2 in / $10 out per million.
    runUsage.set(1, { inputTokens: 50_000, outputTokens: 4_000, costUsd: 0.3 });
    reviewUsage.set(1, { inputTokens: 9_000, outputTokens: 500, costUsd: 0.05 });
    runUsage.set(2, { inputTokens: 70_000, outputTokens: 6_000, costUsd: 0.5 });
    reviewUsage.set(2, { inputTokens: 9_000, outputTokens: 500, costUsd: 0.05 });
    runUsage.set(3, { inputTokens: 100_000, outputTokens: 20_000 });
    reviewUsage.set(3, { inputTokens: 10_000, outputTokens: 1_000 });
    await (await register(repo.id, 1)).merged;
    const second = await register(repo.id, 2);
    await second.merged;
    await (await register(repo.id, 3, codexSolLow)).merged;

    // Kept across a restart: the estimate comes from everything on record.
    await stop();
    await start();
    agent.script('plan', () => round([{ question: 'Which file?', recommended: 'hello.txt' }]));
    const plan = await api.startPlan({ repoId: repo.id, idea: 'Add a greeting.' });
    await until(async () => (await api.getPlan(plan.id)).status === 'asking');

    const instructions = agent.calls.find((c) => c.mode === 'plan')!.instructions;
    expect(instructions).toContain(
      [
        'Cost so far per Model Tier (median, at API list prices):',
        '- claude:haiku/medium: $0.40 per Run (2 Runs), $0.05 per Review (2 Reviews)',
        '- codex:gpt-6.2-sol/low: $0.40 per Run (1 Run), $0.03 per Review (1 Review)',
      ].join('\n'),
    );

    // Cost and usage stay out of everything the UI reads.
    const detail = JSON.stringify(await api.getTicket(second.ticket.id));
    expect(detail).not.toMatch(/cost|usage|token/i);
  });
});
