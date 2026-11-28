// Housekeeping: Run logs deleted after retention, worktrees and scratch folders
// deleted when a Ticket is Merged, cleanup at startup and daily, and database
// backups before migrations.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from '../src/server/server.ts';
import type { ModelTier, TicketState } from '../src/shared/api.ts';
import { createApiClient, type ApiClient } from '../src/web/api.ts';
import { approve, done, FakeAgentRunner } from './support/fake-agent-runner.ts';
import { FakeClock } from './support/fake-clock.ts';
import { FakeGitHub } from './support/fake-github.ts';
import { commitFile, createBareRemote } from './support/git.ts';
import { writeSchemaV1Database } from './support/old-data-folder.ts';

const tier: ModelTier = { agent: 'claude', model: 'haiku', effort: 'medium' };
const days = (n: number) => n * 24 * 60 * 60_000;

describe('housekeeping', () => {
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
    github.addIssue('acme', 'widgets', { number: 7, title: 'Add a greeting file', body: 'Write hello.txt.' });
    agent = new FakeAgentRunner();
    agent.otherwise('run', (req) => {
      commitFile(req.cwd, 'hello.txt', 'hello\n', 'Add hello.txt');
      return done();
    });
    agent.otherwise('review', () => approve());
    clock = new FakeClock('2026-01-01T09:00:00.000Z');
    servers = [];
  });

  afterEach(async () => {
    for (const server of servers) await server.close();
    rmSync(root, { recursive: true, force: true });
  });

  function start(): ApiClient {
    const server = createServer({ env: { T3O_DATA_DIR: dataDir }, github, agentRunner: agent, clock, log: () => {} });
    servers.push(server);
    return createApiClient((path, init) => Promise.resolve(server.app.request(path, init)));
  }

  async function restart(): Promise<ApiClient> {
    for (const server of servers.splice(0)) await server.close();
    return start();
  }

  async function mergeTicket(api: ApiClient) {
    const repo = await api.addTargetRepo({ owner: 'acme', name: 'widgets' });
    const events = await api.events();
    await events.next(); // snapshot
    const ticket = await api.registerTicket({ repoId: repo.id, issueNumber: 7, tier, door: 'two-way' });
    for (let state: TicketState = ticket.state; state !== 'merged'; ) {
      const event = await events.next();
      if (event.type === 'ticket' && event.ticket.id === ticket.id) state = event.ticket.state;
    }
    await events.close();
    return ticket;
  }

  const repoDir = () => join(dataDir, 'repos', 'acme', 'widgets');
  const runLog = (runId: number) => join(dataDir, 'logs', `${runId}.jsonl`);

  it("deletes a Merged Ticket's worktree and scratch folder", async () => {
    const api = start();
    await mergeTicket(api);

    expect(existsSync(join(repoDir(), 'work', '7'))).toBe(false);
    expect(existsSync(join(repoDir(), 'scratch', '7'))).toBe(false);
    expect(existsSync(join(repoDir(), 'git'))).toBe(true); // the clone stays
  });

  describe('Run logs', () => {
    it('are deleted by the daily cleanup 30 days after the Ticket is Merged; its records stay', async () => {
      const api = start();
      const ticket = await mergeTicket(api);
      const before = await api.getTicket(ticket.id);
      expect(existsSync(runLog(1))).toBe(true); // the first Run in a fresh data folder is Run 1

      await clock.advance(days(29));
      expect(existsSync(runLog(1))).toBe(true);

      await clock.advance(days(1));
      expect(existsSync(runLog(1))).toBe(false);
      const after = await api.getTicket(ticket.id);
      expect(after.runs).toHaveLength(1);
      expect(after.runs).toEqual(before.runs);
      expect(after.reviews).toEqual(before.reviews);
    });

    it('past retention while the Orchestrator was stopped are deleted at startup', async () => {
      const ticket = await mergeTicket(start());
      for (const server of servers.splice(0)) await server.close();
      await clock.advance(days(31));

      const api = start();

      await vi.waitFor(() => expect(existsSync(runLog(1))).toBe(false));
      expect((await api.getTicket(ticket.id)).runs).toHaveLength(1);
    });

    it('keep for the retention period the user sets, 30 days by default', async () => {
      const api = start();
      expect((await api.getSettings()).logRetentionDays).toBe(30);
      expect((await api.updateSettings({ logRetentionDays: 7 })).logRetentionDays).toBe(7);
      await mergeTicket(api);

      await clock.advance(days(6));
      expect(existsSync(runLog(1))).toBe(true);
      await clock.advance(days(1));
      expect(existsSync(runLog(1))).toBe(false);
      expect((await (await restart()).getSettings()).logRetentionDays).toBe(7);
    });

    it('refuses a retention period that is not a whole number of days, at least 1', async () => {
      const api = start();

      await expect(api.updateSettings({ logRetentionDays: 0 })).rejects.toThrow(/400/);
      await expect(api.updateSettings({ logRetentionDays: 1.5 })).rejects.toThrow(/400/);
      expect((await api.getSettings()).logRetentionDays).toBe(30);
    });
  });

  it("deletes at startup a Merged Ticket's scratch folder that an earlier delete left behind", async () => {
    await mergeTicket(start());
    for (const server of servers.splice(0)) await server.close();
    mkdirSync(join(repoDir(), 'scratch', '7', 'cache'), { recursive: true }); // as a failed delete leaves it

    start();

    await vi.waitFor(() => expect(existsSync(join(repoDir(), 'scratch', '7'))).toBe(false));
  });

  describe('database backups', () => {
    const backupsDir = () => join(dataDir, 'backups');
    // An older data folder whose one Ticket is titled `title`.
    const writeOldDatabase = (title: string) =>
      writeSchemaV1Database(
        dataDir,
        `INSERT INTO target_repos (owner, name, default_branch) VALUES ('acme', 'widgets', 'main');
         INSERT INTO tickets VALUES (1, 1, 7, '${title}', 'Write hello.txt.', 't3o/7-add-a-greeting-file',
           '{"agent":"claude","model":"haiku","effort":"medium"}', 'two-way', 'merged', 1000);`,
      );
    const readBackup = (file: string) => {
      const db = new DatabaseSync(join(backupsDir(), file), { readOnly: true });
      try {
        const { user_version } = db.prepare('PRAGMA user_version').get() as { user_version: number };
        const { title } = db.prepare('SELECT title FROM tickets').get() as { title: string };
        return { version: user_version, title };
      } finally {
        db.close();
      }
    };

    it('copies the database before a pending migration runs, unchanged', async () => {
      writeOldDatabase('Add a greeting file');

      const api = start();

      expect((await api.getTicket(1)).title).toBe('Add a greeting file'); // migrated and serving
      const backups = readdirSync(backupsDir());
      expect(backups).toHaveLength(1);
      expect(readBackup(backups[0]!)).toEqual({ version: 1, title: 'Add a greeting file' });
    });

    it('keeps only the last 3 backups', async () => {
      for (const upgrade of ['first', 'second', 'third', 'fourth']) {
        for (const server of servers.splice(0)) await server.close();
        rmSync(join(dataDir, 't3o.db'), { force: true });
        writeOldDatabase(upgrade);
        start();
      }

      const kept = readdirSync(backupsDir()).sort().map((file) => readBackup(file).title);
      expect(kept).toEqual(['second', 'third', 'fourth']);
    });

    it('makes none for a fresh data folder, or when nothing is pending', async () => {
      start();
      await restart();

      expect(existsSync(backupsDir()) ? readdirSync(backupsDir()) : []).toEqual([]);
    });
  });
});
