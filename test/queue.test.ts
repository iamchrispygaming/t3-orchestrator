import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RunRequest } from '../src/server/agent-runner.ts';
import { createServer, type Server } from '../src/server/server.ts';
import type { ModelTier, TicketState } from '../src/shared/api.ts';
import { createApiClient, type ApiClient, type EventStream } from '../src/web/api.ts';
import { approve, done, FakeAgentRunner } from './support/fake-agent-runner.ts';
import { FakeClock } from './support/fake-clock.ts';
import { FakeGitHub, type BlockerSpec } from './support/fake-github.ts';
import { FakeNotifier } from './support/fake-notifier.ts';
import { commitFile, createBareRemote } from './support/git.ts';

const claude: ModelTier = { agent: 'claude', model: 'haiku', effort: 'medium' };
const codex: ModelTier = { agent: 'codex', model: 'gpt-6.2-sol', effort: 'low' };
const minutes = (n: number) => n * 60_000;

type Gate = { issue: number; agent: string; release: () => void };

describe('blockers, queue order and per-Agent parallel slots', () => {
  let root: string;
  let github: FakeGitHub;
  let agent: FakeAgentRunner;
  let clock: FakeClock;
  let server: Server;
  let api: ApiClient;
  let events: EventStream;
  // Runs the fake Agent has started and not yet finished, by issue number.
  let open: Map<number, Gate>;
  let started: number[];
  let prBodies: Map<number, string>; // what a Run's PR body says, by issue number
  let seen: { issue: number; state: TicketState }[];
  let waiters: { issue: number; state: TicketState; resolve: () => void }[];
  let issueOf: Map<number, number>; // Ticket id -> issue number
  let pump: Promise<void>;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 't3o-test-'));
    github = new FakeGitHub();
    for (const name of ['widgets', 'gadgets']) {
      const remoteRoot = join(root, `${name}-remote`);
      mkdirSync(remoteRoot);
      github.addRepo('acme', name, createBareRemote(remoteRoot));
    }
    agent = new FakeAgentRunner();
    clock = new FakeClock('2026-01-01T09:00:00.000Z');
    open = new Map();
    started = [];
    prBodies = new Map();
    seen = [];
    waiters = [];
    issueOf = new Map();

    // Every Run holds its slot until the test releases it; every Review approves.
    agent.otherwise('run', (req: RunRequest) => {
      const issue = Number(basename(req.cwd));
      started.push(issue);
      return new Promise((resolve, reject) => {
        // Stopping the server stops the Run.
        const stop = () => {
          open.delete(issue);
          reject(new Error('stopped'));
        };
        if (req.signal.aborted) return stop();
        req.signal.addEventListener('abort', stop);
        open.set(issue, {
          issue,
          agent: req.tier.agent,
          release: () => {
            open.delete(issue);
            commitFile(req.cwd, `issue-${issue}.txt`, 'done\n', `Work issue ${issue}`);
            resolve(done(prBodies.has(issue) ? { prBody: prBodies.get(issue)! } : {}));
          },
        });
      });
    });
    agent.otherwise('review', () => approve());

    start();
    events = await api.events();
    expect((await events.next()).type).toBe('snapshot');
    pump = (async () => {
      for (;;) {
        const event = await events.next().catch(() => undefined);
        if (!event) return;
        if (event.type !== 'ticket') continue;
        const issue = event.ticket.issueNumber;
        seen.push({ issue, state: event.ticket.state });
        for (const w of waiters.filter((w) => w.issue === issue && w.state === event.ticket.state)) {
          waiters.splice(waiters.indexOf(w), 1);
          w.resolve();
        }
      }
    })();
  });

  afterEach(async () => {
    await events.close();
    await pump;
    const closing = server.close();
    github.releaseChecks();
    await closing;
    rmSync(root, { recursive: true, force: true });
  });

  function start() {
    server = createServer({
      env: { T3O_DATA_DIR: join(root, 'data') },
      github,
      agentRunner: agent,
      clock,
      notifier: new FakeNotifier(),
      log: () => {},
    });
    api = createApiClient((path, init) => Promise.resolve(server.app.request(path, init)));
  }

  async function approvePlan(req: Parameters<ApiClient['registerApprovedPlan']>[0]) {
    const plan = await api.registerApprovedPlan(req);
    for (const t of plan.tickets) issueOf.set(t.id, t.issueNumber);
    return plan;
  }

  function reached(issue: number, state: TicketState): Promise<void> {
    if (seen.some((s) => s.issue === issue && s.state === state)) return Promise.resolve();
    return new Promise((resolve) => waiters.push({ issue, state, resolve }));
  }

  // The states a Ticket went through, as the SSE stream showed them.
  const statesOf = (issue: number) => seen.filter((s) => s.issue === issue).map((s) => s.state);

  async function stateNow(issue: number): Promise<TicketState> {
    const id = [...issueOf].find(([, n]) => n === issue)![0];
    return (await api.getTicket(id)).state;
  }

  async function finish(issue: number): Promise<void> {
    await until(() => open.has(issue));
    open.get(issue)!.release();
    await reached(issue, 'merged');
  }

  // Polls with a deadline, so a scheduling regression fails here instead of hanging.
  async function until(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!condition()) {
      if (Date.now() > deadline) throw new Error(`condition not met within ${timeoutMs} ms`);
      await new Promise((r) => setTimeout(r, 5));
    }
  }

  function addIssues(repo: string, specs: { number: number; blockedBy?: BlockerSpec[] }[]) {
    for (const { number, blockedBy } of specs) {
      github.addIssue('acme', repo, { number, title: `Ticket ${number}`, body: `Do ${number}.`, blockedBy });
    }
  }

  const ticket = (issueNumber: number, tier: ModelTier = claude) => ({ issueNumber, tier, door: 'two-way' as const });

  it('keeps a blocked Ticket Waiting until every blocker is Merged, then starts it without further action', async () => {
    addIssues('widgets', [{ number: 1 }, { number: 2 }, { number: 3, blockedBy: [1, 2] }]);
    const repo = await api.addTargetRepo({ owner: 'acme', name: 'widgets' });

    await approvePlan({ repoId: repo.id, tickets: [ticket(1), ticket(2), ticket(3)] });
    expect(await stateNow(3)).toBe('waiting');

    await finish(1);
    expect(await stateNow(3)).toBe('waiting');

    await finish(2);
    await reached(3, 'running');
    expect(statesOf(3)).toEqual(['waiting', 'ready', 'running']);
    await finish(3);
    expect(started).toEqual([1, 2, 3]);
  });

  it('keeps a Ticket Waiting on a blocker whose issue was closed on GitHub without a merge', async () => {
    addIssues('widgets', [{ number: 1 }, { number: 2, blockedBy: [1] }]);
    github.closeIssue('acme', 'widgets', 1);
    const repo = await api.addTargetRepo({ owner: 'acme', name: 'widgets' });

    await approvePlan({ repoId: repo.id, tickets: [ticket(2)] });

    expect(await stateNow(2)).toBe('waiting');
    expect(started).toEqual([]);
  });

  it('waits on a blocker in another Target Repo, not on the same issue number in its own', async () => {
    addIssues('widgets', [{ number: 7 }, { number: 8, blockedBy: [{ owner: 'acme', name: 'gadgets', number: 7 }] }]);
    addIssues('gadgets', [{ number: 7 }]);
    const widgets = await api.addTargetRepo({ owner: 'acme', name: 'widgets' });
    const gadgets = await api.addTargetRepo({ owner: 'acme', name: 'gadgets' });

    await approvePlan({ repoId: widgets.id, tickets: [ticket(7), ticket(8)] });
    await finish(7); // widgets#7
    expect(await stateNow(8)).toBe('waiting');

    await approvePlan({ repoId: gadgets.id, tickets: [ticket(7)] });
    await until(() => open.has(7));
    open.get(7)!.release(); // gadgets#7
    await reached(8, 'running');
    expect(github.pulls('acme', 'gadgets')[0]?.merged).toBe(true);
  });

  it('starts a dependent whose other blocker the same merge closed', async () => {
    addIssues('widgets', [{ number: 9 }, { number: 10 }, { number: 11, blockedBy: [9, 10] }]);
    const repo = await api.addTargetRepo({ owner: 'acme', name: 'widgets' });
    prBodies.set(9, ['## Summary', 'Also does #10.', 'Closes #10'].join('\n\n'));

    await approvePlan({ repoId: repo.id, tickets: [ticket(9), ticket(11)] });
    expect(await stateNow(11)).toBe('waiting');

    await finish(9);
    await reached(11, 'running');
    expect(github.issue('acme', 'widgets', 10)?.state).toBe('closed');
  });

  it('does not wait on a blocker that is not a Ticket but was closed by a merged PR', async () => {
    addIssues('widgets', [{ number: 1 }, { number: 2, blockedBy: [1] }]);
    github.closeIssue('acme', 'widgets', 1, { byMergedPullRequest: true });
    const repo = await api.addTargetRepo({ owner: 'acme', name: 'widgets' });

    await approvePlan({ repoId: repo.id, tickets: [ticket(2)] });

    await reached(2, 'running');
    expect(statesOf(2)).toEqual(['ready', 'running']);
  });

  it("frees the Agent's slot when its Run ends, while that Ticket still waits on CI", async () => {
    addIssues('widgets', [{ number: 1 }, { number: 2 }]);
    const repo = await api.addTargetRepo({ owner: 'acme', name: 'widgets' });
    await api.updateParallelLimits({ claude: 1 });
    github.holdChecks();

    await approvePlan({ repoId: repo.id, tickets: [ticket(1), ticket(2)] });
    await until(() => open.has(1));
    expect(await stateNow(2)).toBe('ready');

    open.get(1)!.release();
    await until(() => open.has(2));
    expect(await stateNow(1)).toBe('running'); // its PR is open, CI not finished

    github.releaseChecks();
    await reached(1, 'merged');
    await finish(2);
  });

  it('runs at most the parallel limit (default 2) per Agent, counted across Target Repos', async () => {
    addIssues('widgets', [{ number: 1 }, { number: 2 }, { number: 3 }]);
    addIssues('gadgets', [{ number: 11 }, { number: 12 }, { number: 14 }]);
    const widgets = await api.addTargetRepo({ owner: 'acme', name: 'widgets' });
    const gadgets = await api.addTargetRepo({ owner: 'acme', name: 'gadgets' });
    expect(await api.getParallelLimits()).toEqual({ claude: 2, codex: 2 });

    await approvePlan({ repoId: widgets.id, tickets: [ticket(1), ticket(2), ticket(3, codex)] });
    await approvePlan({ repoId: gadgets.id, tickets: [ticket(11), ticket(12, codex), ticket(14, codex)] });

    // Two Claude slots, both taken in widgets; gadgets' Claude Ticket waits for one.
    await until(() => open.size === 4);
    expect([...open.keys()].sort((a, b) => a - b)).toEqual([1, 2, 3, 12]);
    expect(await stateNow(11)).toBe('ready');
    expect(await stateNow(14)).toBe('ready');

    // The limit is a setting: raising it starts the queued Tickets.
    expect(await api.updateParallelLimits({ claude: 3 })).toEqual({ claude: 3, codex: 2 });
    await reached(11, 'running');
    expect(await stateNow(14)).toBe('ready');

    // A freed slot goes to the next queued Ticket of that Agent.
    await finish(3);
    await until(() => open.has(14));

    const running = { claude: 0, codex: 0 };
    for (const gate of open.values()) running[gate.agent as 'claude' | 'codex']++;
    expect(running).toEqual({ claude: 3, codex: 2 });
  });

  it('keeps the parallel limit setting across a restart', async () => {
    await api.updateParallelLimits({ codex: 1 });
    await events.close();
    await pump;
    await server.close();

    start();
    events = await api.events();

    expect(await api.getParallelLimits()).toEqual({ claude: 2, codex: 1 });
  });

  it('rejects a parallel limit below 1', async () => {
    await expect(api.updateParallelLimits({ claude: 0 })).rejects.toThrow(/400/);
  });

  it('starts Ready Tickets oldest-approved Plan first, then in Plan order', async () => {
    addIssues('widgets', [
      { number: 1 },
      { number: 2 },
      { number: 13 },
      { number: 12 },
      { number: 3, blockedBy: [2] },
      { number: 21 },
    ]);
    const repo = await api.addTargetRepo({ owner: 'acme', name: 'widgets' });
    await api.updateParallelLimits({ claude: 1 });

    // Older Plan: 1 takes the only Claude slot, 2 runs on Codex, 3 waits on 2.
    const older = await approvePlan({
      repoId: repo.id,
      tickets: [ticket(1), ticket(2, codex), ticket(13), ticket(12), ticket(3)],
    });
    clock.advance(minutes(10));
    const newer = await approvePlan({ repoId: repo.id, tickets: [ticket(21)] });
    expect(Date.parse(older.approvedAt)).toBeLessThan(Date.parse(newer.approvedAt));

    // 3 becomes Ready after 21 did, but its Plan is older, so it still goes first.
    await finish(2);
    await reached(3, 'ready');
    for (const issue of [1, 13, 12, 3, 21]) await finish(issue);

    expect(started.filter((n) => n !== 2)).toEqual([1, 13, 12, 3, 21]);
  });
});
