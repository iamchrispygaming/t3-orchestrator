import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RunRequest } from '../src/server/agent-runner.ts';
import { createServer, type Server } from '../src/server/server.ts';
import type { ModelTier, RunOutcomeKind, Ticket } from '../src/shared/api.ts';
import { createApiClient, type EventStream } from '../src/web/api.ts';
import { approve, delay, done, FakeAgentRunner, hang, noResult, quotaHit } from './support/fake-agent-runner.ts';
import { FakeClock } from './support/fake-clock.ts';
import { FakeGitHub } from './support/fake-github.ts';
import { commitFile, createBareRemote, git } from './support/git.ts';

// The Spec's default Ladder, least to most capable.
const haiku: ModelTier = { agent: 'claude', model: 'haiku', effort: 'medium' };
const solLow: ModelTier = { agent: 'codex', model: 'gpt-6.2-sol', effort: 'low' };
const sonnet: ModelTier = { agent: 'claude', model: 'sonnet', effort: 'medium' };
const solHigh: ModelTier = { agent: 'codex', model: 'gpt-6.2-sol', effort: 'high' };
const opus: ModelTier = { agent: 'claude', model: 'opus', effort: 'high' };
const astra: ModelTier = { agent: 'codex', model: 'gpt-6.2-astra', effort: 'high' };

const minutes = (n: number) => n * 60_000;
const branch = 't3o/7-add-a-greeting-file';

type Handler = Parameters<FakeAgentRunner['script']>[1];
type Until = (latest: Ticket, seen: Ticket[]) => boolean;

const merged: Until = (t) => t.state === 'merged';
const handedBack: Until = (t) => t.state === 'handback';
const readyAgain: Until = (t, seen) => t.state === 'ready' && seen.some((s) => s.state === 'running');

