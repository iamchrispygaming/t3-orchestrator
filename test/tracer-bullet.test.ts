import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from '../src/server/server.ts';
import type { ModelTier, TicketState } from '../src/shared/api.ts';
import { createApiClient } from '../src/web/api.ts';
import { approve, done, FakeAgentRunner } from './support/fake-agent-runner.ts';
import { FakeClock } from './support/fake-clock.ts';
import { FakeGitHub } from './support/fake-github.ts';
import { commitFile, createBareRemote } from './support/git.ts';

const tier: ModelTier = { agent: 'claude', model: 'haiku', effort: 'medium' };
const minutes = (n: number) => n * 60_000;

describe('a hand-made Two-way Ticket on the fake Agent', () => {
  let root: string;
  let dataDir: string;
  let github: FakeGitHub;
  let agent: FakeAgentRunner;
  let clock: FakeClock;
  let servers: Server[];

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 't3o-test-'));
    dataDir = join(root, 'data');
    github = new FakeGitHub();
    github.addRepo('acme', 'widgets', createBareRemote(root));
    github.addIssue('acme', 'widgets', { number: 7, title: 'Add a greeting file!', body: 'Write hello.txt.' });
    agent = new FakeAgentRunner();
    clock = new FakeClock('2026-01-01T09:00:00.000Z');
    servers = [];
  });

  afterEach(async () => {
    for (const server of servers) await server.close();
    rmSync(root, { recursive: true, force: true });
  });

  function start() {
    const server = createServer({ env: { T3O_DATA_DIR: dataDir }, github, agentRunner: agent, clock });
    servers.push(server);
    return createApiClient((path, init) => Promise.resolve(server.app.request(path, init)));
  }

  async function runToMerged() {
    const seenByAgent: { branches: string[]; pulls: number }[] = [];
    agent.script('run', (req) => {
      commitFile(req.cwd, 'hello.txt', 'hello\n', 'Add hello.txt');
      seenByAgent.push({ branches: github.branches('acme', 'widgets'), pulls: github.pulls('acme', 'widgets').length });
      clock.advance(minutes(5));
      return done({ prBody: '## Summary\n\nAdds hello.txt.' });
    });
    agent.script('review', () => {
      clock.advance(minutes(2));
      return approve();
    });

    const api = start();
    const repo = await api.addTargetRepo({ owner: 'acme', name: 'widgets' });
    const events = await api.events();
    expect((await events.next()).type).toBe('snapshot');

    const ticket = await api.registerTicket({ repoId: repo.id, issueNumber: 7, tier, door: 'two-way' });
    const states: TicketState[] = [];
    while (states.at(-1) !== 'merged') {
      const event = await events.next();
      if (event.type === 'ticket' && event.ticket.id === ticket.id) states.push(event.ticket.state);
    }
    await events.close();
    return { api, ticket, states, seenByAgent };
  }

  it('goes Ready, Running, Reviewing, Merged over SSE, ending in one squash-merged PR that closes the issue', async () => {
    const { states, seenByAgent } = await runToMerged();

    expect(states).toEqual(['ready', 'running', 'reviewing', 'merged']);

    expect(github.branches('acme', 'widgets').sort()).toEqual(['main', 't3o/7-add-a-greeting-file']);
    const pulls = github.pulls('acme', 'widgets');
    expect(pulls).toHaveLength(1);
    expect(pulls[0]).toMatchObject({
      head: 't3o/7-add-a-greeting-file',
      base: 'main',
      merged: true,
      mergeMethod: 'squash',
    });
    expect(github.issue('acme', 'widgets', 7)?.state).toBe('closed');

    // The Agent only commits: when its Run ended, nothing was pushed and no PR existed.
    expect(seenByAgent).toEqual([{ branches: ['main'], pulls: 0 }]);
    expect(agent.calls.map((c) => c.mode)).toEqual(['run', 'review']);
  });

  it('keeps the Run and Review records (tier, times, outcome) across a restart', async () => {
    const { ticket } = await runToMerged();
    for (const server of servers.splice(0)) await server.close();

    const detail = await start().getTicket(ticket.id);

    expect(detail.state).toBe('merged');
    expect(detail.runs).toEqual([
      { tier, startedAt: '2026-01-01T09:00:00.000Z', endedAt: '2026-01-01T09:05:00.000Z', outcome: 'done' },
    ]);
    expect(detail.reviews).toEqual([
      { tier, startedAt: '2026-01-01T09:05:00.000Z', endedAt: '2026-01-01T09:07:00.000Z', verdict: 'approve' },
    ]);
  });

  it('keeps its data in the folder the env var names', async () => {
    await runToMerged();

    expect(existsSync(join(dataDir, 't3o.db'))).toBe(true);
    expect(existsSync(join(dataDir, 'repos', 'acme', 'widgets', 'git'))).toBe(true);
    const repoDir = join(dataDir, 'repos', 'acme', 'widgets');
    expect(agent.calls[0]).toMatchObject({ cwd: join(repoDir, 'work', '7'), scratchDir: join(repoDir, 'scratch', '7') });
  });
});
