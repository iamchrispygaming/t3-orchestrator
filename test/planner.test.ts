import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from '../src/server/server.ts';
import type { Plan, PlanDraft } from '../src/shared/api.ts';
import { createApiClient, type EventStream } from '../src/web/api.ts';
import { drafted, FakeAgentRunner, round } from './support/fake-agent-runner.ts';
import { FakeClock } from './support/fake-clock.ts';
import { FakeGitHub } from './support/fake-github.ts';
import { createBareRemote, git } from './support/git.ts';

const opusHigh = { agent: 'claude', model: 'opus', effort: 'high' } as const;

const draft: PlanDraft = {
  spec: { title: 'Greetings', body: 'Say hello in two files.' },
  tickets: [
    {
      key: 'T1',
      title: 'Add hello.txt',
      body: 'Write hello.txt.',
      tier: { agent: 'claude', model: 'haiku', effort: 'medium' },
      tierReason: 'One small file.',
      door: 'two-way',
      blockedBy: [],
    },
    {
      key: 'T2',
      title: 'Link hello.txt from the README',
      body: 'Add a link.',
      tier: { agent: 'codex', model: 'gpt-6.2-sol', effort: 'low' },
      tierReason: 'A one-line edit.',
      door: 'two-way',
      blockedBy: ['T1'],
    },
  ],
};

describe('the Planner interview', () => {
  let root: string;
  let dataDir: string;
  let remote: string;
  let github: FakeGitHub;
  let agent: FakeAgentRunner;
  let servers: Server[];

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 't3o-test-'));
    dataDir = join(root, 'data');
    remote = createBareRemote(root);
    github = new FakeGitHub();
    github.addRepo('acme', 'widgets', remote);
    agent = new FakeAgentRunner();
    servers = [];
  });

  afterEach(async () => {
    for (const server of servers) await server.close();
    rmSync(root, { recursive: true, force: true });
  });

  function start() {
    const server = createServer({ env: { T3O_DATA_DIR: dataDir }, github, agentRunner: agent, clock: new FakeClock() });
    servers.push(server);
    return createApiClient((path, init) => Promise.resolve(server.app.request(path, init)));
  }

  async function settled(events: EventStream, planId: number): Promise<Plan> {
    for (;;) {
      const event = await events.next();
      if (event.type === 'plan' && event.plan.id === planId && event.plan.status !== 'thinking') return event.plan;
    }
  }

  it('starts on "New idea" at the Planner tier, reading a fresh checkout of the default branch, and asks round 1 over SSE', async () => {
    let seenReadme = '';
    agent.script('plan', (req) => {
      seenReadme = readFileSync(join(req.cwd, 'README.md'), 'utf8').trimEnd();
      return round([{ question: 'Plain text or Markdown?', recommended: 'Plain text.' }]);
    });
    const api = start();
    const repo = await api.addTargetRepo({ owner: 'acme', name: 'widgets' });
    const events = await api.events();
    expect((await events.next()).type).toBe('snapshot');

    const plan = await api.startPlan({ repoId: repo.id, idea: 'Greet people.' });
    expect(plan.status).toBe('thinking');
    const asked = await settled(events, plan.id);
    await events.close();

    expect(asked.status).toBe('asking');
    expect(asked.draft).toBeNull();
    expect(asked.messages).toMatchObject([
      { from: 'user', text: 'Greet people.' },
      { from: 'planner', round: { number: 1, questions: [{ question: 'Plain text or Markdown?', recommended: 'Plain text.' }] } },
    ]);
    expect(agent.calls).toHaveLength(1);
    expect(agent.calls[0]).toMatchObject({ mode: 'plan', tier: opusHigh });
    expect(agent.calls[0]!.instructions).toContain('Greet people.');
    expect(seenReadme).toBe('# Target Repo');
    expect(git(agent.calls[0]!.cwd, 'rev-parse', 'HEAD')).toBe(git(remote, 'rev-parse', 'main'));
  });
});

void existsSync;
void drafted;
void draft;
