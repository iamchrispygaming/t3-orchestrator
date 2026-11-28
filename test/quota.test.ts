import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

  // The Planner's first turn, once the Plan is asking.
  async function plannerInstructions(repoId: number): Promise<string> {
    agent.script('plan', () => round([{ question: 'Which file?', recommended: 'hello.txt' }]));
    const plan = await api.startPlan({ repoId, idea: 'Add a greeting.' });
    await until(async () => (await api.getPlan(plan.id)).status === 'asking');
    return agent.calls.filter((c) => c.mode === 'plan').at(-1)!.instructions;
  }

  it('keeps every Run and Review priced as Cost and gives the Planner relative Cost per Model Tier, never dollars', async () => {
    const repo = await addRepo();
    // Claude reports dollars; Codex reports tokens, priced at gpt-6.2-sol's $2 in / $10 out per million.
    runUsage.set(1, { inputTokens: 50_000, outputTokens: 4_000, costUsd: 0.3 });
    reviewUsage.set(1, { inputTokens: 9_000, outputTokens: 500, costUsd: 0.06 });
    runUsage.set(2, { inputTokens: 70_000, outputTokens: 6_000, costUsd: 0.5 });
    reviewUsage.set(2, { inputTokens: 9_000, outputTokens: 500, costUsd: 0.06 });
    runUsage.set(3, { inputTokens: 200_000, outputTokens: 40_000 }); // $0.80
    reviewUsage.set(3, { inputTokens: 20_000, outputTokens: 2_000 }); // $0.06
    await (await register(repo.id, 1)).merged;
    const second = await register(repo.id, 2);
    await second.merged;
    await (await register(repo.id, 3, codexSolLow)).merged;

    // Kept across a restart: the estimate comes from everything on record.
    await stop();
    await start();
    const instructions = await plannerInstructions(repo.id);

    // Medians against the cheapest Run on record (claude:haiku at $0.40).
    expect(instructions).toContain(
      [
        'Relative Cost per Model Tier so far, as multiples of the cheapest Run on record. Use it to pick the cheapest capable tier; never repeat these figures to the user.',
        '- claude:haiku/medium: Run 1×, Review 0.15×',
        '- codex:gpt-6.2-sol/low: Run 2×, Review 0.15×',
      ].join('\n'),
    );
    // No dollar amounts or token counts reach the Planner, so it can't echo them into the Plan.
    expect(instructions).not.toMatch(/\$|token|0\.[0-9]+ ?usd/i);

    // Cost and usage stay out of everything the UI reads.
    const detail = JSON.stringify(await api.getTicket(second.ticket.id));
    expect(detail).not.toMatch(/cost|usage|token/i);
  });

  it('keeps the usage a Run reported when its quota ran out', async () => {
    const repo = await addRepo();
    agent.script('run', (req) => {
      started.push([1, req.tier]);
      return streaming(
        [rateLimit('claude', 'rejected', inFuture(hours(2)))],
        done({ status: 'failed', usage: { inputTokens: 300_000, outputTokens: 20_000, costUsd: 2 } }),
      );
    });
    const paused = next(1, 'paused');
    await register(repo.id, 1);
    await paused;
    runUsage.set(2, { inputTokens: 100_000, outputTokens: 20_000 }); // $0.40
    await (await register(repo.id, 2, codexSolLow)).merged;

    const instructions = await plannerInstructions(repo.id);
    expect(instructions).toContain('- claude:haiku/medium: Run 5×\n');
    expect(instructions).toContain('- codex:gpt-6.2-sol/low: Run 1×');
  });

  it('counts a quota rejection as the outcome even when the Agent then exits with an error', async () => {
    const repo = await addRepo();
    agent.script('run', (req) => {
      started.push([1, req.tier]);
      return streaming([rateLimit('claude', 'rejected', inFuture(hours(2)))], undefined, 'claude exited with code 1');
    });
    const paused = next(1, 'paused');
    const { ticket, merged } = await register(repo.id, 1);
    await paused;
    expect((await api.getTicket(ticket.id)).runs.map((r) => [r.tier, r.outcome])).toEqual([[claudeHaiku, 'quota-hit']]);

    clock.advance(hours(2));
    await merged;
    expect(started).toEqual([
      [1, claudeHaiku],
      [1, claudeHaiku],
    ]);
    expect((await api.getTicket(ticket.id)).runs.map((r) => r.outcome)).toEqual(['quota-hit', 'done']);
  });

  it("leaves a Paused Ticket's worktree and the user's edits in it alone", async () => {
    const repo = await addRepo();
    let worktree = '';
    agent.script('run', (req) => {
      worktree = req.cwd;
      started.push([1, req.tier]);
      writeFileSync(join(req.cwd, 'partial.txt'), 'half done\n');
      return streaming([rateLimit('claude', 'rejected', inFuture(hours(2)))]);
    });
    const paused = next(1, 'paused');
    await register(repo.id, 1);
    await paused;
    writeFileSync(join(worktree, 'mine.txt'), 'my edit\n');

    // Other work moves around it while it waits: a Claude Ticket moves to Codex.
    const other = await register(repo.id, 2);
    await other.merged;
    clock.advance(hours(1));

    expect(readFileSync(join(worktree, 'partial.txt'), 'utf8')).toBe('half done\n');
    expect(readFileSync(join(worktree, 'mine.txt'), 'utf8')).toBe('my edit\n');
    expect(started).toEqual([
      [1, claudeHaiku],
      [2, codexSolLow],
    ]);
    expect(existsSync(worktree)).toBe(true);
  });

  it('decides Routing again when quota changes while the worktree is being prepared', async () => {
    const repo = await addRepo();
    // Ticket 1 starts first and reports both Agents near their limit as soon as it
    // runs: Ticket 2 already holds a Claude slot and is still preparing its worktree.
    runEvents.set(1, [[rateLimit('claude', 'near-limit', inFuture(hours(3))), rateLimit('codex', 'near-limit', inFuture(hours(3)))]]);
    const paused = next(2, 'paused');
    const merged = next(1, 'merged');
    await api.registerApprovedPlan({
      repoId: repo.id,
      tickets: [
        { issueNumber: 1, tier: claudeHaiku, door: 'two-way' },
        { issueNumber: 2, tier: claudeHaiku, door: 'two-way' },
      ],
    });
    await merged;
    await paused;

    expect(started).toEqual([[1, claudeHaiku]]);
    const states = seen.filter((s) => s.issue === 2).map((s) => s.state);
    expect(states.filter((state, i) => state !== states[i - 1])).toEqual(['ready', 'running', 'ready', 'paused']);
  });
});
