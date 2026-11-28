// What the dashboard reads from the API: live Agent output, the Run and Review
// story behind a Ticket, and the built web UI itself.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { createServer, type Server } from '../src/server/server.ts';
import type { ModelTier, ServerEvent, TicketDetail } from '../src/shared/api.ts';
import { createApiClient, type EventStream } from '../src/web/api.ts';
import { approve, done, FakeAgentRunner } from './support/fake-agent-runner.ts';
import { FakeClock } from './support/fake-clock.ts';
import { FakeGitHub } from './support/fake-github.ts';
import { commitFile, createBareRemote } from './support/git.ts';

const tier: ModelTier = { agent: 'claude', model: 'haiku', effort: 'medium' };

describe('the dashboard API', () => {
  let root: string;
  let github: FakeGitHub;
  let agent: FakeAgentRunner;
  let servers: Server[];

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 't3o-test-'));
    github = new FakeGitHub();
    github.addRepo('acme', 'widgets', createBareRemote(root));
    github.addIssue('acme', 'widgets', { number: 7, title: 'Add a greeting file', body: 'Write hello.txt.' });
    agent = new FakeAgentRunner();
    servers = [];
  });

  afterEach(async () => {
    for (const server of servers) await server.close();
    rmSync(root, { recursive: true, force: true });
  });

  function start(extra: { webRoot?: string } = {}) {
    const server = createServer({
      env: { T3O_DATA_DIR: join(root, 'data') },
      github,
      agentRunner: agent,
      clock: new FakeClock(),
      log: () => {},
      ...extra,
    });
    servers.push(server);
    const api = createApiClient((path, init) => Promise.resolve(server.app.request(path, init)));
    return { api, request: (path: string) => Promise.resolve(server.app.request(path)) };
  }

  async function nextMatching<E extends ServerEvent>(events: EventStream, match: (e: ServerEvent) => e is E) {
    for (;;) {
      const event = await events.next();
      if (match(event)) return event;
    }
  }

  it("streams the running Agent's output lines over SSE, tagged with the Ticket", async () => {
    agent.script('run', (req) => {
      commitFile(req.cwd, 'hello.txt', 'hello\n', 'Add hello.txt');
      return done();
    });
    agent.script('review', () => approve());
    const { api } = start();
    const repo = await api.addTargetRepo({ owner: 'acme', name: 'widgets' });
    const events = await api.events();

    const ticket = await api.registerTicket({ repoId: repo.id, issueNumber: 7, tier, door: 'two-way' });
    const output = await nextMatching(events, (e): e is Extract<ServerEvent, { type: 'output' }> => e.type === 'output');
    await events.close();

    expect(output).toEqual({ type: 'output', ticketId: ticket.id, text: 'fake run started' });
  });

  it('names each Ticket\'s Target Repo, so a card can link to its PR', async () => {
    agent.script('run', (req) => {
      commitFile(req.cwd, 'hello.txt', 'hello\n', 'Add hello.txt');
      return done();
    });
    agent.script('review', () => approve());
    const { api } = start();

    await runToMerged(api);

    const snapshot = await (await api.events()).next();
    expect(snapshot).toMatchObject({
      type: 'snapshot',
      tickets: [expect.objectContaining({ repo: 'acme/widgets', prNumber: github.pulls('acme', 'widgets')[0]?.number })],
    });
  });

  // What a drawer does: on each Ticket event for its Ticket, refetch the detail.
  async function untilDetailShows(
    api: ReturnType<typeof start>['api'],
    events: EventStream,
    ticketId: number,
    shows: (detail: TicketDetail) => boolean,
  ): Promise<TicketDetail> {
    for (;;) {
      await nextMatching(
        events,
        (e): e is Extract<ServerEvent, { type: 'ticket' }> => e.type === 'ticket' && e.ticket.id === ticketId,
      );
      const detail = await api.getTicket(ticketId);
      if (shows(detail)) return detail;
    }
  }

  it('announces each Run and Review starting and ending, and the PR opening, with a Ticket event', async () => {
    const runGo = Promise.withResolvers<void>();
    const reviewGo = Promise.withResolvers<void>();
    onTestFinished(() => {
      runGo.resolve();
      reviewGo.resolve();
      github.releaseChecks();
    });
    agent.script('run', async (req) => {
      await runGo.promise;
      commitFile(req.cwd, 'hello.txt', 'hello\n', 'Add hello.txt');
      return done();
    });
    agent.script('review', async () => {
      await reviewGo.promise;
      return approve({ verdict: 'changes-needed', findings: 'Missing a test.' });
    });
    github.holdChecks();
    const { api } = start();
    const repo = await api.addTargetRepo({ owner: 'acme', name: 'widgets' });
    const events = await api.events();
    const { id } = await api.registerTicket({ repoId: repo.id, issueNumber: 7, tier, door: 'two-way' });

    await untilDetailShows(api, events, id, (d) => d.runs.length === 1 && d.runs[0]!.endedAt === null);
    runGo.resolve();
    await untilDetailShows(api, events, id, (d) => d.runs[0]!.outcome === 'done');
    const opened = await untilDetailShows(api, events, id, (d) => d.prNumber !== null);
    github.releaseChecks();
    await untilDetailShows(api, events, id, (d) => d.reviews.length === 1 && d.reviews[0]!.verdict === null);
    reviewGo.resolve();
    const reviewed = await untilDetailShows(api, events, id, (d) => d.reviews[0]!.verdict === 'changes-needed');
    await events.close();

    expect(opened.prNumber).toBe(github.pulls('acme', 'widgets')[0]?.number);
    expect(reviewed.reviews[0]?.findings).toBe('Missing a test.');
  }, 10_000);

  async function runToMerged(api: ReturnType<typeof start>['api']) {
    const repo = await api.addTargetRepo({ owner: 'acme', name: 'widgets' });
    const events = await api.events();
    const ticket = await api.registerTicket({ repoId: repo.id, issueNumber: 7, tier, door: 'two-way' });
    await nextMatching(
      events,
      (e): e is Extract<ServerEvent, { type: 'ticket' }> => e.type === 'ticket' && e.ticket.state === 'merged',
    );
    await events.close();
    return ticket;
  }

  it("gives a Ticket's output so far with its detail, so a drawer opened late still shows all of it", async () => {
    agent.script('run', (req) => {
      commitFile(req.cwd, 'hello.txt', 'hello\n', 'Add hello.txt');
      return done();
    });
    agent.script('review', () => approve());
    const { api } = start();

    const ticket = await runToMerged(api);

    expect((await api.getTicket(ticket.id)).output).toEqual(['fake run started', 'fake review started']);
  });

  it('says in the Run history why a Run failed', async () => {
    agent.script('run', () => done({ status: 'failed', reason: 'The 10k-row test times out.' }));
    const { api } = start();
    const repo = await api.addTargetRepo({ owner: 'acme', name: 'widgets' });

    const ticket = await api.registerTicket({ repoId: repo.id, issueNumber: 7, tier, door: 'two-way' });

    await vi.waitFor(async () => {
      expect((await api.getTicket(ticket.id)).runs).toEqual([
        expect.objectContaining({ tier, outcome: 'failed', reason: 'The 10k-row test times out.' }),
      ]);
    });
  });

  it('leaves the reason empty for a Run that succeeded, and shows each Review with its findings', async () => {
    agent.script('run', (req) => {
      commitFile(req.cwd, 'hello.txt', 'hello\n', 'Add hello.txt');
      return done({ reason: '' });
    });
    agent.script('review', () => approve({ findings: 'Clear and tested.' }));
    const { api } = start();

    const ticket = await runToMerged(api);

    const detail = await api.getTicket(ticket.id);
    expect(detail.runs).toEqual([expect.objectContaining({ outcome: 'done', reason: null })]);
    expect(detail.reviews).toEqual([expect.objectContaining({ verdict: 'approve', findings: 'Clear and tested.' })]);
  });

  describe('serving the built web UI', () => {
    let webRoot: string;

    beforeEach(() => {
      webRoot = join(root, 'web');
      mkdirSync(join(webRoot, 'assets'), { recursive: true });
      writeFileSync(join(webRoot, 'index.html'), '<!doctype html><title>T3 Orchestrator</title>');
      writeFileSync(join(webRoot, 'assets', 'app.js'), 'console.log("app")');
      writeFileSync(join(root, 'secret.txt'), 'not for the browser');
    });

    it('serves the dashboard page at / and its assets beside it', async () => {
      const { request } = start({ webRoot });

      const page = await request('/');
      const script = await request('/assets/app.js');

      expect(page.status).toBe(200);
      expect(page.headers.get('content-type')).toMatch(/^text\/html/);
      expect(await page.text()).toContain('<title>T3 Orchestrator</title>');
      expect(script.headers.get('content-type')).toMatch(/^text\/javascript/);
      expect(await script.text()).toBe('console.log("app")');
    });

    it('keeps API paths and files outside the web folder out of reach', async () => {
      const { request } = start({ webRoot });

      const unknownApi = await request('/api/nope');
      const outside = await request('/assets/..%2f..%2fsecret.txt');
      const missing = await request('/missing.js');

      expect(unknownApi.status).toBe(404);
      expect(await unknownApi.json()).toEqual({ error: 'no route GET /api/nope' });
      expect(outside.status).toBe(404);
      expect(missing.status).toBe(404);
    });
  });
});
