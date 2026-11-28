// A data folder left by an older Orchestrator: its database at schema version 1.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// Writes `<dataDir>/t3o.db` at schema version 1, then runs `rows` (INSERTs) in it.
export function writeSchemaV1Database(dataDir: string, rows: string): void {
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
           ${rows}
           PRAGMA user_version = 1;`);
  db.close();
}