describe('Escalation', () => {
  let root: string;
  let remote: string;
  let github: FakeGitHub;
  let agent: FakeAgentRunner;
  let clock: FakeClock;
  let servers: Server[];

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 't3o-test-'));
    remote = createBareRemote(root);
    github = new FakeGitHub();
    github.addRepo('acme', 'widgets', remote);
    github.addIssue('acme', 'widgets', { number: 7, title: 'Add a greeting file', body: 'Write hello.txt.' });
    agent = new FakeAgentRunner();
    clock = new FakeClock('2026-01-01T09:00:00.000Z');
    servers = [];
  });

  afterEach(async () => {
    for (const server of servers) await server.close();
    rmSync(root, { recursive: true, force: true });
  });

  function start() {
    const server = createServer({ env: { T3O_DATA_DIR: join(root, 'data') }, github, agentRunner: agent, clock });
    servers.push(server);
    return createApiClient((path, init) => Promise.resolve(server.app.request(path, init)));
  }

  // Registers issue #7 at `tier` and follows it over SSE until `until` holds.
  async function follow(tier: ModelTier, until: Until, setup?: (api: ReturnType<typeof start>) => Promise<unknown>) {
    const api = start();
    await setup?.(api);
    const repo = await api.addTargetRepo({ owner: 'acme', name: 'widgets' });
    const events = await api.events();
    await events.next(); // snapshot
    const ticket = await api.registerTicket({ repoId: repo.id, issueNumber: 7, tier, door: 'two-way' });
    const seen = await collect(events, ticket.id, until);
    return { api, ticket, seen };
  }

  async function collect(events: EventStream, id: number, until: Until): Promise<Ticket[]> {
    const seen: Ticket[] = [];
    while (seen.length === 0 || !until(seen.at(-1)!, seen)) {
      const event = await events.next();
      if (event.type !== 'ticket' || event.ticket.id !== id) continue;
      // Ticket events also follow Run, Review and PR changes; keep state or tier changes only.
      const last = seen.at(-1);
      if (last && last.state === event.ticket.state && JSON.stringify(last.tier) === JSON.stringify(event.ticket.tier)) {
        continue;
      }
      seen.push(event.ticket);
    }
    await events.close();
    return seen;
  }

  // A Run that commits and finds CI green.
  const succeeds =
    (prBody = '## Summary\n\nAdds hello.txt.') =>
    (req: RunRequest) => {
      github.setChecks('acme', 'widgets', 'success');
      commitFile(req.cwd, 'hello.txt', 'hello\n', 'Add hello.txt');
      return done({ prBody });
    };

  it('defaults the Ladder to the Spec six tiers and the Run time limit to 60 minutes', async () => {
    const settings = await start().getSettings();

    expect(settings).toEqual({
      plannerTier: opus,
      ladder: [haiku, solLow, sonnet, solHigh, opus, astra],
      runTimeLimitMinutes: 60,
    });
  });

  it('starts a fresh Run one Model Tier up when the Agent reports failed', async () => {
    agent.script('run', () => done({ status: 'failed', reason: 'tests would not pass' }));
    agent.script('run', succeeds());
    agent.script('review', () => approve());

    const { api, ticket, seen } = await follow(haiku, merged);

    expect(seen.map((t) => [t.state, t.tier])).toEqual([
      ['ready', haiku],
      ['running', haiku],
      ['ready', solLow],
      ['running', solLow],
      ['reviewing', solLow],
      ['merged', solLow],
    ]);
    const detail = await api.getTicket(ticket.id);
    expect(detail.runs.map((r) => [r.tier, r.outcome, r.reason])).toEqual([
      [haiku, 'failed', 'tests would not pass'],
      [solLow, 'done', null],
    ]);
  });

  const failureKinds: [string, Handler, RunOutcomeKind][] = [
    ['the Agent reports failed', () => done({ status: 'failed', reason: 'stuck' }), 'failed'],
    ['the Agent reports cannot', () => done({ status: 'cannot', reason: 'unclear Ticket' }), 'cannot'],
    [
      'the Agent crashes',
      () => {
        throw new Error('claude exited with code 1');
      },
      'crashed',
    ],
    ['the Agent exits without a result', () => noResult(), 'crashed'],
    [
      'the Run time limit passes',
      (req) => {
        clock.advance(minutes(61));
        return hang(req);
      },
      'timed-out',
    ],
    ['the Run makes no commits', () => done(), 'no-commits'],
    [
      'CI goes red',
      (req) => {
        commitFile(req.cwd, 'hello.txt', 'oops\n', 'Add hello.txt');
        github.setChecks('acme', 'widgets', 'failure', [{ name: 'test', logTail: 'expected hello' }]);
        return done();
      },
      'ci-failed',
    ],
  ];

  it.each(failureKinds)('escalates exactly one Model Tier when %s', async (_, firstRun, outcome) => {
    agent.script('run', firstRun);
    agent.script('run', succeeds());
    agent.script('review', () => approve());

    const { api, ticket, seen } = await follow(haiku, merged);

    expect(seen.map((t) => [t.state, t.tier])).toEqual([
      ['ready', haiku],
      ['running', haiku],
      ['ready', solLow],
      ['running', solLow],
      ['reviewing', solLow],
      ['merged', solLow],
    ]);
    const detail = await api.getTicket(ticket.id);
    expect(detail.runs.map((r) => [r.tier, r.outcome])).toEqual([
      [haiku, outcome],
      [solLow, 'done'],
    ]);
    expect(detail.runs[0]!.reason).toEqual(expect.any(String));
  });

  it("gives the next Run the previous Run's stated reason", async () => {
    agent.script('run', () => done({ status: 'failed', reason: 'the parser test keeps timing out' }));
    agent.script('run', succeeds());
    agent.script('review', () => approve());

    await follow(haiku, merged);

    expect(agent.calls[0]!.instructions).not.toContain('previous Run');
    expect(agent.calls[1]!.instructions).toContain('Write hello.txt.');
    expect(agent.calls[1]!.instructions).toContain('the parser test keeps timing out');
  });

  it('gives the next Run the failing CI job names and their log tails', async () => {
    agent.script('run', (req) => {
      commitFile(req.cwd, 'hello.txt', 'oops\n', 'Add hello.txt');
      github.setChecks('acme', 'widgets', 'failure', [
        { name: 'unit tests', logTail: "AssertionError: expected 'hello' got 'oops'" },
        { name: 'lint', logTail: 'hello.txt:1 missing trailing newline' },
      ]);
      return done();
    });
    agent.script('run', succeeds());
    agent.script('review', () => approve());

    const { api, ticket } = await follow(haiku, merged);

    const next = agent.calls[1]!.instructions;
    expect(next).toContain('unit tests');
    expect(next).toContain("AssertionError: expected 'hello' got 'oops'");
    expect(next).toContain('lint');
    expect(next).toContain('hello.txt:1 missing trailing newline');
    expect((await api.getTicket(ticket.id)).runs[0]!.reason).toBe('CI failed: unit tests, lint');
  });

  it('starts the next Run from a worktree reset to the latest default branch', async () => {
    let secondRun: { hasFirstRunsFile: boolean; hasNewMainFile: boolean } | undefined;
    agent.script('run', (req) => {
      commitFile(req.cwd, 'half-done.txt', 'wip\n', 'Half done');
      // Meanwhile someone merges to the default branch.
      commitFile(join(root, 'seed'), 'news.txt', 'news\n', 'Unrelated change');
      git(join(root, 'seed'), 'push', remote, 'main');
      return done({ status: 'failed', reason: 'ran out of ideas' });
    });
    agent.script('run', (req) => {
      secondRun = {
        hasFirstRunsFile: existsSync(join(req.cwd, 'half-done.txt')),
        hasNewMainFile: existsSync(join(req.cwd, 'news.txt')),
      };
      return succeeds()(req);
    });
    agent.script('review', () => approve());

    await follow(haiku, merged);

    expect(secondRun).toEqual({ hasFirstRunsFile: false, hasNewMainFile: true });
  });

  it('keeps one branch and one PR: a draft after the first commits, ready on success, force-pushed by later Runs', async () => {
    const pullsSeen: { when: string; count: number; draft: boolean | undefined }[] = [];
    const look = (when: string) => {
      const pulls = github.pulls('acme', 'widgets');
      pullsSeen.push({ when, count: pulls.length, draft: pulls[0]?.draft });
    };
    agent.script('run', () => done({ status: 'failed', reason: 'no idea' })); // no commits: no PR yet
    agent.script('run', (req) => {
      look('second Run');
      commitFile(req.cwd, 'first-try.txt', 'x\n', 'First try');
      github.setChecks('acme', 'widgets', 'failure', [{ name: 'test', logTail: 'boom' }]);
      return done({ prBody: '## Summary\n\nFirst try.' });
    });
    agent.script('run', (req) => {
      look('third Run');
      return succeeds('## Summary\n\nSecond try works.')(req);
    });
    agent.script('review', () => {
      look('Review');
      return approve();
    });

    await follow(haiku, merged);

    expect(pullsSeen).toEqual([
      { when: 'second Run', count: 0, draft: undefined },
      { when: 'third Run', count: 1, draft: true },
      { when: 'Review', count: 1, draft: false },
    ]);
    const pulls = github.pulls('acme', 'widgets');
    expect(pulls).toHaveLength(1);
    expect(pulls[0]).toMatchObject({ head: branch, merged: true });
    expect(pulls[0]!.body).toContain('Second try works.');
    expect(pulls[0]!.body).toContain('Closes #7');
    // Force-pushed: the failed Run's commit is gone from the branch.
    expect(git(remote, 'ls-tree', '--name-only', branch).split('\n').sort()).toEqual(['README.md', 'hello.txt']);
  });

  it('climbs the whole Ladder one tier per failure, then hands the Ticket back with the reason stored', async () => {
    for (let i = 1; i <= 6; i++) agent.script('run', () => done({ status: 'failed', reason: `attempt ${i} failed` }));

    const { api, ticket, seen } = await follow(haiku, handedBack);

    expect(seen.filter((t) => t.state === 'running').map((t) => t.tier)).toEqual([
      haiku,
      solLow,
      sonnet,
      solHigh,
      opus,
      astra,
    ]);
    const detail = await api.getTicket(ticket.id);
    expect(detail.state).toBe('handback');
    expect(detail.handbackReason).toContain('codex:gpt-6.2-astra/high');
    expect(detail.handbackReason).toContain('attempt 6 failed');
    expect(detail.runs.map((r) => [r.tier, r.outcome, r.reason])).toEqual([
      [haiku, 'failed', 'attempt 1 failed'],
      [solLow, 'failed', 'attempt 2 failed'],
      [sonnet, 'failed', 'attempt 3 failed'],
      [solHigh, 'failed', 'attempt 4 failed'],
      [opus, 'failed', 'attempt 5 failed'],
      [astra, 'failed', 'attempt 6 failed'],
    ]);
    expect(agent.calls).toHaveLength(6);
  });

  it('hands the Ticket back when the top tier judges it impossible, keeping the reason across a restart', async () => {
    agent.script('run', () => done({ status: 'cannot', reason: 'the Ticket contradicts itself' }));

    const { ticket } = await follow(astra, handedBack);
    for (const server of servers.splice(0)) await server.close();

    const detail = await start().getTicket(ticket.id);
    expect(detail.state).toBe('handback');
    expect(detail.tier).toEqual(astra);
    expect(detail.handbackReason).toContain('the Ticket contradicts itself');
  });

  it('climbs the Ladder the user set', async () => {
    agent.script('run', () => done({ status: 'failed', reason: 'too hard' }));
    agent.script('run', succeeds());
    agent.script('review', () => approve());

    const { seen } = await follow(haiku, merged, (api) => api.updateSettings({ ladder: [haiku, opus] }));

    expect(seen.filter((t) => t.state === 'running').map((t) => t.tier)).toEqual([haiku, opus]);
  });

  it('cuts a Run off at the Run time limit the user set, measured on the clock', async () => {
    agent.script('run', (req) => {
      clock.advance(minutes(11));
      return hang(req);
    });
    agent.script('run', succeeds());
    agent.script('review', () => approve());

    const { api, ticket } = await follow(haiku, merged, (api) => api.updateSettings({ runTimeLimitMinutes: 10 }));

    expect(agent.calls[0]!.timeoutMs).toBe(minutes(10));
    const detail = await api.getTicket(ticket.id);
    expect(detail.runs.map((r) => [r.outcome, r.reason])).toEqual([
      ['timed-out', 'the Run time limit (10 min) passed'],
      ['done', null],
    ]);
  });

  it('lets a Run take up to the default 60 minutes', async () => {
    agent.script('run', (req) => {
      clock.advance(minutes(59));
      return succeeds()(req);
    });
    agent.script('review', () => approve());

    const { api, ticket } = await follow(haiku, merged);

    expect((await api.getTicket(ticket.id)).runs.map((r) => r.outcome)).toEqual(['done']);
  });

  it('uses up no Model Tier when the Agent hits its quota mid-Run', async () => {
    agent.script('run', (req) => {
      commitFile(req.cwd, 'hello.txt', 'hel', 'Partial');
      return quotaHit();
    });

    const { api, ticket, seen } = await follow(haiku, readyAgain);

    expect(seen.map((t) => [t.state, t.tier])).toEqual([
      ['ready', haiku],
      ['running', haiku],
      ['ready', haiku],
    ]);
    expect((await api.getTicket(ticket.id)).runs.map((r) => [r.tier, r.outcome])).toEqual([[haiku, 'quota-hit']]);
  });

  it('uses up no Model Tier when GitHub errors after the Run', async () => {
    github.failNext('createPullRequest');
    agent.script('run', succeeds());

    const { api, ticket, seen } = await follow(haiku, readyAgain);

    expect(seen.map((t) => [t.state, t.tier])).toEqual([
      ['ready', haiku],
      ['running', haiku],
      ['ready', haiku],
    ]);
    const [run] = (await api.getTicket(ticket.id)).runs;
    expect(run).toMatchObject({ tier: haiku, outcome: 'interrupted' });
    expect(run!.reason).toContain('502 Bad Gateway');
  });

  it('refuses a Ladder with no tiers', async () => {
    await expect(start().updateSettings({ ladder: [] })).rejects.toThrow(/400/);
  });

  it('refuses a Ladder that lists a Model Tier twice', async () => {
    const api = start();

    await expect(api.updateSettings({ ladder: [haiku, haiku, solLow] })).rejects.toThrow(/400/);
    expect((await api.getSettings()).ladder).toEqual([haiku, solLow, sonnet, solHigh, opus, astra]);
  });

  it('counts a quota hit as the outcome even when the Agent winds down past the time limit', async () => {
    agent.script('run', () => quotaHit(), {
      shutdown: async () => {
        clock.advance(minutes(61));
        await delay(20);
      },
    });

    const { api, ticket, seen } = await follow(haiku, readyAgain);

    expect(seen.map((t) => [t.state, t.tier])).toEqual([
      ['ready', haiku],
      ['running', haiku],
      ['ready', haiku],
    ]);
    expect((await api.getTicket(ticket.id)).runs.map((r) => r.outcome)).toEqual(['quota-hit']);
  });

  it("waits for the Agent to wind down after its result before counting the Run's commits", async () => {
    agent.script('run', () => done(), {
      // The last commit lands while the process is exiting.
      shutdown: async (req) => {
        await delay(500);
        github.setChecks('acme', 'widgets', 'success');
        commitFile(req.cwd, 'hello.txt', 'hello\n', 'Add hello.txt');
      },
    });
    agent.script('review', () => approve());

    const { api, ticket } = await follow(haiku, merged);

    expect((await api.getTicket(ticket.id)).runs.map((r) => [r.tier, r.outcome])).toEqual([[haiku, 'done']]);
  });

  it('waits for a timed-out Agent to wind down before pushing and resetting the worktree', async () => {
    let secondRun: { pulls: number; hasLateFile: boolean } | undefined;
    agent.script(
      'run',
      (req) => {
        clock.advance(minutes(61));
        return hang(req);
      },
      {
        shutdown: async (req) => {
          await delay(500);
          commitFile(req.cwd, 'late.txt', 'late\n', 'Committed while being stopped');
        },
      },
    );
    agent.script('run', (req) => {
      secondRun = {
        pulls: github.pulls('acme', 'widgets').length,
        hasLateFile: existsSync(join(req.cwd, 'late.txt')),
      };
      return succeeds()(req);
    });
    agent.script('review', () => approve());

    const { api, ticket } = await follow(haiku, merged);

    // The late commit was counted and pushed (a draft PR), and the next Run starts without it.
    expect(secondRun).toEqual({ pulls: 1, hasLateFile: false });
    expect((await api.getTicket(ticket.id)).runs.map((r) => r.outcome)).toEqual(['timed-out', 'done']);
  });

  it("keeps the Agent's reason and the red CI jobs already reported when a Run with commits reports failed", async () => {
    agent.script('run', (req) => {
      commitFile(req.cwd, 'hello.txt', 'oops\n', 'Add hello.txt');
      github.setChecks('acme', 'widgets', 'failure', [{ name: 'unit tests', logTail: 'expected hello, got oops' }]);
      return done({ status: 'failed', reason: 'I could not make the unit tests pass' });
    });
    agent.script('run', succeeds());
    agent.script('review', () => approve());

    await follow(haiku, merged);

    const next = agent.calls[1]!.instructions;
    expect(next).toContain('I could not make the unit tests pass');
    expect(next).toContain('unit tests');
    expect(next).toContain('expected hello, got oops');
  });

  it("keeps the Agent's stated reason when it reports done and CI goes red", async () => {
    agent.script('run', (req) => {
      commitFile(req.cwd, 'hello.txt', 'oops\n', 'Add hello.txt');
      github.setChecks('acme', 'widgets', 'failure', [{ name: 'lint', logTail: 'missing newline' }]);
      return done({ reason: 'skipped the flaky lint rule' });
    });
    agent.script('run', succeeds());
    agent.script('review', () => approve());

    await follow(haiku, merged);

    const next = agent.calls[1]!.instructions;
    expect(next).toContain('skipped the flaky lint rule');
    expect(next).toContain('lint');
    expect(next).toContain('missing newline');
  });

  it.each([
    [
      'exits non-zero',
      () => {
        throw new Error('claude exited with code 1');
      },
      'crashed',
    ],
    [
      'crosses the time limit while exiting',
      async () => {
        clock.advance(minutes(61));
        await delay(20);
      },
      'timed-out',
    ],
  ] as const)('fails a Run that reports done but then %s', async (_, shutdown, outcome) => {
    agent.script('run', succeeds(), { shutdown });
    agent.script('run', succeeds());
    agent.script('review', () => approve());

    const { api, ticket, seen } = await follow(haiku, merged);

    expect(seen.filter((t) => t.state === 'running').map((t) => t.tier)).toEqual([haiku, solLow]);
    expect((await api.getTicket(ticket.id)).runs.map((r) => r.outcome)).toEqual([outcome, 'done']);
  });

  it("never overwrites a commit someone else pushed to the Ticket's branch, and uses up no tier", async () => {
    agent.script('run', (req) => {
      commitFile(req.cwd, 'first-try.txt', 'x\n', 'First try');
      github.setChecks('acme', 'widgets', 'failure', [{ name: 'test', logTail: 'boom' }]);
      return done();
    });
    agent.script('run', (req) => {
      // Meanwhile the user pushes a fix to the draft PR's branch.
      const mine = join(root, 'mine');
      git(root, 'clone', '-q', '--branch', branch, remote, mine);
      commitFile(mine, 'user.txt', 'mine\n', "The user's fix");
      git(mine, 'push', '-q', 'origin', branch);
      return succeeds()(req);
    });

    const { api, ticket } = await follow(haiku, handedBack);

    const detail = await api.getTicket(ticket.id);
    expect(detail.tier).toEqual(solLow);
    expect(detail.handbackReason).toContain(branch);
    expect(detail.runs.map((r) => [r.tier, r.outcome])).toEqual([
      [haiku, 'ci-failed'],
      [solLow, 'interrupted'],
    ]);
    expect(git(remote, 'ls-tree', '--name-only', branch).split('\n')).toContain('user.txt');
    expect(github.pulls('acme', 'widgets')[0]).toMatchObject({ merged: false });
  });

  it('still escalates on red CI when the failing job logs cannot be read', async () => {
    agent.script('run', (req) => {
      commitFile(req.cwd, 'hello.txt', 'oops\n', 'Add hello.txt');
      github.setChecks('acme', 'widgets', 'failure', [{ name: 'test', logTail: 'boom' }]);
      github.failNext('getFailedJobs');
      return done();
    });
    agent.script('run', succeeds());
    agent.script('review', () => approve());

    const { api, ticket } = await follow(haiku, merged);

    expect((await api.getTicket(ticket.id)).runs.map((r) => [r.tier, r.outcome])).toEqual([
      [haiku, 'ci-failed'],
      [solLow, 'done'],
    ]);
  });

  it("gives the next Run the Agent's stated reason when its Run made no commits", async () => {
    agent.script('run', () => done({ reason: 'hello.txt already looked right to me' }));
    agent.script('run', succeeds());
    agent.script('review', () => approve());

    await follow(haiku, merged);

    expect(agent.calls[1]!.instructions).toContain('hello.txt already looked right to me');
  });

  it("refuses a Run time limit longer than the clock's timers can hold", async () => {
    const api = start();

    await expect(api.updateSettings({ runTimeLimitMinutes: 36_000 })).rejects.toThrow(/400/);
    expect((await api.getSettings()).runTimeLimitMinutes).toBe(60);
  });
});
