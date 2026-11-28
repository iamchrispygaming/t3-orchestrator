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

  it('resumes the same session for each answer, numbers the next round, and pushes the updated draft over SSE', async () => {
    agent
      .script('plan', () => round([{ question: 'Plain text?', recommended: 'Yes.' }], { sessionId: 'planner-1' }))
      .script('plan', () => round([{ question: 'Link it from the README?', recommended: 'Yes.' }], { sessionId: 'planner-1', draft }))
      .script('plan', () => drafted(draft, { sessionId: 'planner-1' }));
    const api = start();
    const repo = await api.addTargetRepo({ owner: 'acme', name: 'widgets' });
    const events = await api.events();
    const plan = await api.startPlan({ repoId: repo.id, idea: 'Greet people.' });
    await settled(events, plan.id);

    await api.replyToPlan(plan.id, { text: 'Yes.' });
    const second = await settled(events, plan.id);
    expect(second.status).toBe('asking');
    expect(second.draft).toEqual(draft);
    expect(second.messages.at(-1)).toMatchObject({ from: 'planner', round: { number: 2 } });

    await api.replyToPlan(plan.id, { text: 'Yes, link it.' });
    const done = await settled(events, plan.id);
    await events.close();

    expect(done.status).toBe('drafted');
    expect(done.draft).toEqual(draft);
    expect(done.messages.map((m) => m.from)).toEqual(['user', 'planner', 'user', 'planner', 'user', 'planner']);
    expect(done.messages.filter((m) => m.from === 'user').map((m) => m.text)).toEqual(['Greet people.', 'Yes.', 'Yes, link it.']);
    expect(agent.calls.map((c) => c.resumeSessionId)).toEqual([undefined, 'planner-1', 'planner-1']);
    expect(agent.calls[2]!.instructions).toContain('Yes, link it.');
    expect(await api.getPlan(plan.id)).toEqual(done);
  });

  it('refuses a reply while the Planner is still thinking', async () => {
    let finish!: () => void;
    agent.script('plan', () => new Promise((resolve) => (finish = () => resolve(round([{ question: 'Q?', recommended: 'A.' }])))));
    const api = start();
    const repo = await api.addTargetRepo({ owner: 'acme', name: 'widgets' });
    const events = await api.events();
    const plan = await api.startPlan({ repoId: repo.id, idea: 'Greet people.' });

    await expect(api.replyToPlan(plan.id, { text: 'Hurry up.' })).rejects.toThrow(/409/);
    finish();
    await settled(events, plan.id);
    await events.close();
  });

  it('"just draft it" skips the remaining questions and yields a draft', async () => {
    agent
      .script('plan', () => round([{ question: 'Plain text?', recommended: 'Yes.' }]))
      .script('plan', () => drafted(draft));
    const api = start();
    const repo = await api.addTargetRepo({ owner: 'acme', name: 'widgets' });
    const events = await api.events();
    const plan = await api.startPlan({ repoId: repo.id, idea: 'Greet people.' });
    await settled(events, plan.id);

    await api.replyToPlan(plan.id, { justDraft: true, text: 'Keep it small.' });
    const done = await settled(events, plan.id);
    await events.close();

    expect(done.status).toBe('drafted');
    expect(done.draft).toEqual(draft);
    expect(done.messages.at(-2)).toMatchObject({ from: 'user', text: 'Keep it small.', justDraft: true });
    expect(done.messages.at(-1)).toMatchObject({ from: 'planner', round: null });
    expect(agent.calls[1]!.instructions).toContain('Keep it small.');
    expect(agent.calls[1]!.instructions).toMatch(/just draft it.*ask no more questions/is);
  });

  it('"just draft it" never opens another round: a Planner that asks anyway fails the turn', async () => {
    agent
      .script('plan', () => round([{ question: 'Plain text?', recommended: 'Yes.' }]))
      .script('plan', () => round([{ question: 'One more?', recommended: 'No.' }], { draft }));
    const api = start();
    const repo = await api.addTargetRepo({ owner: 'acme', name: 'widgets' });
    const events = await api.events();
    const plan = await api.startPlan({ repoId: repo.id, idea: 'Greet people.' });
    await settled(events, plan.id);

    await api.replyToPlan(plan.id, { justDraft: true });
    const after = await settled(events, plan.id);
    await events.close();

    expect(after.status).toBe('failed');
    expect(after.messages.filter((m) => m.from === 'planner' && m.round)).toHaveLength(1);
  });
});
