import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
    let finish: (() => void) | undefined;
    agent.script('plan', () => new Promise((resolve) => (finish = () => resolve(round([{ question: 'Q?', recommended: 'A.' }])))));
    const api = start();
    const repo = await api.addTargetRepo({ owner: 'acme', name: 'widgets' });
    const events = await api.events();
    const plan = await api.startPlan({ repoId: repo.id, idea: 'Greet people.' });

    await expect(api.replyToPlan(plan.id, { text: 'Hurry up.' })).rejects.toThrow(/409/);
    while (!finish) await new Promise((r) => setTimeout(r, 5));
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

  it('keeps drafts and their chat across a restart', async () => {
    agent
      .script('plan', () => round([{ question: 'Plain text?', recommended: 'Yes.' }], { sessionId: 'planner-1', draft }))
      .script('plan', () => drafted(draft, { sessionId: 'planner-1' }));
    let api = start();
    const repo = await api.addTargetRepo({ owner: 'acme', name: 'widgets' });
    let events = await api.events();
    const plan = await api.startPlan({ repoId: repo.id, idea: 'Greet people.' });
    const before = await settled(events, plan.id);
    await events.close();
    for (const server of servers.splice(0)) await server.close();

    api = start();
    expect(await api.listPlans()).toEqual([before]);
    events = await api.events();
    const snapshot = await events.next();
    expect(snapshot.type === 'snapshot' && snapshot.plans).toEqual([before]);

    await api.replyToPlan(plan.id, { text: 'Yes.' });
    const after = await settled(events, plan.id);
    await events.close();
    expect(after.status).toBe('drafted');
    expect(agent.calls[1]!.resumeSessionId).toBe('planner-1');
  });

  it('redoes a Planner turn that a server stop cut short', async () => {
    agent.script('plan', (req) => new Promise((_, reject) => req.signal.addEventListener('abort', () => reject(new Error('stopped')))));
    let api = start();
    const repo = await api.addTargetRepo({ owner: 'acme', name: 'widgets' });
    const plan = await api.startPlan({ repoId: repo.id, idea: 'Greet people.' });
    while (agent.calls.length === 0) await new Promise((r) => setTimeout(r, 5));
    for (const server of servers.splice(0)) await server.close();

    agent.script('plan', () => round([{ question: 'Plain text?', recommended: 'Yes.' }]));
    api = start();
    const events = await api.events();
    const snapshot = await events.next();
    const pending = snapshot.type === 'snapshot' ? snapshot.plans.find((p) => p.id === plan.id) : undefined;
    const asked = pending?.status === 'asking' ? pending : await settled(events, plan.id);
    await events.close();

    expect(asked.status).toBe('asking');
    expect(asked.messages.map((m) => m.from)).toEqual(['user', 'planner']);
    expect(agent.calls).toHaveLength(2);
    expect(agent.calls[1]!.instructions).toContain('Greet people.');
  });

  it('holds several Plans across Target Repos at once, and discarding one leaves the others and touches nothing on GitHub', async () => {
    mkdirSync(join(root, 'second'));
    github.addRepo('acme', 'gadgets', createBareRemote(join(root, 'second')));
    agent
      .script('plan', () => drafted(draft))
      .script('plan', () => round([{ question: 'Q?', recommended: 'A.' }]))
      .script('plan', () => round([{ question: 'Q?', recommended: 'A.' }]));
    const api = start();
    const widgets = await api.addTargetRepo({ owner: 'acme', name: 'widgets' });
    const gadgets = await api.addTargetRepo({ owner: 'acme', name: 'gadgets' });
    const events = await api.events();
    const first = await api.startPlan({ repoId: widgets.id, idea: 'Greet people.' });
    await settled(events, first.id);
    const second = await api.startPlan({ repoId: widgets.id, idea: 'Wave at people.' });
    await settled(events, second.id);
    const third = await api.startPlan({ repoId: gadgets.id, idea: 'Build a gadget.' });
    await settled(events, third.id);
    const checkout = agent.calls[0]!.cwd;
    expect(existsSync(checkout)).toBe(true);

    await api.discardPlan(first.id);
    let discarded: number | undefined;
    while (discarded === undefined) {
      const event = await events.next();
      if (event.type === 'plan-discarded') discarded = event.planId;
    }
    await events.close();

    expect(discarded).toBe(first.id);
    expect((await api.listPlans()).map((p) => [p.id, p.repoId])).toEqual([
      [second.id, widgets.id],
      [third.id, gadgets.id],
    ]);
    await expect(api.getPlan(first.id)).rejects.toThrow(/404/);
    expect(existsSync(checkout)).toBe(false);
    expect(github.issueCount('acme', 'widgets')).toBe(0);
    expect(github.pulls('acme', 'widgets')).toEqual([]);
    expect(github.branches('acme', 'widgets')).toEqual(['main']);
  });

  it('keeps each Plan on the Planner tier it started at; a setting change applies only to new Plans', async () => {
    const codex = { agent: 'codex', model: 'gpt-6.2-astra', effort: 'high' } as const;
    agent
      .script('plan', () => round([{ question: 'Q?', recommended: 'A.' }], { sessionId: 'claude-session' }))
      .script('plan', () => drafted(draft, { sessionId: 'claude-session' }))
      .script('plan', () => round([{ question: 'Q?', recommended: 'A.' }], { sessionId: 'codex-session' }));
    const api = start();
    expect((await api.getSettings()).plannerTier).toEqual(opusHigh);
    const repo = await api.addTargetRepo({ owner: 'acme', name: 'widgets' });
    const events = await api.events();
    const open = await api.startPlan({ repoId: repo.id, idea: 'Greet people.' });
    await settled(events, open.id);

    await api.updateSettings({ plannerTier: codex });
    await api.replyToPlan(open.id, { text: 'A.' });
    const answered = await settled(events, open.id);
    const fresh = await api.startPlan({ repoId: repo.id, idea: 'Wave at people.' });
    await settled(events, fresh.id);
    await events.close();

    expect(answered.status).toBe('drafted');
    expect(answered.tier).toEqual(opusHigh);
    expect(agent.calls.map((c) => [c.tier, c.resumeSessionId])).toEqual([
      [opusHigh, undefined],
      [opusHigh, 'claude-session'],
      [codex, undefined],
    ]);
    for (const server of servers.splice(0)) await server.close();
    expect((await start().getSettings()).plannerTier).toEqual(codex);
  });

  it("drops a discarded Plan's late Planner result instead of saving it on another Plan", async () => {
    mkdirSync(join(root, 'second'));
    github.addRepo('acme', 'gadgets', createBareRemote(join(root, 'second')));
    const finish: Array<() => void> = [];
    agent
      .script('plan', () => new Promise((resolve) => finish.push(() => resolve(drafted(draft, { sessionId: 'widgets-session' })))))
      .script('plan', () => new Promise((resolve) => finish.push(() => resolve(round([{ question: 'Gadget Q?', recommended: 'A.' }])))));
    const api = start();
    const widgets = await api.addTargetRepo({ owner: 'acme', name: 'widgets' });
    const gadgets = await api.addTargetRepo({ owner: 'acme', name: 'gadgets' });
    const events = await api.events();
    const gone = await api.startPlan({ repoId: widgets.id, idea: 'Greet people.' });
    while (finish.length < 1) await new Promise((r) => setTimeout(r, 5));
    await api.discardPlan(gone.id);
    const kept = await api.startPlan({ repoId: gadgets.id, idea: 'Build a gadget.' });
    while (finish.length < 2) await new Promise((r) => setTimeout(r, 5));

    finish[0]!();
    finish[1]!();
    const asked = await settled(events, kept.id);
    await events.close();

    expect(asked).toMatchObject({ repoId: gadgets.id, status: 'asking', draft: null });
    expect(asked.messages.map((m) => m.text)).toEqual(['Build a gadget.', 'A few questions first.']);
    expect(await api.listPlans()).toEqual([asked]);
    expect(agent.calls[1]!.resumeSessionId).toBeUndefined();
  });

  it('shows a new Plan with its idea from the start, and discarding it during setup leaves nothing behind', async () => {
    agent.script('plan', () => round([{ question: 'Q?', recommended: 'A.' }]));
    const api = start();
    const repo = await api.addTargetRepo({ owner: 'acme', name: 'widgets' });
    const starting = api.startPlan({ repoId: repo.id, idea: 'Greet people.' });
    let listed = await api.listPlans();
    while (listed.length === 0) listed = await api.listPlans();
    expect(listed[0]!.messages).toMatchObject([{ from: 'user', text: 'Greet people.' }]);

    await api.discardPlan(listed[0]!.id);
    await starting;
    for (const server of servers.splice(0)) await server.close();

    expect(await start().listPlans()).toEqual([]);
    expect(existsSync(join(dataDir, 'repos', 'acme', 'widgets', 'plan', String(listed[0]!.id)))).toBe(false);
  });

  it('keeps the idea and asks round 1 when a restart lands during Plan setup', async () => {
    let api = start();
    const repo = await api.addTargetRepo({ owner: 'acme', name: 'widgets' });
    const starting = api.startPlan({ repoId: repo.id, idea: 'Greet people.' });
    let listed = await api.listPlans();
    while (listed.length === 0) listed = await api.listPlans();
    for (const server of servers.splice(0)) await server.close();
    await starting.catch(() => undefined);

    agent.script('plan', () => round([{ question: 'Q?', recommended: 'A.' }]));
    api = start();
    const events = await api.events();
    const snapshot = await events.next();
    const pending = snapshot.type === 'snapshot' ? snapshot.plans[0] : undefined;
    const asked = pending && pending.status !== 'thinking' ? pending : await settled(events, listed[0]!.id);
    await events.close();

    expect(asked.status).toBe('asking');
    expect(asked.messages.map((m) => m.text)).toEqual(['Greet people.', 'A few questions first.']);
  });

  it('treats a plain "just draft it" reply like the just-draft command', async () => {
    agent
      .script('plan', () => round([{ question: 'Plain text?', recommended: 'Yes.' }]))
      .script('plan', () => round([{ question: 'One more?', recommended: 'No.' }], { draft }));
    const api = start();
    const repo = await api.addTargetRepo({ owner: 'acme', name: 'widgets' });
    const events = await api.events();
    const plan = await api.startPlan({ repoId: repo.id, idea: 'Greet people.' });
    await settled(events, plan.id);

    await api.replyToPlan(plan.id, { text: '  Just Draft It.  ' });
    const after = await settled(events, plan.id);
    await events.close();

    expect(after.messages.at(-2)).toMatchObject({ from: 'user', justDraft: true });
    expect(agent.calls[1]!.instructions).toMatch(/ask no more questions/i);
    expect(after.status).toBe('failed');
    expect(after.messages.filter((m) => m.from === 'planner' && m.round)).toHaveLength(1);
  });

  it('saves direct text, Model Tier and door edits and publishes the draft over SSE', async () => {
    agent.script('plan', () => drafted(draft));
    const api = start();
    const repo = await api.addTargetRepo({ owner: 'acme', name: 'widgets' });
    const events = await api.events();
    const plan = await api.startPlan({ repoId: repo.id, idea: 'Greet people.' });
    await settled(events, plan.id);

    const edits = {
      spec: { body: 'Say hello and link to it.' },
      ticket: {
        key: 'T1',
        title: 'Add a greeting',
        body: 'Write a greeting in hello.txt.',
        tier: opusHigh,
        door: 'one-way' as const,
      },
    };
    const edited = await api.editPlanDraft(plan.id, edits);
    expect(await settled(events, plan.id)).toEqual(edited);
    await events.close();
    expect(edited.draft).toEqual({
      spec: { title: 'Greetings', body: edits.spec.body },
      tickets: [
        { ...draft.tickets[0], ...edits.ticket, tierReason: '' },
        draft.tickets[1],
      ],
    });
    for (const server of servers.splice(0)) await server.close();
    expect(await start().getPlan(plan.id)).toEqual(edited);
    expect(agent.calls).toHaveLength(1);
    expect(github.issueCount('acme', 'widgets')).toBe(0);
  });

  it('redraws the current draft through the Planner when the user asks to merge Tickets', async () => {
    const redrawn = { ...draft, tickets: [{ ...draft.tickets[0]!, body: 'Write and link hello.txt.' }] };
    agent
      .script('plan', () => drafted(draft, { sessionId: 'planner-1' }))
      .script('plan', (req) => {
        expect(req.resumeSessionId).toBe('planner-1');
        expect(req.instructions).toContain('Merge the two Tickets.');
        expect(req.instructions).toContain('Use a friendlier greeting.');
        return drafted(redrawn, { sessionId: 'planner-1' });
      });
    const api = start();
    const repo = await api.addTargetRepo({ owner: 'acme', name: 'widgets' });
    const events = await api.events();
    const plan = await api.startPlan({ repoId: repo.id, idea: 'Greet people.' });
    await settled(events, plan.id);
    await api.editPlanDraft(plan.id, { ticket: { key: 'T1', body: 'Use a friendlier greeting.' } });
    await settled(events, plan.id);

    await api.replyToPlan(plan.id, { text: 'Merge the two Tickets.' });
    const updated = await settled(events, plan.id);
    await events.close();
    expect(updated.status).toBe('drafted');
    expect(updated.draft).toEqual(redrawn);
    expect(github.issueCount('acme', 'widgets')).toBe(0);
  });

  it('publishes the Spec, Ticket sub-issues, native blockers and labels before queueing', async () => {
    agent.script('plan', () => drafted(draft));
    agent.script('run', (req) => new Promise((_, reject) => {
      req.signal.throwIfAborted();
      req.signal.addEventListener('abort', () => reject(new Error('stopped')), { once: true });
    }));
    const api = start();
    const repo = await api.addTargetRepo({ owner: 'acme', name: 'widgets' });
    const events = await api.events();
    const plan = await api.startPlan({ repoId: repo.id, idea: 'Greet people.' });
    await settled(events, plan.id);
    await api.editPlanDraft(plan.id, { ticket: { key: 'T2', door: 'one-way', title: 'Link the greeting' } });
    expect(github.issueCount('acme', 'widgets')).toBe(0);

    const approved = await api.approvePlan(plan.id);
    const [first, second] = approved.tickets;
    expect(approved).toMatchObject({ spec: { owner: 'acme', name: 'widgets', number: 1000 } });
    const spec = 1000;
    expect(github.issue('acme', 'widgets', spec)).toMatchObject(draft.spec);
    expect(github.subIssues('acme', 'widgets', spec)).toEqual([first!.issueNumber, second!.issueNumber]);
    expect(github.issue('acme', 'widgets', first!.issueNumber)).toMatchObject({
      title: 'Add hello.txt', body: 'Write hello.txt.', labels: ['model:claude:haiku/medium', 'door:two-way'],
    });
    expect(github.issue('acme', 'widgets', second!.issueNumber)).toMatchObject({
      title: 'Link the greeting', body: 'Add a link.', labels: ['model:codex:gpt-6.2-sol/low', 'door:one-way'],
    });
    expect(await github.getBlockers('acme', 'widgets', second!.issueNumber)).toEqual([
      { owner: 'acme', name: 'widgets', number: first!.issueNumber, merged: false },
    ]);

    let running = false;
    let published = false;
    while (!running || !published) {
      const event = await events.next();
      if (event.type === 'ticket' && event.ticket.id === first!.id && event.ticket.state === 'running') running = true;
      if (event.type === 'plan' && event.plan.id === plan.id && event.plan.status === 'approved') published = true;
    }
    await events.close();
    expect((await api.getTicket(second!.id)).state).toBe('waiting');
    await expect(api.approvePlan(plan.id)).rejects.toThrow(/409/);
    expect(github.issueCount('acme', 'widgets')).toBe(3);
  });

  it('retries partial publication after a restart without duplicating issues or queueing early', async () => {
    agent.script('plan', () => drafted(draft));
    agent.script('run', (req) => new Promise((_, reject) => {
      req.signal.throwIfAborted();
      req.signal.addEventListener('abort', () => reject(new Error('stopped')), { once: true });
    }));
    let api = start();
    const repo = await api.addTargetRepo({ owner: 'acme', name: 'widgets' });
    const events = await api.events();
    const plan = await api.startPlan({ repoId: repo.id, idea: 'Greet people.' });
    await settled(events, plan.id);
    await events.close();

    github.failNextSubIssue();
    await expect(api.approvePlan(plan.id)).rejects.toThrow(/temporarily unavailable/);
    expect(github.issueCount('acme', 'widgets')).toBe(2);
    const snapshot = await api.events();
    expect(await snapshot.next()).toMatchObject({ type: 'snapshot', tickets: [] });
    await snapshot.close();
    for (const server of servers.splice(0)) await server.close();

    api = start();
    const approved = await api.approvePlan(plan.id);
    expect(await api.getPlan(plan.id)).toMatchObject({ status: 'approved', approvedPlanId: approved.id, specIssue: approved.spec });
    expect(approved.spec?.number).toBe(1000);
    expect(approved.tickets.map((t) => t.issueNumber)).toEqual([1001, 1002]);
    expect(github.issueCount('acme', 'widgets')).toBe(3);
  });

  it('marks a turn failed when the Planner crashes, and a reply retries it', async () => {
    agent
      .script('plan', () => {
        throw new Error('planner crashed');
      })
      .script('plan', () => round([{ question: 'Q?', recommended: 'A.' }]));
    const api = start();
    const repo = await api.addTargetRepo({ owner: 'acme', name: 'widgets' });
    const events = await api.events();
    const plan = await api.startPlan({ repoId: repo.id, idea: 'Greet people.' });
    const failed = await settled(events, plan.id);
    expect(failed.status).toBe('failed');
    expect(failed.messages.at(-1)).toMatchObject({ from: 'planner', text: expect.stringContaining('planner crashed') });

    await api.replyToPlan(plan.id, { text: 'Try again.' });
    const asked = await settled(events, plan.id);
    await events.close();
    expect(asked.status).toBe('asking');
  });
});
