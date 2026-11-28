// The repo workspace: per Target Repo a bare clone, per-Ticket worktrees and
// scratch folders, under `<data>/repos/<owner>/<repo>/{git,work/<n>,scratch/<n>}`.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { repoFolder } from './data-folder.ts';

const run = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await run('git', args, {
    cwd,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  return stdout.trim();
}

export type TicketFolders = { worktree: string; scratch: string };

// Git operations on one bare clone run one at a time: Tickets of the same Target
// Repo start in parallel, and concurrent fetches or worktree adds race on git's locks.
const queues = new Map<string, Promise<unknown>>();

function serially<T>(key: string, work: () => Promise<T>): Promise<T> {
  const result = (queues.get(key) ?? Promise.resolve()).catch(() => undefined).then(work);
  const tail = result.catch(() => undefined);
  queues.set(key, tail);
  void tail.then(() => {
    if (queues.get(key) === tail) queues.delete(key);
  });
  return result;
}

export class RepoWorkspace {
  readonly root: string;
  private readonly gitDir: string;

  // One folder per repo whatever the spelling: GitHub ignores case in owner/repo,
  // and so do the default Windows and macOS filesystems.
  constructor(dataFolder: string, owner: string, name: string) {
    this.root = repoFolder(dataFolder, owner, name);
    this.gitDir = join(this.root, 'git');
  }

  // Recursively deletes whatever is in the repo's folder first (left by a failed clone
  // or removal). The caller must make sure no live Target Repo owns that folder.
  async clone(url: string): Promise<void> {
    await this.remove();
    await mkdir(this.root, { recursive: true });
    await git(this.root, 'clone', '--bare', url, this.gitDir);
    // A bare clone maps remote branches onto local ones; track them as origin/* instead
    // so fetching never touches the Ticket branches checked out in worktrees.
    await git(this.gitDir, 'config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*');
    await git(this.gitDir, 'fetch', '--prune', 'origin');
  }

  ticketFolders(issueNumber: number): TicketFolders {
    return {
      worktree: join(this.root, 'work', String(issueNumber)),
      scratch: join(this.root, 'scratch', String(issueNumber)),
    };
  }

  // A fresh worktree for the Ticket on `branch`, reset to the latest default branch.
  // An earlier Run's worktree (and its commits on `branch`) is thrown away first.
  prepareTicket(issueNumber: number, branch: string, defaultBranch: string): Promise<TicketFolders> {
    return serially(this.gitDir, async () => {
      const { worktree, scratch } = this.ticketFolders(issueNumber);
      await git(this.gitDir, 'fetch', '--prune', 'origin');
      if (existsSync(worktree)) await git(this.gitDir, 'worktree', 'remove', '--force', worktree);
      await git(this.gitDir, 'worktree', 'prune');
      await git(this.gitDir, 'worktree', 'add', '-B', branch, worktree, `origin/${defaultBranch}`);
      await mkdir(scratch, { recursive: true });
      return { worktree, scratch };
    });
  }

  async commitsAhead(branch: string, defaultBranch: string): Promise<number> {
    return Number(await git(this.gitDir, 'rev-list', '--count', `origin/${defaultBranch}..${branch}`));
  }

  // A fresh detached checkout of the latest default branch for a Planner session to read.
  async preparePlannerCheckout(planId: number, defaultBranch: string): Promise<TicketFolders> {
    const { worktree, scratch } = this.plannerFolders(planId);
    await git(this.gitDir, 'fetch', '--prune', 'origin');
    await git(this.gitDir, 'worktree', 'add', '--detach', worktree, `origin/${defaultBranch}`);
    await mkdir(scratch, { recursive: true });
    return { worktree, scratch };
  }

  plannerFolders(planId: number): TicketFolders {
    return { worktree: join(this.root, 'plan', String(planId)), scratch: join(this.root, 'scratch', `plan-${planId}`) };
  }

  async removePlannerCheckout(planId: number): Promise<void> {
    const { worktree, scratch } = this.plannerFolders(planId);
    await rm(worktree, { recursive: true, force: true });
    await rm(scratch, { recursive: true, force: true });
    await git(this.gitDir, 'worktree', 'prune');
  }

  // Deletes the clone along with every worktree and scratch folder.
  async remove(): Promise<void> {
    await rm(this.root, { recursive: true, force: true, maxRetries: 5 });
  }

  // Only the Orchestrator pushes; Agents just commit in their worktree.
  // Force-pushes `branch` only while the remote branch is still at `expectedHead`,
  // the head the Orchestrator last published (null: the branch must not exist yet),
  // so a commit someone else pushed is never overwritten. Returns the pushed head.
  push(branch: string, expectedHead: string | null): Promise<string> {
    return serially(this.gitDir, async () => {
      const ref = `refs/heads/${branch}`;
      try {
        await git(this.gitDir, 'push', `--force-with-lease=${ref}:${expectedHead ?? ''}`, 'origin', `${ref}:${ref}`);
      } catch (error) {
        if (/stale info|\[rejected\]/.test(String((error as { stderr?: unknown }).stderr ?? error))) {
          throw new BranchMoved(branch);
        }
        throw error;
      }
      return git(this.gitDir, 'rev-parse', ref);
    });
  }
}

// The remote branch is no longer where the Orchestrator left it: someone else pushed.
export class BranchMoved extends Error {
  readonly branch: string;

  constructor(branch: string) {
    super(`${branch} changed on GitHub since the Orchestrator last pushed it`);
    this.branch = branch;
  }
}
