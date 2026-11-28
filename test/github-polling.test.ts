import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GITHUB_POLL_INTERVAL_MS } from '../src/server/poller.ts';
import { createServer, type Server } from '../src/server/server.ts';
import type { Door, ModelTier, Ticket } from '../src/shared/api.ts';
import { createApiClient, type ApiClient } from '../src/web/api.ts';
import type { RunRequest } from '../src/server/agent-runner.ts';
import { approve, done, FakeAgentRunner } from './support/fake-agent-runner.ts';
import { FakeClock } from './support/fake-clock.ts';
import { FakeGitHub } from './support/fake-github.ts';
import { commitFile, createBareRemote } from './support/git.ts';

const haiku: ModelTier = { agent: 'claude', model: 'haiku', effort: 'medium' };
const sonnet: ModelTier = { agent: 'claude', model: 'sonnet', effort: 'medium' };
const solLow: ModelTier = { agent: 'codex', model: 'gpt-6.2-sol', effort: 'low' };

// Lets the in-process server finish whatever a fired timer started (fakes answer at once).
const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
};

type Deferred = { promise: Promise<void>; release: () => void; oneWay?: boolean };
const deferred = (): Deferred => {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => (release = resolve));
  return { promise, release };
};

describe('following GitHub by polling', () => {
  let root: string;
  let github: FakeGitHub;
  let agent: FakeAgentRunner;
  let clock: FakeClock;
  let server: Server;
  let api: ApiClient;
  let seen: Ticket[];
  let waiters: { test: (t: Ticket) => boolean; resolve: () => void }[];
  let stopEvents: () => Promise<void>;
  // A Run (key `repo#n`) or Review (key `review:repo#n`) in this map waits for its release before it ends.
  let holds: Map<string, Deferred>;

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
    holds = new Map();
    for (let i = 0; i < 20; i++) {
      agent.script('run', async (req) => {
        const key = `${basename(join(req.cwd, '..', '..'))}#${basename(req.cwd)}`;
        commitFile(req.cwd, 'hello.txt', 'hello\n', 'Add hello.txt');
        await holds.get(key)?.promise;
        return done(holds.get(key)?.oneWay ? { door: 'one-way' } : {});
      });
      agent.script('review', async (req) => {
        await holds.get(`review:${basename(join(req.cwd, '..', '..'))}#${basename(req.cwd)}`)?.promise;
        return approve();
      });
    }

    server = createServer({ env: { T3O_DATA_DIR: join(root, 'data') }, github, agentRunner: agent, clock });
    api = createApiClient((path, init) => Promise.resolve(server.app.request(path, init)));
    seen = [];
    waiters = [];
    const events = await api.events();
    let open = true;
    const pump = (async () => {
      while (open) {
        const event = await events.next().catch(() => null);
        if (!event) return;
        if (event.type !== 'ticket') continue;
        seen.push(event.ticket);
        for (const w of waiters.filter((w) => w.test(event.ticket))) {
          waiters.splice(waiters.indexOf(w), 1);
          w.resolve();
        }
      }
    })();
    stopEvents = async () => {
      open = false;
      await events.close();
      await pump;
    };
  });

  afterEach(async () => {
    // Free any Run or Review still held, so a failed assertion can't hang server.close().
    for (const hold of holds.values()) hold.release();
    await stopEvents();
    await server.close();
    rmSync(root, { recursive: true, force: true });
  });

  function reached(id: number, test: (t: Ticket) => boolean): Promise<void> {
    if (seen.some((t) => t.id === id && test(t))) return Promise.resolve();
    return new Promise((resolve) => waiters.push({ test: (t) => t.id === id && test(t), resolve }));
  }

  // Advances the fake clock by one poll interval and lets that poll finish.
  async function poll() {
    await settle();
    clock.advance(GITHUB_POLL_INTERVAL_MS);
    await settle();
  }

  async function addRepo(name: 'widgets' | 'gadgets') {
    return api.addTargetRepo({ owner: 'acme', name });
  }

  async function register(
    repo: { id: number; name: string },
    issueNumber: number,
    { tier = haiku, door = 'two-way' as Door, labels = [] as string[], hold = false, holdReview = false } = {},
  ) {
    github.addIssue('acme', repo.name, { number: issueNumber, title: `Issue ${issueNumber}`, body: 'Do it.', labels });
    if (hold) holds.set(`${repo.name}#${issueNumber}`, deferred());
    if (holdReview) holds.set(`review:${repo.name}#${issueNumber}`, deferred());
    return api.registerTicket({ repoId: repo.id, issueNumber, tier, door });
  }

  const release = (repo: string, issueNumber: number) => holds.get(`${repo}#${issueNumber}`)!.release();
  const releaseReview = (repo: string, issueNumber: number) => holds.get(`review:${repo}#${issueNumber}`)!.release();
  const reviewStarted = (repo: string, issueNumber: number) =>
    agent.calls.some((c) => c.mode === 'review' && c.cwd.endsWith(join(repo, 'work', String(issueNumber))));
  const runTiers = (repo: string, issueNumber: number) =>
    agent.calls
      .filter((c: RunRequest) => c.mode === 'run' && c.cwd.endsWith(join(repo, 'work', String(issueNumber))))
      .map((c) => c.tier);

  it('marks a Ticket Merged within one poll of its PR being merged on GitHub', async () => {
    const widgets = await addRepo('widgets');
    const ticket = await register(widgets, 7, { door: 'one-way' });
    await reached(ticket.id, (t) => t.state === 'awaiting-merge');
    const prNumber = (await api.getTicket(ticket.id)).prNumber!;

    github.mergeOnGitHub('acme', 'widgets', prNumber);
    await poll();

    expect((await api.getTicket(ticket.id)).state).toBe('merged');
    expect(github.calls.filter((c) => c.method === 'mergePullRequest')).toEqual([]);
  });

  it('re-routes a Ticket whose model label changes on GitHub before its first Run', async () => {
    // Both Claude slots are busy, so #9 waits Ready.
    const gadgets = await addRepo('gadgets');
    const widgets = await addRepo('widgets');
    const busy = [await register(gadgets, 1, { hold: true }), await register(widgets, 8, { hold: true })];
    while (agent.calls.length < 2) await settle();
    const ticket = await register(widgets, 9, { tier: haiku, labels: ['model:claude:haiku/medium'] });
    await poll();
    expect((await api.getTicket(ticket.id)).state).toBe('ready');

    github.setLabels('acme', 'widgets', 9, ['model:codex:gpt-6.2-sol/low']);
    await poll();

    await reached(ticket.id, (t) => t.state === 'merged');
    expect(runTiers('widgets', 9)).toEqual([solLow]);
    expect((await api.getTicket(ticket.id)).tier).toEqual(solLow);
    release('gadgets', 1);
    release('widgets', 8);
    for (const t of busy) await reached(t.id, (s) => s.state === 'merged');
  });

  it('starts the first Run at a model label edited after the last poll', async () => {
    const gadgets = await addRepo('gadgets');
    const widgets = await addRepo('widgets');
    const busy = [await register(gadgets, 1, { hold: true }), await register(widgets, 8, { hold: true })];
    while (agent.calls.length < 2) await settle();
    const ticket = await register(widgets, 9, { tier: haiku, labels: ['model:claude:haiku/medium'] });
    await poll();

    // Edited on GitHub, then a slot frees before the next poll.
    github.setLabels('acme', 'widgets', 9, ['model:claude:sonnet/medium']);
    release('gadgets', 1);

    await reached(ticket.id, (t) => t.state === 'merged');
    expect(runTiers('widgets', 9)).toEqual([sonnet]);
    expect((await api.getTicket(ticket.id)).tier).toEqual(sonnet);
    release('widgets', 8);
    for (const t of busy) await reached(t.id, (s) => s.state === 'merged');
  });

  it('moves a waiting Ticket to another Agent when its model label changes after the last poll', async () => {
    const gadgets = await addRepo('gadgets');
    const widgets = await addRepo('widgets');
    const busy = [await register(gadgets, 1, { hold: true }), await register(widgets, 8, { hold: true })];
    while (agent.calls.length < 2) await settle();
    const ticket = await register(widgets, 9, { tier: haiku });
    await poll();

    github.setLabels('acme', 'widgets', 9, ['model:codex:gpt-6.2-sol/low']);
    release('gadgets', 1);

    await reached(ticket.id, (t) => t.state === 'merged');
    expect(runTiers('widgets', 9)).toEqual([solLow]);
    release('widgets', 8);
    for (const t of busy) await reached(t.id, (s) => s.state === 'merged');
  });

  it('starts the first Run at a model label a poll saw while the label read before it was in flight', async () => {
    const widgets = await addRepo('widgets');
    // Let registration's own read through; hold the next one, made on the way to the first Run.
    const read = github.holdGetIssue('acme', 'widgets', 7, { skip: 1 });
    const ticket = await register(widgets, 7, { tier: haiku, labels: ['model:claude:haiku/medium'] });
    await read.arrived;

    github.setLabels('acme', 'widgets', 7, ['model:claude:sonnet/medium']);
    await poll();
    read.release(); // answers with the old haiku label

    await reached(ticket.id, (t) => t.state === 'merged');
    expect(runTiers('widgets', 7)).toEqual([sonnet]);
    expect((await api.getTicket(ticket.id)).tier).toEqual(sonnet);
  });

  it('ignores a model label change once the first Run has started', async () => {
    const widgets = await addRepo('widgets');
    const ticket = await register(widgets, 7, { tier: haiku, hold: true });
    // The first Run has started once the Agent has been called (Running begins before worktree setup).
    while (runTiers('widgets', 7).length === 0) await settle();

    github.setLabels('acme', 'widgets', 7, ['model:claude:sonnet/medium']);
    await poll();
    release('widgets', 7);

    await reached(ticket.id, (t) => t.state === 'merged');
    expect(runTiers('widgets', 7)).toEqual([haiku]);
    expect((await api.getTicket(ticket.id)).tier).toEqual(haiku);
    expect(seen.filter((t) => t.id === ticket.id).map((t) => t.tier)).not.toContainEqual(sonnet);
  });

  it('honours a door label tightened to one-way on GitHub before merge', async () => {
    const widgets = await addRepo('widgets');
    const ticket = await register(widgets, 7, { door: 'two-way', labels: ['door:two-way'], hold: true });
    await reached(ticket.id, (t) => t.state === 'running');

    github.setLabels('acme', 'widgets', 7, ['door:one-way']);
    await poll();
    release('widgets', 7);

    await reached(ticket.id, (t) => t.state === 'awaiting-merge');
    expect((await api.getTicket(ticket.id)).door).toBe('one-way');
    expect(github.pulls('acme', 'widgets')[0]?.merged).toBe(false);
  });

  it('honours a door label tightened to one-way after the last poll, just before auto-merge', async () => {
    const widgets = await addRepo('widgets');
    const ticket = await register(widgets, 7, { door: 'two-way', labels: ['door:two-way'], holdReview: true });
    while (!reviewStarted('widgets', 7)) await settle();
    await poll();

    github.setLabels('acme', 'widgets', 7, ['door:one-way']);
    releaseReview('widgets', 7);
    await settle();
    expect(github.calls.filter((c) => c.method === 'mergePullRequest')).toEqual([]);
    await poll(); // the fresh read disagreed with the stored door, so the merge waited for this poll

    await reached(ticket.id, (t) => t.state === 'awaiting-merge');
    expect(github.calls.filter((c) => c.method === 'mergePullRequest')).toEqual([]);
    expect((await api.getTicket(ticket.id)).door).toBe('one-way');
  });

  it('never lets a stale pre-merge label read loosen a door a poll already tightened', async () => {
    const widgets = await addRepo('widgets');
    const ticket = await register(widgets, 7, { door: 'two-way', labels: ['door:two-way'], holdReview: true });
    while (!reviewStarted('widgets', 7)) await settle();
    const read = github.holdGetIssue('acme', 'widgets', 7);
    releaseReview('widgets', 7);
    await read.arrived; // the pre-merge read, answering door:two-way

    github.setLabels('acme', 'widgets', 7, ['door:one-way']);
    await poll();
    expect((await api.getTicket(ticket.id)).door).toBe('one-way');
    read.release();
    await settle();
    expect(github.calls.filter((c) => c.method === 'mergePullRequest')).toEqual([]);
    await poll(); // the stale read disagreed with the stored door, so the merge waited for this poll

    await reached(ticket.id, (t) => t.state === 'awaiting-merge');
    expect(github.calls.filter((c) => c.method === 'mergePullRequest')).toEqual([]);
    expect((await api.getTicket(ticket.id)).door).toBe('one-way');
  });

  it('honours a door label loosened to two-way on GitHub before merge', async () => {
    const widgets = await addRepo('widgets');
    const ticket = await register(widgets, 7, { door: 'one-way', labels: ['door:one-way'], hold: true });
    await reached(ticket.id, (t) => t.state === 'running');

    github.setLabels('acme', 'widgets', 7, ['door:two-way']);
    await poll();
    release('widgets', 7);

    await reached(ticket.id, (t) => t.state === 'merged');
    expect(github.pulls('acme', 'widgets')[0]).toMatchObject({ merged: true, mergeMethod: 'squash' });
  });

  it('still lets the Agent bump a door loosened on GitHub back to one-way', async () => {
    const widgets = await addRepo('widgets');
    const ticket = await register(widgets, 7, { door: 'one-way', labels: ['door:two-way'], hold: true });
    holds.get('widgets#7')!.oneWay = true;
    await reached(ticket.id, (t) => t.state === 'running');
    await poll();
    release('widgets', 7);

    await reached(ticket.id, (t) => t.state === 'awaiting-merge');
    expect((await api.getTicket(ticket.id)).door).toBe('two-way');
    expect(github.pulls('acme', 'widgets')[0]?.merged).toBe(false);
  });

  it('drops a pre-merge label read that a later poll overtook, even when that poll changed nothing', async () => {
    const widgets = await addRepo('widgets');
    const ticket = await register(widgets, 7, { door: 'one-way', labels: ['door:one-way'], holdReview: true });
    while (!reviewStarted('widgets', 7)) await settle();
    github.setLabels('acme', 'widgets', 7, ['door:two-way']); // loosened, not polled yet
    const read = github.holdGetIssue('acme', 'widgets', 7);
    releaseReview('widgets', 7);
    await read.arrived; // the pre-merge read, answering door:two-way

    github.setLabels('acme', 'widgets', 7, ['door:one-way']); // restored
    await poll(); // sees one-way, which is already the stored door
    read.release();
    await settle();
    await poll(); // the read disagreed with the stored door, so the merge waits for this poll

    await reached(ticket.id, (t) => t.state === 'awaiting-merge');
    expect(github.calls.filter((c) => c.method === 'mergePullRequest')).toEqual([]);
    expect((await api.getTicket(ticket.id)).door).toBe('one-way');
  });

  it('drops a first-Run label read that a later poll overtook, even when that poll changed nothing', async () => {
    const widgets = await addRepo('widgets');
    const ticket = await register(widgets, 7, { tier: haiku, labels: ['model:claude:haiku/medium'] });
    github.setLabels('acme', 'widgets', 7, ['model:claude:sonnet/medium']); // not polled yet
    const read = github.holdGetIssue('acme', 'widgets', 7);
    await read.arrived; // the read after worktree setup, answering sonnet

    github.setLabels('acme', 'widgets', 7, ['model:claude:haiku/medium']); // restored
    await poll(); // sees haiku, which is already the stored tier
    read.release();

    await reached(ticket.id, (t) => t.state === 'merged');
    expect(runTiers('widgets', 7)).toEqual([haiku]);
  });

  it('catches a PR merged on GitHub while the Orchestrator was still creating it', async () => {
    const widgets = await addRepo('widgets');
    const create = github.holdCreatePullRequest();
    const ticket = await register(widgets, 7, { door: 'one-way' });
    const prNumber = await create.arrived; // open on GitHub; its number not yet back

    github.mergeOnGitHub('acme', 'widgets', prNumber);
    await poll();
    create.release();
    await reached(ticket.id, (t) => t.state === 'merged' || t.state === 'awaiting-merge');
    await poll();
    await poll();

    expect((await api.getTicket(ticket.id)).state).toBe('merged');
  });

  it('keeps the worktree of a Ticket that went back to Ready after a re-route to a busy Agent', async () => {
    const gadgets = await addRepo('gadgets');
    const widgets = await addRepo('widgets');
    const busy = [
      await register(gadgets, 1, { tier: solLow, hold: true }),
      await register(widgets, 8, { tier: solLow, hold: true }),
    ];
    while (agent.calls.length < 2) await settle();
    const ticket = await register(widgets, 9, { tier: haiku, labels: ['model:codex:gpt-6.2-sol/low'] });
    // Prepared on Claude, re-routed to Codex, whose slots are both busy: back to Ready.
    const states = () => seen.filter((t) => t.id === ticket.id).map((t) => t.state);
    while (!(states().includes('running') && states().at(-1) === 'ready')) await settle();
    const notes = join(root, 'data', 'repos', 'acme', 'widgets', 'work', '9', 'notes.txt');
    writeFileSync(notes, 'local work\n');

    release('gadgets', 1);

    await reached(ticket.id, (t) => t.state === 'merged');
    expect(runTiers('widgets', 9)).toEqual([solLow]);
    expect(existsSync(notes)).toBe(true);
    release('widgets', 8);
    for (const t of busy) await reached(t.id, (s) => s.state === 'merged');
  });

  for (const order of ['the stale poll', 'the fresh read'] as const) {
    it(`never auto-merges while a fresh read says one-way, whatever a stale poll says (${order} lands first)`, async () => {
      const widgets = await addRepo('widgets');
      const ticket = await register(widgets, 7, { door: 'two-way', labels: ['door:two-way'], holdReview: true });
      while (!reviewStarted('widgets', 7)) await settle();
      github.setLabels('acme', 'widgets', 7, ['door:two-way', 'priority']); // a change, so the next poll reads the repo
      const snapshot = github.holdReadRepo();
      await settle();
      clock.advance(GITHUB_POLL_INTERVAL_MS);
      await snapshot.arrived; // this poll's snapshot says door:two-way

      github.setLabels('acme', 'widgets', 7, ['door:one-way']);
      const read = github.holdGetIssue('acme', 'widgets', 7);
      releaseReview('widgets', 7);
      await read.arrived; // the pre-merge read says door:one-way
      const [first, second] = order === 'the stale poll' ? [snapshot, read] : [read, snapshot];
      first.release();
      await settle();
      second.release();
      await settle();
      await poll();

      await reached(ticket.id, (t) => t.state === 'awaiting-merge');
      expect(github.calls.filter((c) => c.method === 'mergePullRequest')).toEqual([]);
    });
  }

  it('waits for the next poll when the stored door is one-way but a fresh read says two-way', async () => {
    const widgets = await addRepo('widgets');
    const ticket = await register(widgets, 7, { door: 'one-way', labels: ['door:one-way'], holdReview: true });
    while (!reviewStarted('widgets', 7)) await settle();
    github.setLabels('acme', 'widgets', 7, ['door:two-way']); // loosened, not polled yet
    releaseReview('widgets', 7);
    await settle();
    await settle();

    expect(github.calls.filter((c) => c.method === 'mergePullRequest')).toEqual([]);
    expect((await api.getTicket(ticket.id)).state).toBe('reviewing');

    await poll(); // stores door:two-way; both now agree
    await reached(ticket.id, (t) => t.state === 'merged');
    expect(github.pulls('acme', 'widgets')[0]).toMatchObject({ merged: true, mergeMethod: 'squash' });
  });

  it('ignores another PR from the same branch once the Ticket has its PR number', async () => {
    const widgets = await addRepo('widgets');
    const ticket = await register(widgets, 7, { door: 'one-way' });
    await reached(ticket.id, (t) => t.state === 'awaiting-merge');
    const { branch, prNumber } = await api.getTicket(ticket.id);

    const other = github.openPullRequestOnGitHub('acme', 'widgets', {
      head: branch,
      base: 'release',
      title: 'Backport',
      body: 'Same branch, other base.',
    });
    github.mergeOnGitHub('acme', 'widgets', other);
    await poll();

    expect((await api.getTicket(ticket.id)).state).toBe('awaiting-merge');
    expect(github.pulls('acme', 'widgets').find((p) => p.number === prNumber)?.merged).toBe(false);
  });

  it('costs an unchanged Target Repo only the change probe on each poll', async () => {
    const widgets = await addRepo('widgets');
    const ticket = await register(widgets, 7);
    await reached(ticket.id, (t) => t.state === 'merged');
    await poll(); // picks up the Orchestrator's own PR and merge
    github.calls.length = 0;

    await poll();
    await poll();
    await poll();

    expect(github.calls).toEqual([
      { method: 'detectChanges', repo: 'acme/widgets' },
      { method: 'detectChanges', repo: 'acme/widgets' },
      { method: 'detectChanges', repo: 'acme/widgets' },
    ]);
  });

  it('never writes a status label to GitHub', async () => {
    const widgets = await addRepo('widgets');
    const labels = ['model:claude:haiku/medium', 'door:one-way', 'bug'];
    const ticket = await register(widgets, 7, { door: 'one-way', labels });
    await reached(ticket.id, (t) => t.state === 'awaiting-merge');
    github.mergeOnGitHub('acme', 'widgets', (await api.getTicket(ticket.id)).prNumber!);
    await poll();
    await reached(ticket.id, (t) => t.state === 'merged');

    expect(github.issue('acme', 'widgets', 7)?.labels).toEqual(labels);
  });
});

