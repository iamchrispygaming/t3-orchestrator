import type { ChecksState, GitHub, Issue, MergeMethod, NewPullRequest, RepoInfo } from '../../src/server/github.ts';
import { git } from './git.ts';

export type FakePullRequest = NewPullRequest & {
  number: number;
  state: 'open' | 'closed';
  merged: boolean;
  mergeMethod: MergeMethod | null;
};

type FakeRepo = {
  info: RepoInfo;
  issues: Map<number, Issue>;
  pulls: FakePullRequest[];
  checks: ChecksState;
};

// Holds issues, PRs and CI status. Branches live in the local bare repo that
// stands in for the remote, and are read from it.
export class FakeGitHub implements GitHub {
  private repos = new Map<string, FakeRepo>();
  private nextNumber = 1000;

  addRepo(owner: string, name: string, remotePath: string, defaultBranch = 'main'): void {
    this.repos.set(`${owner}/${name}`, {
      info: { defaultBranch, cloneUrl: remotePath },
      issues: new Map(),
      pulls: [],
      checks: 'success',
    });
  }

  addIssue(owner: string, name: string, issue: { number: number; title: string; body: string }): void {
    this.repo(owner, name).issues.set(issue.number, { ...issue, state: 'open' });
  }

  issue(owner: string, name: string, number: number): Issue | undefined {
    return this.repo(owner, name).issues.get(number);
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

  async createPullRequest(owner: string, name: string, pr: NewPullRequest): Promise<{ number: number }> {
    const repo = this.repo(owner, name);
    if (!this.branches(owner, name).includes(pr.head)) throw new Error(`branch ${pr.head} was never pushed`);
    const number = this.nextNumber++;
    repo.pulls.push({ ...pr, number, state: 'open', merged: false, mergeMethod: null });
    return { number };
  }

  async getChecks(owner: string, name: string, _ref: string): Promise<ChecksState> {
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
      if (issue) issue.state = 'closed';
    }
  }

  private repo(owner: string, name: string): FakeRepo {
    const repo = this.repos.get(`${owner}/${name}`);
    if (!repo) throw new Error(`no repo ${owner}/${name}`);
    return repo;
  }
}
