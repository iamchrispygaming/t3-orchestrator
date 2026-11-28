// Follows every Target Repo on GitHub by polling: no webhooks, since a local app
// has no public endpoint. Each poll sends one cheap change probe per repo, and
// only a repo that changed gets the one structured read the engine reconciles.
import type { Clock } from './clock.ts';
import type { Engine } from './engine.ts';
import type { GitHub } from './github.ts';
import type { Store } from './store.ts';

export const GITHUB_POLL_INTERVAL_MS = 30_000;

export class GitHubPoller {
  // Per Target Repo id. Kept in memory: after a restart the first poll reads every repo.
  private etags = new Map<number, string>();
  private cancelTimer: (() => void) | null = null;
  private current: Promise<void> | null = null;
  private stopped = false;
  private deps: {
    store: Store;
    github: GitHub;
    engine: Engine;
    clock: Clock;
    log: (message: string, error?: unknown) => void;
  };

  constructor(deps: GitHubPoller['deps']) {
    this.deps = deps;
  }

  // Polls now, then once every interval.
  start(): void {
    this.tick();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.cancelTimer?.();
    await this.current;
  }

  private tick(): void {
    if (this.stopped) return;
    this.cancelTimer = this.deps.clock.setTimer(GITHUB_POLL_INTERVAL_MS, () => this.tick());
    // A poll still running when the next is due is not doubled up.
    this.current ??= this.pollAll().finally(() => (this.current = null));
  }

  private async pollAll(): Promise<void> {
    const { store, github, engine, log } = this.deps;
    for (const repo of store.listTargetRepos()) {
      try {
        const probe = await github.detectChanges(repo.owner, repo.name, this.etags.get(repo.id) ?? null);
        if (probe.changed) {
          const snapshot = await github.readRepo(repo.owner, repo.name);
          engine.reconcile(repo.id, snapshot);
          // Only a reconciled read moves the ETag on, so a failed read is retried next poll.
          this.etags.set(repo.id, probe.etag);
        }
        engine.polled(repo.id);
      } catch (error) {
        log(`Polling ${repo.owner}/${repo.name} failed`, error);
      }
    }
  }
}
