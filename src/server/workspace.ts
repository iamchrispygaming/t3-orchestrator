// The repo workspace: per Target Repo a bare clone, per-Ticket worktrees and
// scratch folders, under `<data>/repos/<owner>/<repo>/{git,work/<n>,scratch/<n>}`.
import { execFile } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await run('git', args, {
    cwd,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  return stdout.trim();
}

export type TicketFolders = { worktree: string; scratch: string };

export class RepoWorkspace {
  readonly root: string;
  private readonly gitDir: string;

  constructor(dataFolder: string, owner: string, name: string) {
    this.root = join(dataFolder, 'repos', owner, name);
    this.gitDir = join(this.root, 'git');
  }

  async clone(url: string): Promise<void> {
    await mkdir(this.root, { recursive: true });
    await git(this.root, 'clone', '--bare', url, this.gitDir);
    // A bare clone maps remote branches onto local ones; track them as origin/* instead
    // so fetching never touches the Ticket branches checked out in worktrees.
    await git(this.gitDir, 'config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*');
    await git(this.gitDir, 'fetch', '--prune', 'origin');
  }

  // A fresh worktree for the Ticket on `branch`, reset to the latest default branch.
  async prepareTicket(issueNumber: number, branch: string, defaultBranch: string): Promise<TicketFolders> {
    const worktree = join(this.root, 'work', String(issueNumber));
    const scratch = join(this.root, 'scratch', String(issueNumber));
    await git(this.gitDir, 'fetch', '--prune', 'origin');
    await git(this.gitDir, 'worktree', 'add', '-B', branch, worktree, `origin/${defaultBranch}`);
    await mkdir(scratch, { recursive: true });
    return { worktree, scratch };
  }

  async commitsAhead(branch: string, defaultBranch: string): Promise<number> {
    return Number(await git(this.gitDir, 'rev-list', '--count', `origin/${defaultBranch}..${branch}`));
  }

  // Only the Orchestrator pushes; Agents just commit in their worktree.
  async push(branch: string): Promise<void> {
    await git(this.gitDir, 'push', '--force', 'origin', `refs/heads/${branch}:refs/heads/${branch}`);
  }
}
