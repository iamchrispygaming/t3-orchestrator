// The SQLite store (`node:sqlite`): one file, forward migrations at startup.
import { DatabaseSync } from 'node:sqlite';
import type { Blocker } from './github.ts';
import type { QuotaReading } from './quota.ts';
import type {
  Agent,
  Door,
  ModelTier,
  ParallelLimits,
  PlanDraft,
  PlanMessage,
  PlanStatus,
  ReviewRecord,
  RunOutcomeKind,
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
     owner TEXT NOT NULL COLLATE NOCASE, -- the blocker's repository: dependencies can cross repos
     name TEXT NOT NULL COLLATE NOCASE,
     issue_number INTEGER NOT NULL,
     merged INTEGER NOT NULL DEFAULT 0, -- GitHub showed a merged PR closing it
     PRIMARY KEY (ticket_id, owner, name, issue_number)
   );`,
  // Target Repo removal. Each registration of a repo gets its own row and an id that is
  // never reused (AUTOINCREMENT), so a request naming an old registration can never act
  // on a newer one; a removed row stays, so its Tickets' Runs and Reviews stay on record.
  // The table is rebuilt to drop the old UNIQUE (owner, name), which forced id reuse.
  // GitHub matches owner/repo whatever the case, so one repo has one live row. An older
  // data folder may hold one repo under several spellings: the first one added is kept.
  `CREATE TABLE target_repos_new (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     owner TEXT NOT NULL,
     name TEXT NOT NULL,
     default_branch TEXT NOT NULL,
     removing_since TEXT, -- cleanup started; no new work until it finishes
     removed_at TEXT
   );
   INSERT INTO target_repos_new (id, owner, name, default_branch)
     SELECT id, owner, name, default_branch FROM target_repos;
   DROP TABLE target_repos;
   ALTER TABLE target_repos_new RENAME TO target_repos;
   UPDATE target_repos SET removed_at = '1970-01-01T00:00:00.000Z'
     WHERE id NOT IN (SELECT min(id) FROM target_repos GROUP BY lower(owner), lower(name));
   CREATE UNIQUE INDEX target_repos_live ON target_repos (lower(owner), lower(name)) WHERE removed_at IS NULL;`,
  // Escalation: why a Run failed (and the note the next Run gets), the Handback
  // reason, and the head the Orchestrator last pushed to the Ticket's branch.
  `ALTER TABLE runs ADD COLUMN failure_note TEXT;
   ALTER TABLE tickets ADD COLUMN handback_reason TEXT;
   ALTER TABLE tickets ADD COLUMN published_head TEXT;`,
  // Usage and Cost per Run and Review (kept forever), the last quota reading per
  // Agent, and what a Paused Ticket returns to.
  `ALTER TABLE runs ADD COLUMN input_tokens INTEGER;
   ALTER TABLE runs ADD COLUMN output_tokens INTEGER;
   ALTER TABLE runs ADD COLUMN cost_usd REAL; -- NULL: no usage reported, or no price for the model
   ALTER TABLE reviews ADD COLUMN input_tokens INTEGER;
   ALTER TABLE reviews ADD COLUMN output_tokens INTEGER;
   ALTER TABLE reviews ADD COLUMN cost_usd REAL;
   CREATE TABLE quota_readings (
     agent TEXT PRIMARY KEY,
     status TEXT NOT NULL,
     resets_at TEXT,
     utilization REAL,
     seen_at TEXT NOT NULL
   );
   ALTER TABLE tickets ADD COLUMN paused_from TEXT;
   ALTER TABLE tickets ADD COLUMN quota_hold TEXT;`,
];

// Run outcomes that are not failures: the next Run's instructions skip past them
// to the last real failure.
const NOT_FAILURES: RunOutcomeKind[] = ['quota-hit', 'interrupted'];

export const defaultParallelLimits: ParallelLimits = { claude: 2, codex: 2 };

export type StoredApprovedPlan = { id: number; repoId: number; approvedAt: string };

export type NewTicket = Omit<
  StoredTicket,
  'id' | 'repo' | 'prNumber' | 'handbackReason' | 'publishedHead' | 'pausedFrom' | 'quotaHold'
> & {
  planId: number;
  planPosition: number;
  blockers: Blocker[];
};

type Row = Record<string, unknown>;

const SELECT_TICKETS = `SELECT t.*, r.owner || '/' || r.name AS repo
  FROM tickets t JOIN target_repos r ON r.id = t.repo_id`;

// `publishedHead`: the commit the Orchestrator last pushed to the Ticket's branch.
// How Routing treats a Ticket's next Run despite quota: 'same-tier' after a quota hit
// mid-Run (wait for this Agent, never move); 'override' after a manual resume (start now).
export type QuotaHold = 'same-tier' | 'override';

export type StoredTicket = Ticket & {
  body: string;
  publishedHead: string | null;
  pausedFrom: TicketState | null;
  quotaHold: QuotaHold | null;
};

// One Run's or Review's usage, with its Cost when it could be priced.
export type UsageRecord = { inputTokens: number; outputTokens: number; costUsd: number | null };

export type CostHistoryRow = { kind: 'run' | 'review'; tier: ModelTier; costUsd: number };

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
    // SQLite's way to rebuild a table others point at: foreign keys off (it can't be
    // switched inside a transaction), then every reference checked before committing.
    this.db.exec('PRAGMA foreign_keys = OFF');
    try {
      for (let version = applied; version < migrations.length; version++) {
        this.db.exec('BEGIN');
        try {
          this.db.exec(migrations[version]!);
          const broken = this.db.prepare('PRAGMA foreign_key_check').all();
          if (broken.length > 0) throw new Error(`migration ${version + 1} broke references: ${JSON.stringify(broken)}`);
          this.db.exec(`PRAGMA user_version = ${version + 1}`);
          this.db.exec('COMMIT');
        } catch (error) {
          this.db.exec('ROLLBACK');
          throw error;
        }
      }
    } finally {
      this.db.exec('PRAGMA foreign_keys = ON');
    }
  }

  // Every registration gets a fresh id, even for a repo that was added and removed before.
  addTargetRepo(repo: Omit<TargetRepo, 'id'>): TargetRepo {
    const { lastInsertRowid } = this.db
      .prepare('INSERT INTO target_repos (owner, name, default_branch) VALUES (?, ?, ?)')
      .run(repo.owner, repo.name, repo.defaultBranch);
    return { id: Number(lastInsertRowid), ...repo };
  }

  // Only Target Repos the user has not removed (a removal under way still counts);
  // removed ones are history. Owner and repo names compare without case, as on GitHub.
  getTargetRepo(id: number): TargetRepo | undefined {
    const row = this.db
      .prepare('SELECT * FROM target_repos WHERE id = ? AND removed_at IS NULL')
      .get(id) as Row | undefined;
    return row && toTargetRepo(row);
  }

  findTargetRepo(owner: string, name: string): TargetRepo | undefined {
    const row = this.db
      .prepare(
        'SELECT * FROM target_repos WHERE lower(owner) = lower(?) AND lower(name) = lower(?) AND removed_at IS NULL',
      )
      .get(owner, name) as Row | undefined;
    return row && toTargetRepo(row);
  }

  listTargetRepos(): TargetRepo[] {
    const rows = this.db.prepare('SELECT * FROM target_repos WHERE removed_at IS NULL ORDER BY id').all() as Row[];
    return rows.map(toTargetRepo);
  }

  // Set when removal starts and kept until it finishes, across restarts too.
  isTargetRepoRemoving(id: number): boolean {
    const row = this.db.prepare('SELECT removing_since FROM target_repos WHERE id = ?').get(id) as Row | undefined;
    return row?.removing_since != null;
  }

  markTargetRepoRemoving(id: number, since: Date): void {
    this.db
      .prepare('UPDATE target_repos SET removing_since = ? WHERE id = ? AND removing_since IS NULL')
      .run(since.toISOString(), id);
  }

  markTargetRepoRemoved(id: number, removedAt: Date): void {
    this.db.prepare('UPDATE target_repos SET removed_at = ? WHERE id = ?').run(removedAt.toISOString(), id);
  }

  listRunIds(repoId: number): number[] {
    const rows = this.db
      .prepare('SELECT runs.id FROM runs JOIN tickets ON tickets.id = runs.ticket_id WHERE tickets.repo_id = ?')
      .all(repoId) as Row[];
    return rows.map((r) => Number(r.id));
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
    this.recordBlockers(id, t.blockers);
    return this.getTicket(id)!;
  }

  // Adds blockers and records merge evidence; evidence once seen is never taken back.
  recordBlockers(ticketId: number, blockers: Blocker[]): void {
    const record = this.db.prepare(
      `INSERT INTO ticket_blockers (ticket_id, owner, name, issue_number, merged) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (ticket_id, owner, name, issue_number) DO UPDATE SET merged = MAX(merged, excluded.merged)`,
    );
    for (const b of blockers) record.run(ticketId, b.owner, b.name, b.number, b.merged ? 1 : 0);
  }

  // Blockers not yet merged: no merge evidence from GitHub, and no Merged Ticket
  // for that issue in that repository.
  unmetBlockers(ticketId: number): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM ticket_blockers b
         WHERE b.ticket_id = ? AND b.merged = 0 AND NOT EXISTS (
           SELECT 1 FROM tickets blocker JOIN target_repos r ON r.id = blocker.repo_id
           WHERE r.owner = b.owner AND r.name = b.name
             AND blocker.issue_number = b.issue_number AND blocker.state = 'merged'
         )`,
      )
      .get(ticketId) as { n: number };
    return Number(row.n);
  }

  waitingTickets(): StoredTicket[] {
    return (this.db.prepare(`${SELECT_TICKETS} WHERE t.state = 'waiting' ORDER BY t.id`).all() as Row[]).map(toTicket);
  }

  // Ready Tickets in queue order: oldest-approved Plan first, then Plan order.
  readyQueue(): StoredTicket[] {
    const rows = this.db
      .prepare(
        `${SELECT_TICKETS} LEFT JOIN approved_plans p ON p.id = t.plan_id
         WHERE t.state = 'ready' AND r.removing_since IS NULL AND r.removed_at IS NULL -- no work on a repo being removed
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
    const row = this.db.prepare(`${SELECT_TICKETS} WHERE t.id = ?`).get(id) as Row | undefined;
    return row && toTicket(row);
  }

  // Tickets on Target Repos the user has not removed.
  listTickets(): StoredTicket[] {
    return (this.db.prepare(`${SELECT_TICKETS} WHERE r.removed_at IS NULL ORDER BY t.id`).all() as Row[]).map(toTicket);
  }

  listTicketsOfRepo(repoId: number): StoredTicket[] {
    return (this.db.prepare(`${SELECT_TICKETS} WHERE t.repo_id = ? ORDER BY t.id`).all(repoId) as Row[]).map(toTicket);
  }

  updateTicket(
    id: number,
    change: {
      state?: TicketState;
      prNumber?: number;
      tier?: ModelTier;
      handbackReason?: string;
      publishedHead?: string;
      pausedFrom?: TicketState | null;
      quotaHold?: QuotaHold | null;
    },
  ): void {
    if (change.state !== undefined) this.db.prepare('UPDATE tickets SET state = ? WHERE id = ?').run(change.state, id);
    if (change.pausedFrom !== undefined) this.db.prepare('UPDATE tickets SET paused_from = ? WHERE id = ?').run(change.pausedFrom, id);
    if (change.quotaHold !== undefined) this.db.prepare('UPDATE tickets SET quota_hold = ? WHERE id = ?').run(change.quotaHold, id);
    if (change.prNumber !== undefined) this.db.prepare('UPDATE tickets SET pr_number = ? WHERE id = ?').run(change.prNumber, id);
    if (change.tier !== undefined) {
      this.db.prepare('UPDATE tickets SET tier = ? WHERE id = ?').run(JSON.stringify(change.tier), id);
    }
    if (change.handbackReason !== undefined) {
      this.db.prepare('UPDATE tickets SET handback_reason = ? WHERE id = ?').run(change.handbackReason, id);
    }
    if (change.publishedHead !== undefined) {
      this.db.prepare('UPDATE tickets SET published_head = ? WHERE id = ?').run(change.publishedHead, id);
    }
  }

  startRun(ticketId: number, tier: ModelTier, startedAt: Date): number {
    const { lastInsertRowid } = this.db
      .prepare('INSERT INTO runs (ticket_id, tier, started_at) VALUES (?, ?, ?)')
      .run(ticketId, JSON.stringify(tier), startedAt.toISOString());
    return Number(lastInsertRowid);
  }

  // `reason` is null when the Run succeeded. `failureNote` is what the next Run is
  // told about this one: the reason plus, for red CI, the failing jobs' log tails.
  endRun(id: number, endedAt: Date, outcome: RunOutcomeKind, reason: string | null, failureNote: string | null = null): void {
    this.db
      .prepare('UPDATE runs SET ended_at = ?, outcome = ?, reason = ?, failure_note = ? WHERE id = ?')
      .run(endedAt.toISOString(), outcome, reason, failureNote, id);
  }

  // The note from the Ticket's last failed Run, unless a Run succeeded since.
  lastFailureNote(ticketId: number): string | null {
    const rows = this.db
      .prepare('SELECT outcome, failure_note FROM runs WHERE ticket_id = ? AND outcome IS NOT NULL ORDER BY id DESC')
      .all(ticketId) as Row[];
    for (const row of rows) {
      if (NOT_FAILURES.includes(row.outcome as RunOutcomeKind)) continue;
      return row.failure_note == null ? null : String(row.failure_note);
    }
    return null;
  }

  // The usage a Run's Agent reported, priced as Cost. Recorded whatever the outcome.
  recordRunUsage(id: number, usage: UsageRecord): void {
    this.db
      .prepare('UPDATE runs SET input_tokens = ?, output_tokens = ?, cost_usd = ? WHERE id = ?')
      .run(usage.inputTokens, usage.outputTokens, usage.costUsd, id);
  }

  recordReviewUsage(id: number, usage: UsageRecord): void {
    this.db
      .prepare('UPDATE reviews SET input_tokens = ?, output_tokens = ?, cost_usd = ? WHERE id = ?')
      .run(usage.inputTokens, usage.outputTokens, usage.costUsd, id);
  }

  pausedTickets(): StoredTicket[] {
    return (this.db.prepare(`${SELECT_TICKETS} WHERE t.state = 'paused' ORDER BY t.id`).all() as Row[]).map(toTicket);
  }

  // Every priced Run and Review ever, removed Target Repos' included.
  costHistory(): CostHistoryRow[] {
    const rows = this.db
      .prepare(
        `SELECT 'run' AS kind, tier, cost_usd, 0 AS source, id FROM runs WHERE cost_usd IS NOT NULL
         UNION ALL SELECT 'review' AS kind, tier, cost_usd, 1 AS source, id FROM reviews WHERE cost_usd IS NOT NULL
         ORDER BY source, id`,
      )
      .all() as Row[];
    return rows.map((r) => ({
      kind: r.kind as CostHistoryRow['kind'],
      tier: JSON.parse(String(r.tier)) as ModelTier,
      costUsd: Number(r.cost_usd),
    }));
  }

  getQuotaReading(agent: Agent): QuotaReading | undefined {
    const row = this.db.prepare('SELECT * FROM quota_readings WHERE agent = ?').get(agent) as Row | undefined;
    if (!row) return undefined;
    return {
      status: String(row.status) as QuotaReading['status'],
      ...(row.resets_at == null ? {} : { resetsAt: String(row.resets_at) }),
      ...(row.utilization == null ? {} : { utilization: Number(row.utilization) }),
      seenAt: String(row.seen_at),
    };
  }

  setQuotaReading(agent: Agent, reading: QuotaReading): void {
    this.db
      .prepare(
        `INSERT INTO quota_readings (agent, status, resets_at, utilization, seen_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (agent) DO UPDATE SET status = excluded.status, resets_at = excluded.resets_at,
           utilization = excluded.utilization, seen_at = excluded.seen_at`,
      )
      .run(agent, reading.status, reading.resetsAt ?? null, reading.utilization ?? null, reading.seenAt);
  }

  listRuns(ticketId: number): RunRecord[] {
    const rows = this.db.prepare('SELECT * FROM runs WHERE ticket_id = ? ORDER BY id').all(ticketId) as Row[];
    return rows.map((r) => ({
      tier: JSON.parse(String(r.tier)) as ModelTier,
      startedAt: String(r.started_at),
      endedAt: r.ended_at == null ? null : String(r.ended_at),
      outcome: (r.outcome ?? null) as RunRecord['outcome'],
      reason: r.outcome == null || r.outcome === 'done' || !r.reason ? null : String(r.reason),
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
      findings: r.findings == null ? null : String(r.findings),
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

function toTargetRepo(row: Row): TargetRepo {
  return { id: Number(row.id), owner: String(row.owner), name: String(row.name), defaultBranch: String(row.default_branch) };
}

function toTicket(row: Row): StoredTicket {
  return {
    id: Number(row.id),
    repoId: Number(row.repo_id),
    repo: String(row.repo),
    issueNumber: Number(row.issue_number),
    title: String(row.title),
    body: String(row.body),
    branch: String(row.branch),
    tier: JSON.parse(String(row.tier)) as ModelTier,
    door: String(row.door) as Door,
    state: String(row.state) as TicketState,
    prNumber: row.pr_number == null ? null : Number(row.pr_number),
    handbackReason: row.handback_reason == null ? null : String(row.handback_reason),
    publishedHead: row.published_head == null ? null : String(row.published_head),
    pausedFrom: row.paused_from == null ? null : (String(row.paused_from) as TicketState),
    quotaHold: row.quota_hold == null ? null : (String(row.quota_hold) as QuotaHold),
  };
}
