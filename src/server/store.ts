// The SQLite store (`node:sqlite`): one file, forward migrations at startup.
import { DatabaseSync } from 'node:sqlite';
import type {
  Door,
  ModelTier,
  ReviewRecord,
  RunRecord,
  TargetRepo,
  Ticket,
  TicketState,
} from '../shared/api.ts';

// Append only: never edit a migration that has shipped. user_version counts applied ones.
const migrations: string[] = [
  `CREATE TABLE target_repos (
     id INTEGER PRIMARY KEY,
     owner TEXT NOT NULL,
     name TEXT NOT NULL,
     default_branch TEXT NOT NULL,
     UNIQUE (owner, name)
   );
   CREATE TABLE tickets (
     id INTEGER PRIMARY KEY,
     repo_id INTEGER NOT NULL REFERENCES target_repos(id),
     issue_number INTEGER NOT NULL,
     title TEXT NOT NULL,
     body TEXT NOT NULL,
     branch TEXT NOT NULL,
     tier TEXT NOT NULL,
     door TEXT NOT NULL,
     state TEXT NOT NULL,
     pr_number INTEGER,
     UNIQUE (repo_id, issue_number)
   );
   CREATE TABLE runs (
     id INTEGER PRIMARY KEY,
     ticket_id INTEGER NOT NULL REFERENCES tickets(id),
     tier TEXT NOT NULL,
     started_at TEXT NOT NULL,
     ended_at TEXT,
     outcome TEXT,
     reason TEXT
   );
   CREATE TABLE reviews (
     id INTEGER PRIMARY KEY,
     ticket_id INTEGER NOT NULL REFERENCES tickets(id),
     tier TEXT NOT NULL,
     started_at TEXT NOT NULL,
     ended_at TEXT,
     verdict TEXT,
     findings TEXT
   );`,
];

type Row = Record<string, unknown>;

export type StoredTicket = Ticket & { body: string };

export class Store {
  private db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA foreign_keys = ON');
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    const { user_version: applied } = this.db.prepare('PRAGMA user_version').get() as { user_version: number };
    for (let version = applied; version < migrations.length; version++) {
      this.db.exec('BEGIN');
      try {
        this.db.exec(migrations[version]!);
        this.db.exec(`PRAGMA user_version = ${version + 1}`);
        this.db.exec('COMMIT');
      } catch (error) {
        this.db.exec('ROLLBACK');
        throw error;
      }
    }
  }

  addTargetRepo(repo: Omit<TargetRepo, 'id'>): TargetRepo {
    const { lastInsertRowid } = this.db
      .prepare('INSERT INTO target_repos (owner, name, default_branch) VALUES (?, ?, ?)')
      .run(repo.owner, repo.name, repo.defaultBranch);
    return { id: Number(lastInsertRowid), ...repo };
  }

  getTargetRepo(id: number): TargetRepo | undefined {
    const row = this.db.prepare('SELECT * FROM target_repos WHERE id = ?').get(id) as Row | undefined;
    return row && { id: Number(row.id), owner: String(row.owner), name: String(row.name), defaultBranch: String(row.default_branch) };
  }

  addTicket(t: Omit<StoredTicket, 'id' | 'prNumber'>): StoredTicket {
    const { lastInsertRowid } = this.db
      .prepare(
        `INSERT INTO tickets (repo_id, issue_number, title, body, branch, tier, door, state)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(t.repoId, t.issueNumber, t.title, t.body, t.branch, JSON.stringify(t.tier), t.door, t.state);
    return this.getTicket(Number(lastInsertRowid))!;
  }

  getTicket(id: number): StoredTicket | undefined {
    const row = this.db.prepare('SELECT * FROM tickets WHERE id = ?').get(id) as Row | undefined;
    return row && toTicket(row);
  }

  listTickets(): StoredTicket[] {
    return (this.db.prepare('SELECT * FROM tickets ORDER BY id').all() as Row[]).map(toTicket);
  }

  updateTicket(id: number, change: { state?: TicketState; prNumber?: number }): void {
    if (change.state !== undefined) this.db.prepare('UPDATE tickets SET state = ? WHERE id = ?').run(change.state, id);
    if (change.prNumber !== undefined) this.db.prepare('UPDATE tickets SET pr_number = ? WHERE id = ?').run(change.prNumber, id);
  }

  startRun(ticketId: number, tier: ModelTier, startedAt: Date): number {
    const { lastInsertRowid } = this.db
      .prepare('INSERT INTO runs (ticket_id, tier, started_at) VALUES (?, ?, ?)')
      .run(ticketId, JSON.stringify(tier), startedAt.toISOString());
    return Number(lastInsertRowid);
  }

  endRun(id: number, endedAt: Date, outcome: NonNullable<RunRecord['outcome']>, reason: string): void {
    this.db
      .prepare('UPDATE runs SET ended_at = ?, outcome = ?, reason = ? WHERE id = ?')
      .run(endedAt.toISOString(), outcome, reason, id);
  }

  listRuns(ticketId: number): RunRecord[] {
    const rows = this.db.prepare('SELECT * FROM runs WHERE ticket_id = ? ORDER BY id').all(ticketId) as Row[];
    return rows.map((r) => ({
      tier: JSON.parse(String(r.tier)) as ModelTier,
      startedAt: String(r.started_at),
      endedAt: r.ended_at == null ? null : String(r.ended_at),
      outcome: (r.outcome ?? null) as RunRecord['outcome'],
    }));
  }

  startReview(ticketId: number, tier: ModelTier, startedAt: Date): number {
    const { lastInsertRowid } = this.db
      .prepare('INSERT INTO reviews (ticket_id, tier, started_at) VALUES (?, ?, ?)')
      .run(ticketId, JSON.stringify(tier), startedAt.toISOString());
    return Number(lastInsertRowid);
  }

  endReview(id: number, endedAt: Date, verdict: NonNullable<ReviewRecord['verdict']>, findings: string): void {
    this.db
      .prepare('UPDATE reviews SET ended_at = ?, verdict = ?, findings = ? WHERE id = ?')
      .run(endedAt.toISOString(), verdict, findings, id);
  }

  listReviews(ticketId: number): ReviewRecord[] {
    const rows = this.db.prepare('SELECT * FROM reviews WHERE ticket_id = ? ORDER BY id').all(ticketId) as Row[];
    return rows.map((r) => ({
      tier: JSON.parse(String(r.tier)) as ModelTier,
      startedAt: String(r.started_at),
      endedAt: r.ended_at == null ? null : String(r.ended_at),
      verdict: (r.verdict ?? null) as ReviewRecord['verdict'],
    }));
  }
}

function toTicket(row: Row): StoredTicket {
  return {
    id: Number(row.id),
    repoId: Number(row.repo_id),
    issueNumber: Number(row.issue_number),
    title: String(row.title),
    body: String(row.body),
    branch: String(row.branch),
    tier: JSON.parse(String(row.tier)) as ModelTier,
    door: String(row.door) as Door,
    state: String(row.state) as TicketState,
    prNumber: row.pr_number == null ? null : Number(row.pr_number),
  };
}
