// The repo workspace: per Target Repo a bare clone, per-Ticket worktrees and
// scratch folders, under `<data>/repos/<owner>/<repo>/{git,work/<n>,scratch/<n>}`.
import { execFile } from 'node:child_process';
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

  // A fresh worktree for the Ticket on `branch`, reset to the latest default branch.
  prepareTicket(issueNumber: number, branch: string, defaultBranch: string): Promise<TicketFolders> {
    return serially(this.gitDir, async () => {
      const worktree = join(this.root, 'work', String(issueNumber));
      const scratch = join(this.root, 'scratch', String(issueNumber));
      await git(this.gitDir, 'fetch', '--prune', 'origin');
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
  push(branch: string): Promise<void> {
    return serially(this.gitDir, async () => {
      await git(this.gitDir, 'push', '--force', 'origin', `refs/heads/${branch}:refs/heads/${branch}`);
    });
  }
}
