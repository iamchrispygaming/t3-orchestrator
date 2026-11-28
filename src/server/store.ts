// The SQLite store (`node:sqlite`): one file, forward migrations at startup.
import { DatabaseSync } from 'node:sqlite';
import type {
  Door,
  ModelTier,
  ParallelLimits,
  PlanDraft,
  PlanMessage,
  PlanStatus,
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
  `CREATE TABLE plans (
     id INTEGER PRIMARY KEY AUTOINCREMENT, -- never reused: a late result must not find a newer Plan
     repo_id INTEGER NOT NULL REFERENCES target_repos(id),
     tier TEXT NOT NULL,
     status TEXT NOT NULL,
     created_at TEXT NOT NULL,
     session_id TEXT,
     draft TEXT
   );
   CREATE TABLE plan_messages (
     id INTEGER PRIMARY KEY,
     plan_id INTEGER NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
     sender TEXT NOT NULL,
     text TEXT NOT NULL,
     just_draft INTEGER NOT NULL DEFAULT 0,
     round TEXT,
     at TEXT NOT NULL
   );
   CREATE TABLE settings (
     key TEXT PRIMARY KEY,
     value TEXT NOT NULL
   );`,
  `CREATE TABLE approved_plans (
     id INTEGER PRIMARY KEY,
     repo_id INTEGER NOT NULL REFERENCES target_repos(id),
     approved_at TEXT NOT NULL
   );
   ALTER TABLE tickets ADD COLUMN plan_id INTEGER REFERENCES approved_plans(id);
   ALTER TABLE tickets ADD COLUMN plan_position INTEGER NOT NULL DEFAULT 0;
   CREATE TABLE ticket_blockers (
     ticket_id INTEGER NOT NULL REFERENCES tickets(id),
     issue_number INTEGER NOT NULL,
     PRIMARY KEY (ticket_id, issue_number)
   );`,
];

export const defaultParallelLimits: ParallelLimits = { claude: 2, codex: 2 };

export type StoredApprovedPlan = { id: number; repoId: number; approvedAt: string };

export type NewTicket = Omit<StoredTicket, 'id' | 'prNumber'> & {
  planId: number;
  planPosition: number;
  blockers: number[]; // issue numbers on the same Target Repo
};

type Row = Record<string, unknown>;

export type StoredTicket = Ticket & { body: string };

