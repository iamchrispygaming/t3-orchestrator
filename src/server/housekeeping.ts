// Housekeeping: retention and cleanup, at startup and once a day.
//   - Run logs go once their Ticket has been Merged (or cancelled) for the retention
//     period; the Run records, usage and Cost in SQLite stay forever.
//   - A finished Ticket's worktree and scratch folder go (the engine deletes them when
//     the Ticket finishes; this sweep catches any a crash or failed delete left behind).
import { existsSync } from 'node:fs';
import type { Clock } from './clock.ts';
import { deleteRunLogs } from './data-folder.ts';
import type { Store } from './store.ts';
import { RepoWorkspace } from './workspace.ts';

const DAY_MS = 24 * 60 * 60_000;
export const CLEANUP_INTERVAL_MS = DAY_MS;

export type HousekeepingDeps = {
  store: Store;
  clock: Clock;
  dataFolder: string;
  log: (message: string, error?: unknown) => void;
};

export class Housekeeping {
  private deps: HousekeepingDeps;
  private cancelTimer: (() => void) | undefined;
  private running: Promise<void> | undefined;
  private again = false;
  private stopped = false;

  constructor(deps: HousekeepingDeps) {
    this.deps = deps;
  }

  // Cleans up now, then once a day.
  start(): void {
    this.scheduleNext();
    void this.cleanUp();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.cancelTimer?.();
    await this.running;
  }

  // One cleanup at a time: asked for while one runs, it runs once more afterwards,
  // so the latest request always sees the current time. Resolves when that has run.
  cleanUp(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      do {
        this.again = false;
        await this.cleanOnce().catch((error) => this.deps.log('Cleanup failed', error));
      } while (this.again && !this.stopped);
    })().finally(() => (this.running = undefined));
    return this.running;
  }

  private scheduleNext(): void {
    if (this.stopped) return;
    // Returns the cleanup's promise for a test clock to wait on; the real one ignores it.
    this.cancelTimer = this.deps.clock.setTimer(CLEANUP_INTERVAL_MS, () => {
      this.scheduleNext();
      return this.cleanUp();
    });
  }

  private async cleanOnce(): Promise<void> {
    const { store, clock, dataFolder, log } = this.deps;
    const cutoff = new Date(clock.now().getTime() - store.logRetentionDays() * DAY_MS);
    for (const { ticketId, runIds } of store.ticketLogsFinishedBefore(cutoff)) {
      if (this.stopped) return;
      await deleteRunLogs(dataFolder, runIds);
      store.markTicketLogsDeleted(ticketId, clock.now());
    }
    for (const ticket of store.finishedTicketsOnLiveRepos()) {
      if (this.stopped) return;
      const workspace = new RepoWorkspace(dataFolder, ticket.owner, ticket.name);
      const { worktree, scratch } = workspace.ticketFolders(ticket.issueNumber);
      if (!existsSync(worktree) && !existsSync(scratch)) continue;
      await workspace
        .removeTicket(ticket.issueNumber)
        .catch((error) => log(`Could not delete the worktree of Ticket ${ticket.id}`, error));
    }
  }
}
