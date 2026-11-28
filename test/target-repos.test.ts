import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startServer, type Server } from '../src/server/server.ts';
import type { ModelTier, TicketState } from '../src/shared/api.ts';
import { createApiClient, type ApiClient } from '../src/web/api.ts';
import { approve, done, FakeAgentRunner, round } from './support/fake-agent-runner.ts';
import { FakeClock } from './support/fake-clock.ts';
import { FakeGhAuth } from './support/fake-gh-auth.ts';
import { FakeGitHub } from './support/fake-github.ts';
import { FakeNotifier } from './support/fake-notifier.ts';
import { commitFile, createBareRemote, git } from './support/git.ts';

const tier: ModelTier = { agent: 'claude', model: 'haiku', effort: 'medium' };
const TOKEN = 'gho_fakeTokenThatMustNeverReachTheDisk';

let currentRoot: string;

describe('Target Repos', () => {
  let root: string;
  let dataDir: string;
  let github: FakeGitHub;
  let ghAuth: FakeGhAuth;
  let agent: FakeAgentRunner;
  let servers: Server[];
  let tokensGivenToGitHub: string[];

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 't3o-test-'));
    currentRoot = root;
    dataDir = join(root, 'data');
    github = new FakeGitHub();
    github.addRepo('acme', 'widgets', createBareRemote(root));
    ghAuth = new FakeGhAuth(TOKEN);
    agent = new FakeAgentRunner();
    servers = [];
    tokensGivenToGitHub = [];
  });

  afterEach(async () => {
    for (const server of servers) await server.close();
    rmSync(root, { recursive: true, force: true });
  });

  async function start() {
    const server = await startServer({
      env: { T3O_DATA_DIR: dataDir },
      ghAuth,
      github: (token) => {
        tokensGivenToGitHub.push(token);
        return github;
      },
      agentRunner: agent,
      clock: new FakeClock(),
      notifier: new FakeNotifier(),
    });
    servers.push(server);
    return createApiClient((path, init) => Promise.resolve(server.app.request(path, init)));
  }

  const repoDir = () => join(dataDir, 'repos', 'acme', 'widgets');

  // Registers issue #7 and waits for the Ticket to reach `until` over SSE.
  async function registerTicket(api: ApiClient, repoId: number, until: TicketState) {
    github.addIssue('acme', 'widgets', { number: 7, title: 'Add a greeting file', body: 'Write hello.txt.' });
    const events = await api.events();
    await events.next(); // snapshot
    const ticket = await api.registerTicket({ repoId, issueNumber: 7, tier, door: 'two-way' });
    for (let state = ticket.state; state !== until; ) {
      const event = await events.next();
      if (event.type === 'ticket' && event.ticket.id === ticket.id) state = event.ticket.state;
    }
    await events.close();
    return ticket;
  }

  function scriptMergingRun() {
    agent.script('run', (req) => {
      commitFile(req.cwd, 'hello.txt', 'hello\n', 'Add hello.txt');
      return done();
    });
    agent.script('review', () => approve());
  }

  // A Run that stays Running until finish(); `started` resolves once the Agent is at work.
  function scriptHeldRun(): { started: Promise<void>; finish: () => void } {
    let finish!: () => void;
    let begun!: () => void;
    const mayFinish = new Promise<void>((resolve) => (finish = resolve));
    const started = new Promise<void>((resolve) => (begun = resolve));
    agent.script('run', async (req) => {
      begun();
      await mayFinish;
      commitFile(req.cwd, 'hello.txt', 'hello\n', 'Add hello.txt');
      return done();
    });
    agent.script('review', () => approve());
    return { started, finish };
  }

  describe('startup', () => {
    it('refuses with a message naming `gh auth login` when gh is logged out', async () => {
      ghAuth.logOut();

      await expect(start()).rejects.toThrow(/gh auth login/);
    });

    it('hands the gh token to the GitHub client', async () => {
      await start();

      expect(tokensGivenToGitHub).toEqual([TOKEN]);
    });

    it('never writes the token to the data folder or the database', async () => {
      const api = await start();
      await api.addTargetRepo({ owner: 'acme', name: 'widgets' });
      for (const server of servers.splice(0)) await server.close();

      const holdingToken = filesUnder(dataDir).filter((file) => readFileSync(file).includes(TOKEN));
      expect(holdingToken).toEqual([]);
    });
  });

  describe('adding', () => {
    it('makes a bare clone under repos/<owner>/<repo>/git and lists the Target Repo', async () => {
      const api = await start();

      const repo = await api.addTargetRepo({ owner: 'acme', name: 'widgets' });

      expect(repo).toMatchObject({ owner: 'acme', name: 'widgets', defaultBranch: 'main' });
      const clone = join(dataDir, 'repos', 'acme', 'widgets', 'git');
      expect(git(clone, 'rev-parse', '--is-bare-repository')).toBe('true');
      expect(git(clone, 'log', '-1', '--format=%s', 'origin/main')).toBe('Initial commit');
      expect(await api.listTargetRepos()).toEqual([repo]);
    });

    it('refuses a Target Repo that is already added', async () => {
      const api = await start();
      await api.addTargetRepo({ owner: 'acme', name: 'widgets' });

      await expect(api.addTargetRepo({ owner: 'acme', name: 'widgets' })).rejects.toThrow(/409.*already/);
    });

    it('treats a different spelling case as the same Target Repo, leaving a Running Ticket alone', async () => {
      const api = await start();
      const repo = await api.addTargetRepo({ owner: 'acme', name: 'widgets' });
      const run = scriptHeldRun();
      try {
        await registerTicket(api, repo.id, 'running');
        await run.started;

        await expect(api.addTargetRepo({ owner: 'Acme', name: 'Widgets' })).rejects.toThrow(/409.*already/);

        expect(existsSync(join(repoDir(), 'work', '7'))).toBe(true);
        expect(await api.listTargetRepos()).toEqual([repo]);
      } finally {
        run.finish();
      }
    });

    it('keeps one workspace per repo whatever the spelling', async () => {
      const api = await start();

      const repo = await api.addTargetRepo({ owner: 'Acme', name: 'Widgets' });

      expect(repo).toMatchObject({ owner: 'Acme', name: 'Widgets' });
      expect(git(join(repoDir(), 'git'), 'rev-parse', '--is-bare-repository')).toBe('true');
      expect(readdirSync(join(dataDir, 'repos'))).toEqual(['acme']);
    });

    it('accepts only one of two adds of the same repo at once', async () => {
      const api = await start();

      const results = await Promise.allSettled([
        api.addTargetRepo({ owner: 'acme', name: 'widgets' }),
        api.addTargetRepo({ owner: 'acme', name: 'widgets' }),
      ]);

      expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
      const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
      expect(String(rejected.reason)).toMatch(/409.*already/);
      expect(git(join(repoDir(), 'git'), 'log', '-1', '--format=%s', 'origin/main')).toBe('Initial commit');
      expect(await api.listTargetRepos()).toHaveLength(1);
    });

    it('folds case-variant Target Repos left by an older data folder into one, keeping its Tickets and Runs', async () => {
      // A data folder at schema version 1, before spellings were compared without case.
      mkdirSync(dataDir, { recursive: true });
      const db = new DatabaseSync(join(dataDir, 't3o.db'));
      db.exec(`CREATE TABLE target_repos (
                 id INTEGER PRIMARY KEY, owner TEXT NOT NULL, name TEXT NOT NULL,
                 default_branch TEXT NOT NULL, UNIQUE (owner, name));
               CREATE TABLE tickets (id INTEGER PRIMARY KEY, repo_id INTEGER NOT NULL REFERENCES target_repos(id),
                 issue_number INTEGER NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL, branch TEXT NOT NULL,
                 tier TEXT NOT NULL, door TEXT NOT NULL, state TEXT NOT NULL, pr_number INTEGER,
                 UNIQUE (repo_id, issue_number));
               CREATE TABLE runs (id INTEGER PRIMARY KEY, ticket_id INTEGER NOT NULL REFERENCES tickets(id),
                 tier TEXT NOT NULL, started_at TEXT NOT NULL, ended_at TEXT, outcome TEXT, reason TEXT);
               CREATE TABLE reviews (id INTEGER PRIMARY KEY, ticket_id INTEGER NOT NULL REFERENCES tickets(id),
                 tier TEXT NOT NULL, started_at TEXT NOT NULL, ended_at TEXT, verdict TEXT, findings TEXT);
               INSERT INTO target_repos (owner, name, default_branch) VALUES ('acme', 'widgets', 'main');
               INSERT INTO target_repos (owner, name, default_branch) VALUES ('Acme', 'Widgets', 'main');
               INSERT INTO tickets VALUES (1, 1, 7, 'Add a greeting file', 'Write hello.txt.', 't3o/7-add-a-greeting-file',
                 '{"agent":"claude","model":"haiku","effort":"medium"}', 'two-way', 'merged', 1000);
               INSERT INTO runs VALUES (1, 1, '{"agent":"claude","model":"haiku","effort":"medium"}',
                 '2026-01-01T09:00:00.000Z', '2026-01-01T09:05:00.000Z', 'done', '');
               PRAGMA user_version = 1;`);
      db.close();

      const api = await start();

      expect(await api.listTargetRepos()).toEqual([{ id: 1, owner: 'acme', name: 'widgets', defaultBranch: 'main' }]);
      // Its Tickets and their Runs came through the migration.
      expect((await api.getTicket(1)).runs).toEqual([
        { tier, startedAt: '2026-01-01T09:00:00.000Z', endedAt: '2026-01-01T09:05:00.000Z', outcome: 'done' },
      ]);
      await expect(api.addTargetRepo({ owner: 'ACME', name: 'widgets' })).rejects.toThrow(/409.*already/);
    });

    it('refuses names that are not a GitHub owner/repo', async () => {
      const api = await start();

      await expect(api.addTargetRepo({ owner: '..', name: 'widgets' })).rejects.toThrow(/400/);
      await expect(api.addTargetRepo({ owner: 'acme', name: '..' })).rejects.toThrow(/400/);
      await expect(api.addTargetRepo({ owner: 'acme', name: 'a/b' })).rejects.toThrow(/400/);
    });

    it('accepts GitHub names a filesystem would trip on: Windows device names and trailing dots', async () => {
      const api = await start();
      ['con', 'aux.js', 'widgets.'].forEach((name, i) => github.addRepo('acme', name, remoteIn(`remote-${i}`)));

      for (const name of ['con', 'aux.js', 'widgets.']) {
        const repo = await api.addTargetRepo({ owner: 'acme', name });
        expect(repo.name).toBe(name);
      }
      // Each has its own folder, and removing one leaves the others.
      expect(readdirSync(join(dataDir, 'repos', 'acme'))).toHaveLength(3);
      const [con] = await api.listTargetRepos();
      await api.removeTargetRepo(con!.id);
      expect(readdirSync(join(dataDir, 'repos', 'acme'))).toHaveLength(2);
    });

    it('accepts an Enterprise Managed User owner, which has an underscore', async () => {
      github.addRepo('octocat_acme', 'widgets', remoteIn('emu'));
      const api = await start();

      const repo = await api.addTargetRepo({ owner: 'octocat_acme', name: 'widgets' });

      expect(repo).toMatchObject({ owner: 'octocat_acme', name: 'widgets' });
    });
  });

  describe('removing', () => {
    it('deletes its clone, worktrees, scratch folders and Run logs', async () => {
      const api = await start();
      const repo = await api.addTargetRepo({ owner: 'acme', name: 'widgets' });
      scriptMergingRun();
      await registerTicket(api, repo.id, 'merged');
      expect(existsSync(join(repoDir(), 'work', '7'))).toBe(true);
      expect(existsSync(join(repoDir(), 'scratch', '7'))).toBe(true);
      // Run logs live at logs/<run-id>.jsonl; the first Run in a fresh data folder is Run 1.
      mkdirSync(join(dataDir, 'logs'), { recursive: true });
      writeFileSync(join(dataDir, 'logs', '1.jsonl'), '{}\n');
      writeFileSync(join(dataDir, 'logs', '999.jsonl'), '{}\n');

      await api.removeTargetRepo(repo.id);

      expect(existsSync(repoDir())).toBe(false);
      expect(existsSync(join(dataDir, 'logs', '1.jsonl'))).toBe(false);
      expect(existsSync(join(dataDir, 'logs', '999.jsonl'))).toBe(true); // another Run's log
      expect(await api.listTargetRepos()).toEqual([]);
    });

    it('keeps its Tickets’ Run records, across a restart too', async () => {
      const api = await start();
      const repo = await api.addTargetRepo({ owner: 'acme', name: 'widgets' });
      scriptMergingRun();
      const ticket = await registerTicket(api, repo.id, 'merged');
      const before = await api.getTicket(ticket.id);

      await api.removeTargetRepo(repo.id);
      for (const server of servers.splice(0)) await server.close();
      const after = await (await start()).getTicket(ticket.id);

      expect(before.runs).toHaveLength(1);
      expect(before.reviews).toHaveLength(1);
      expect(after.runs).toEqual(before.runs);
      expect(after.reviews).toEqual(before.reviews);
    });

    it('is refused with a clear error while one of its Tickets is Running', async () => {
      const api = await start();
      const repo = await api.addTargetRepo({ owner: 'acme', name: 'widgets' });
      const run = scriptHeldRun();
      try {
        await registerTicket(api, repo.id, 'running');
        await run.started;

        await expect(api.removeTargetRepo(repo.id)).rejects.toThrow(/409.*#7 is Running/);

        expect(existsSync(join(repoDir(), 'work', '7'))).toBe(true);
        expect(await api.listTargetRepos()).toEqual([repo]);
      } finally {
        run.finish();
      }
    });

    it('stays listed and can be retried when cleanup fails', async () => {
      const api = await start();
      const repo = await api.addTargetRepo({ owner: 'acme', name: 'widgets' });
      scriptMergingRun();
      await registerTicket(api, repo.id, 'merged');
      // A folder where Run 1's log should be: deleting the log fails.
      mkdirSync(join(dataDir, 'logs', '1.jsonl', 'stuck'), { recursive: true });

      await expect(api.removeTargetRepo(repo.id)).rejects.toThrow(/500/);
      expect(await api.listTargetRepos()).toEqual([repo]);
      await expect(api.addTargetRepo({ owner: 'acme', name: 'widgets' })).rejects.toThrow(/409.*already/);

      rmSync(join(dataDir, 'logs', '1.jsonl'), { recursive: true });
      await api.removeTargetRepo(repo.id);

      expect(await api.listTargetRepos()).toEqual([]);
      expect(existsSync(repoDir())).toBe(false);
    });

    it('takes no new Tickets or Plans after cleanup failed part-way, across a restart, until DELETE finishes', async () => {
      let api = await start();
      const repo = await api.addTargetRepo({ owner: 'acme', name: 'widgets' });
      scriptMergingRun();
      await registerTicket(api, repo.id, 'merged');
      mkdirSync(join(dataDir, 'logs', '1.jsonl', 'stuck'), { recursive: true }); // log deletion fails
      await expect(api.removeTargetRepo(repo.id)).rejects.toThrow(/500/);
      github.addIssue('acme', 'widgets', { number: 8, title: 'Another', body: 'More.' });

      for (let restarted = 0; restarted < 2; restarted++) {
        await expect(api.registerTicket({ repoId: repo.id, issueNumber: 8, tier, door: 'two-way' })).rejects.toThrow(
          /409.*being removed/,
        );
        await expect(api.startPlan({ repoId: repo.id, idea: 'Anything' })).rejects.toThrow(/409.*being removed/);
        for (const server of servers.splice(0)) await server.close();
        api = await start();
      }
      expect(agent.calls.map((c) => c.mode)).toEqual(['run', 'review']); // only the first Ticket's

      rmSync(join(dataDir, 'logs', '1.jsonl'), { recursive: true });
      await api.removeTargetRepo(repo.id);

      expect(await api.listTargetRepos()).toEqual([]);
      expect(existsSync(repoDir())).toBe(false);
    });

    it('stops the repo\'s Planner turn first, so nothing it writes outlives the removal', async () => {
      const api = await start();
      const repo = await api.addTargetRepo({ owner: 'acme', name: 'widgets' });
      let release!: () => void;
      const released = new Promise<void>((resolve) => (release = resolve));
      let begun!: () => void;
      const turnBegun = new Promise<void>((resolve) => (begun = resolve));
      let ended!: () => void;
      const turnEnded = new Promise<void>((resolve) => (ended = resolve));
      agent.script('plan', async (req) => {
        begun();
        const aborted = new Promise<void>((resolve) => req.signal.addEventListener('abort', () => resolve()));
        await Promise.race([released, aborted]);
        mkdirSync(req.scratchDir, { recursive: true });
        writeFileSync(join(req.scratchDir, 'notes.md'), 'late write\n');
        ended();
        return round([{ question: 'Plain text?', recommended: 'Yes.' }]);
      });
      await api.startPlan({ repoId: repo.id, idea: 'A greeting file' });
      await turnBegun;

      await api.removeTargetRepo(repo.id);
      release();
      await turnEnded;
      await new Promise((resolve) => setTimeout(resolve, 50)); // let the turn wind down

      expect(existsSync(repoDir())).toBe(false);
    });

    it('wins over a Ticket registration still waiting on GitHub, which is refused', async () => {
      const api = await start();
      const repo = await api.addTargetRepo({ owner: 'acme', name: 'widgets' });
      github.addIssue('acme', 'widgets', { number: 7, title: 'Add a greeting file', body: 'Write hello.txt.' });
      const lookup = github.holdIssueLookups();
      const registering = api.registerTicket({ repoId: repo.id, issueNumber: 7, tier, door: 'two-way' });
      await lookup.started;

      await api.removeTargetRepo(repo.id);
      lookup.release();

      await expect(registering).rejects.toThrow(/409.*removed/);
      expect(agent.calls).toEqual([]);
      expect(existsSync(repoDir())).toBe(false);
    });

    it('can be added again afterwards, with a fresh clone', async () => {
      const api = await start();
      const repo = await api.addTargetRepo({ owner: 'acme', name: 'widgets' });
      await api.removeTargetRepo(repo.id);

      const again = await api.addTargetRepo({ owner: 'acme', name: 'widgets' });

      expect(again).toMatchObject({ owner: 'acme', name: 'widgets', defaultBranch: 'main' });
      expect(git(join(repoDir(), 'git'), 'rev-parse', '--is-bare-repository')).toBe('true');
      expect(await api.listTargetRepos()).toEqual([again]);
    });

    it('gives a re-added repo a new id, so requests for the old one never reach it', async () => {
      const api = await start();
      const first = await api.addTargetRepo({ owner: 'acme', name: 'widgets' });
      github.addIssue('acme', 'widgets', { number: 7, title: 'Add a greeting file', body: 'Write hello.txt.' });
      const lookup = github.holdIssueLookups();
      const staleRegistration = api.registerTicket({ repoId: first.id, issueNumber: 7, tier, door: 'two-way' });
      await lookup.started;
      await api.removeTargetRepo(first.id);
      const second = await api.addTargetRepo({ owner: 'acme', name: 'widgets' });
      lookup.release();

      expect(second.id).not.toBe(first.id);
      await expect(staleRegistration).rejects.toThrow(/409.*removed/);
      await expect(api.removeTargetRepo(first.id)).rejects.toThrow(/404/);
      expect(await api.listTargetRepos()).toEqual([second]);
      expect(git(join(repoDir(), 'git'), 'rev-parse', '--is-bare-repository')).toBe('true');
      expect(agent.calls).toEqual([]);
    });

    it('answers 404 for a Target Repo that does not exist', async () => {
      const api = await start();

      await expect(api.removeTargetRepo(42)).rejects.toThrow(/404/);
    });
  });
});

// Another local bare repo standing in for a GitHub remote.
function remoteIn(folder: string): string {
  const dir = join(currentRoot, folder);
  mkdirSync(dir);
  return createBareRemote(dir);
}

function filesUnder(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name));
}