export type StoredPlan = {
  id: number;
  repoId: number;
  tier: ModelTier;
  status: PlanStatus;
  createdAt: string;
  sessionId: string | null;
  draft: PlanDraft | null;
};

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

  transaction<T>(work: () => T): T {
    this.db.exec('BEGIN');
    try {
      const result = work();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  addApprovedPlan(repoId: number, approvedAt: Date): StoredApprovedPlan {
    const { lastInsertRowid } = this.db
      .prepare('INSERT INTO approved_plans (repo_id, approved_at) VALUES (?, ?)')
      .run(repoId, approvedAt.toISOString());
    return { id: Number(lastInsertRowid), repoId, approvedAt: approvedAt.toISOString() };
  }

  addTicket(t: NewTicket): StoredTicket {
    const { lastInsertRowid } = this.db
      .prepare(
        `INSERT INTO tickets (repo_id, issue_number, title, body, branch, tier, door, state, plan_id, plan_position)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        t.repoId,
        t.issueNumber,
        t.title,
        t.body,
        t.branch,
        JSON.stringify(t.tier),
        t.door,
        t.state,
        t.planId,
        t.planPosition,
      );
    const id = Number(lastInsertRowid);
    const addBlocker = this.db.prepare('INSERT OR IGNORE INTO ticket_blockers (ticket_id, issue_number) VALUES (?, ?)');
    for (const issueNumber of t.blockers) addBlocker.run(id, issueNumber);
    return this.getTicket(id)!;
  }

  // Blockers not yet Merged. A blocker the Orchestrator doesn't track counts as unmet.
  unmetBlockers(ticketId: number): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM ticket_blockers b
         JOIN tickets t ON t.id = b.ticket_id
         LEFT JOIN tickets blocker ON blocker.repo_id = t.repo_id AND blocker.issue_number = b.issue_number
         WHERE b.ticket_id = ? AND (blocker.state IS NULL OR blocker.state != 'merged')`,
      )
      .get(ticketId) as { n: number };
    return Number(row.n);
  }

  // Waiting Tickets that the given issue blocks.
  waitingDependents(repoId: number, issueNumber: number): StoredTicket[] {
    const rows = this.db
      .prepare(
        `SELECT t.* FROM tickets t JOIN ticket_blockers b ON b.ticket_id = t.id
         WHERE t.repo_id = ? AND b.issue_number = ? AND t.state = 'waiting' ORDER BY t.id`,
      )
      .all(repoId, issueNumber) as Row[];
    return rows.map(toTicket);
  }

  // Ready Tickets in queue order: oldest-approved Plan first, then Plan order.
  readyQueue(): StoredTicket[] {
    const rows = this.db
      .prepare(
        `SELECT t.* FROM tickets t LEFT JOIN approved_plans p ON p.id = t.plan_id
         WHERE t.state = 'ready'
         ORDER BY p.approved_at, p.id, t.plan_position, t.id`,
      )
      .all() as Row[];
    return rows.map(toTicket);
  }

  parallelLimits(): ParallelLimits {
    return { ...defaultParallelLimits, ...(this.getSetting('parallelLimits') as Partial<ParallelLimits> | undefined) };
  }

  updateParallelLimits(change: Partial<ParallelLimits>): ParallelLimits {
    this.setSetting('parallelLimits', { ...this.parallelLimits(), ...change });
    return this.parallelLimits();
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

  // A new Plan and its idea, saved together so no one ever sees a Plan without its idea.
  addPlan(plan: { repoId: number; tier: ModelTier; idea: string; createdAt: Date }): StoredPlan {
    const at = plan.createdAt.toISOString();
    this.db.exec('BEGIN');
    try {
      const { lastInsertRowid } = this.db
        .prepare("INSERT INTO plans (repo_id, tier, status, created_at) VALUES (?, ?, 'thinking', ?)")
        .run(plan.repoId, JSON.stringify(plan.tier), at);
      const id = Number(lastInsertRowid);
      this.addPlanMessage(id, { from: 'user', text: plan.idea, justDraft: false, at });
      this.db.exec('COMMIT');
      return this.getPlan(id)!;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  getPlan(id: number): StoredPlan | undefined {
    const row = this.db.prepare('SELECT * FROM plans WHERE id = ?').get(id) as Row | undefined;
    return row && toPlan(row);
  }

  listPlans(): StoredPlan[] {
    return (this.db.prepare('SELECT * FROM plans ORDER BY id').all() as Row[]).map(toPlan);
  }

  updatePlan(id: number, change: { status?: PlanStatus; sessionId?: string; draft?: PlanDraft }): void {
    if (change.status !== undefined) this.db.prepare('UPDATE plans SET status = ? WHERE id = ?').run(change.status, id);
    if (change.sessionId !== undefined) this.db.prepare('UPDATE plans SET session_id = ? WHERE id = ?').run(change.sessionId, id);
    if (change.draft !== undefined) this.db.prepare('UPDATE plans SET draft = ? WHERE id = ?').run(JSON.stringify(change.draft), id);
  }

  deletePlan(id: number): void {
    this.db.prepare('DELETE FROM plans WHERE id = ?').run(id);
  }

  addPlanMessage(planId: number, message: PlanMessage): void {
    this.db
      .prepare('INSERT INTO plan_messages (plan_id, sender, text, just_draft, round, at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(
        planId,
        message.from,
        message.text,
        message.from === 'user' && message.justDraft ? 1 : 0,
        message.from === 'planner' && message.round ? JSON.stringify(message.round) : null,
        message.at,
      );
  }

  listPlanMessages(planId: number): PlanMessage[] {
    const rows = this.db.prepare('SELECT * FROM plan_messages WHERE plan_id = ? ORDER BY id').all(planId) as Row[];
    return rows.map((r): PlanMessage =>
      r.sender === 'user'
        ? { from: 'user', text: String(r.text), justDraft: Number(r.just_draft) === 1, at: String(r.at) }
        : {
            from: 'planner',
            text: String(r.text),
            round: r.round == null ? null : JSON.parse(String(r.round)),
            at: String(r.at),
          },
    );
  }

  getSetting(key: string): unknown {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as Row | undefined;
    return row && JSON.parse(String(row.value));
  }

  setSetting(key: string, value: unknown): void {
    this.db
      .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value')
      .run(key, JSON.stringify(value));
  }
}

function toPlan(row: Row): StoredPlan {
  return {
    id: Number(row.id),
    repoId: Number(row.repo_id),
    tier: JSON.parse(String(row.tier)) as ModelTier,
    status: String(row.status) as PlanStatus,
    createdAt: String(row.created_at),
    sessionId: row.session_id == null ? null : String(row.session_id),
    draft: row.draft == null ? null : (JSON.parse(String(row.draft)) as PlanDraft),
  };
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
