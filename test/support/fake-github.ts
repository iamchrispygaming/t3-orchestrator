import type { Blocker, ChecksState, GitHub, Issue, MergeMethod, NewPullRequest, RepoInfo } from '../../src/server/github.ts';
import { git } from './git.ts';

export type FakePullRequest = NewPullRequest & {
  number: number;
  state: 'open' | 'closed';
  merged: boolean;
  mergeMethod: MergeMethod | null;
};

// A blocking issue: a number in the same repo, or an issue in another repo.
export type BlockerSpec = number | { owner: string; name: string; number: number };

type FakeRepo = {
  info: RepoInfo;
  issues: Map<number, Issue>;
  blockedBy: Map<number, BlockerSpec[]>; // native issue dependencies, maybe in another repo
  closedByMerge: Set<number>; // issues a merged PR closed

  pulls: FakePullRequest[];
  checks: ChecksState;
};

// Holds issues, PRs and CI status. Branches live in the local bare repo that
// stands in for the remote, and are read from it.
export class FakeGitHub implements GitHub {
  private repos = new Map<string, FakeRepo>();
  private nextNumber = 1000;
  private checksHeld: PromiseWithResolvers<void> | undefined;

  addRepo(owner: string, name: string, remotePath: string, defaultBranch = 'main'): void {
    this.repos.set(`${owner}/${name}`, {
      info: { defaultBranch, cloneUrl: remotePath },
      issues: new Map(),
      blockedBy: new Map(),
      closedByMerge: new Set(),
      pulls: [],
      checks: 'success',
    });
  }

  addIssue(
    owner: string,
    name: string,
    { blockedBy = [], ...issue }: { number: number; title: string; body: string; blockedBy?: BlockerSpec[] },
  ): void {
    const repo = this.repo(owner, name);
    repo.issues.set(issue.number, { ...issue, state: 'open' });
    repo.blockedBy.set(issue.number, blockedBy);
  }

  // Closes an issue by hand, or as a merged PR naming it would.
  closeIssue(owner: string, name: string, number: number, { byMergedPullRequest = false } = {}): void {
    const repo = this.repo(owner, name);
    const issue = repo.issues.get(number);
    if (!issue) throw new Error(`no issue #${number} on ${owner}/${name}`);
    issue.state = 'closed';
    if (byMergedPullRequest) repo.closedByMerge.add(number);
  }

  // Until released, CI on every repo stays unfinished: getChecks does not answer.
  holdChecks(): void {
    if (!this.checksHeld) this.checksHeld = Promise.withResolvers<void>();
  }

  releaseChecks(): void {
    this.checksHeld?.resolve();
    this.checksHeld = undefined;
  }

  issue(owner: string, name: string, number: number): Issue | undefined {
    return this.repo(owner, name).issues.get(number);
  }

  issueCount(owner: string, name: string): number {
    return this.repo(owner, name).issues.size;
  }

  pulls(owner: string, name: string): FakePullRequest[] {
    return this.repo(owner, name).pulls.map((pr) => ({ ...pr }));
  }

  branches(owner: string, name: string): string[] {
    const out = git(this.repo(owner, name).info.cloneUrl, 'for-each-ref', '--format=%(refname:short)', 'refs/heads');
    return out === '' ? [] : out.split('\n');
  }

  async getRepo(owner: string, name: string): Promise<RepoInfo> {
    return { ...this.repo(owner, name).info };
  }

  async getIssue(owner: string, name: string, number: number): Promise<Issue> {
    const issue = this.repo(owner, name).issues.get(number);
    if (!issue) throw new Error(`no issue #${number} on ${owner}/${name}`);
    return { ...issue };
  }

  async getBlockers(owner: string, name: string, number: number): Promise<Blocker[]> {
    const repo = this.repo(owner, name);
    return (this.repo(owner, name).blockedBy.get(number) ?? []).map((spec) => {
      const ref = typeof spec === 'number' ? { owner, name, number: spec } : spec;
      const blockerRepo = this.repo(ref.owner, ref.name);
      if (!blockerRepo.issues.has(ref.number)) throw new Error(`no issue #${ref.number} on ${ref.owner}/${ref.name}`);
      return { ...ref, merged: blockerRepo.closedByMerge.has(ref.number) };
    });
  }

  async createPullRequest(owner: string, name: string, pr: NewPullRequest): Promise<{ number: number }> {
    const repo = this.repo(owner, name);
    if (!this.branches(owner, name).includes(pr.head)) throw new Error(`branch ${pr.head} was never pushed`);
    const number = this.nextNumber++;
    repo.pulls.push({ ...pr, number, state: 'open', merged: false, mergeMethod: null });
    return { number };
  }

  async getChecks(owner: string, name: string, _ref: string): Promise<ChecksState> {
    while (this.checksHeld) await this.checksHeld.promise;
    return this.repo(owner, name).checks;
  }

  async mergePullRequest(owner: string, name: string, number: number, method: MergeMethod): Promise<void> {
    const repo = this.repo(owner, name);
    const pr = repo.pulls.find((p) => p.number === number);
    if (!pr || pr.state !== 'open') throw new Error(`PR #${number} is not open`);
    Object.assign(pr, { state: 'closed', merged: true, mergeMethod: method });
    // Like GitHub: a merged PR closes the issues its body names with "Closes #n".
    for (const match of pr.body.matchAll(/\bCloses #(\d+)\b/gi)) {
      const issue = repo.issues.get(Number(match[1]));
      if (issue) {
        issue.state = 'closed';
        repo.closedByMerge.add(issue.number);
      }
    }
  }

  private repo(owner: string, name: string): FakeRepo {
    const repo = this.repos.get(`${owner}/${name}`);
    if (!repo) throw new Error(`no repo ${owner}/${name}`);
    return repo;
  }
}
