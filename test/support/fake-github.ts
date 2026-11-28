import type {
  Blocker,
  ChecksState,
  FailedJob,
  GitHub,
  Issue,
  IssueRef,
  MergeMethod,
  NewIssue,
  NewPullRequest,
  RepoInfo,
} from '../../src/server/github.ts';
import { git } from './git.ts';

export type FakePullRequest = NewPullRequest & {
  number: number;
  state: 'open' | 'closed';
  merged: boolean;
  mergeMethod: MergeMethod | null;
};

// A blocking issue: a number in the same repo, or an issue in another repo.
export type BlockerSpec = number | { owner: string; name: string; number: number };

type PublishedIssue = Issue & { labels?: string[] };

type FakeRepo = {
  info: RepoInfo;
  issues: Map<number, PublishedIssue>;
  children: Map<number, number[]>;
  nextIssueNumber: number;
  blockedBy: Map<number, BlockerSpec[]>; // native issue dependencies, maybe in another repo
  closedByMerge: Set<number>; // issues a merged PR closed

  pulls: FakePullRequest[];
  checks: ChecksState;
  failedJobs: FailedJob[];
};

// Holds issues, PRs and CI status. Branches live in the local bare repo that
// stands in for the remote, and are read from it.
export class FakeGitHub implements GitHub {
  private repos = new Map<string, FakeRepo>();
  private nextNumber = 1000;
  private subIssueUnavailable = false;
  private checksHeld: PromiseWithResolvers<void> | undefined;
  private issueGate: Promise<void> | null = null;
  private issueLookupStarted: (() => void) | null = null;

  // Holds issue lookups until release(); `started` resolves when one is waiting.
  holdIssueLookups(): { started: Promise<void>; release: () => void } {
    let release!: () => void;
    this.issueGate = new Promise<void>((resolve) => (release = resolve));
    const started = new Promise<void>((resolve) => (this.issueLookupStarted = resolve));
    return {
      started,
      release: () => {
        this.issueGate = null;
        release();
      },
    };
  }
  private failing = new Set<keyof GitHub>();

  addRepo(owner: string, name: string, remotePath: string, defaultBranch = 'main'): void {
    this.repos.set(`${owner}/${name}`.toLowerCase(), {
      info: { defaultBranch, cloneUrl: remotePath },
      issues: new Map(),
      children: new Map(),
      nextIssueNumber: 1000,
      blockedBy: new Map(),
      closedByMerge: new Set(),
      pulls: [],
      checks: 'success',
      failedJobs: [],
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

  // CI status for every ref, as GitHub would report it "now".
  setChecks(owner: string, name: string, checks: ChecksState, failedJobs: FailedJob[] = []): void {
    Object.assign(this.repo(owner, name), { checks, failedJobs });
  }

  // The next call to `method` fails, as if GitHub were unreachable.
  failNext(method: keyof GitHub): void {
    this.failing.add(method);
  }

  issue(owner: string, name: string, number: number): PublishedIssue | undefined {
    return this.repo(owner, name).issues.get(number);
  }

  issueCount(owner: string, name: string): number {
    return this.repo(owner, name).issues.size;
  }

  pulls(owner: string, name: string): FakePullRequest[] {
    return this.repo(owner, name).pulls.map((pr) => ({ ...pr }));
  }

  renamePullRequest(owner: string, name: string, number: number, title: string): void {
    this.pull(owner, name, number).title = title;
  }

  branches(owner: string, name: string): string[] {
    const out = git(this.repo(owner, name).info.cloneUrl, 'for-each-ref', '--format=%(refname:short)', 'refs/heads');
    return out === '' ? [] : out.split('\n');
  }

  async getRepo(owner: string, name: string): Promise<RepoInfo> {
    return { ...this.repo(owner, name).info };
  }

  async getIssue(owner: string, name: string, number: number): Promise<Issue> {
    if (this.issueGate) {
      this.issueLookupStarted?.();
      await this.issueGate;
    }
    const issue = this.repo(owner, name).issues.get(number);
    if (!issue) throw new Error(`no issue #${number} on ${owner}/${name}`);
    return { ...issue };
  }

  subIssues(owner: string, name: string, number: number): number[] {
    return [...(this.repo(owner, name).children.get(number) ?? [])];
  }

  async createIssue({ owner, name }: Omit<IssueRef, 'number'>, issue: NewIssue): Promise<IssueRef> {
    const repo = this.repo(owner, name);
    while (repo.issues.has(repo.nextIssueNumber)) repo.nextIssueNumber++;
    const number = repo.nextIssueNumber++;
    repo.issues.set(number, { ...issue, number, state: 'open' });
    return { owner, name, number };
  }

  failNextSubIssue(): void {
    this.subIssueUnavailable = true;
  }

  async addSubIssue(parent: IssueRef, child: IssueRef): Promise<void> {
    if (this.subIssueUnavailable) {
      this.subIssueUnavailable = false;
      throw new Error('GitHub temporarily unavailable');
    }
    await this.getIssue(parent.owner, parent.name, parent.number);
    await this.getIssue(child.owner, child.name, child.number);
    const repo = this.repo(parent.owner, parent.name);
    const children = repo.children.get(parent.number) ?? [];
    repo.children.set(parent.number, [...new Set([...children, child.number])]);
  }

  async addBlocker(blocked: IssueRef, blocker: IssueRef): Promise<void> {
    await this.getIssue(blocked.owner, blocked.name, blocked.number);
    await this.getIssue(blocker.owner, blocker.name, blocker.number);
    const repo = this.repo(blocked.owner, blocked.name);
    const blockers = await this.getBlockers(blocked.owner, blocked.name, blocked.number);
    if (blockers.some((ref) => ref.owner === blocker.owner && ref.name === blocker.name && ref.number === blocker.number)) return;
    repo.blockedBy.set(blocked.number, [...blockers, blocker]);
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

  async getPullRequestTitle(owner: string, name: string, number: number): Promise<string> {
    this.maybeFail('getPullRequestTitle');
    return this.pull(owner, name, number).title;
  }

  async createPullRequest(owner: string, name: string, pr: NewPullRequest): Promise<{ number: number }> {
    this.maybeFail('createPullRequest');
    const repo = this.repo(owner, name);
    if (!this.branches(owner, name).includes(pr.head)) throw new Error(`branch ${pr.head} was never pushed`);
    const number = this.nextNumber++;
    repo.pulls.push({ ...pr, number, state: 'open', merged: false, mergeMethod: null });
    return { number };
  }

  async updatePullRequest(owner: string, name: string, number: number, change: { body: string }): Promise<void> {
    this.maybeFail('updatePullRequest');
    Object.assign(this.openPull(owner, name, number), change);
  }

  async markPullRequestReady(owner: string, name: string, number: number): Promise<void> {
    this.maybeFail('markPullRequestReady');
    this.openPull(owner, name, number).draft = false;
  }

  async getChecks(owner: string, name: string, _ref: string): Promise<ChecksState> {
    this.maybeFail('getChecks');
    while (this.checksHeld) await this.checksHeld.promise;
    return this.repo(owner, name).checks;
  }

  async getFailedJobs(owner: string, name: string, _ref: string): Promise<FailedJob[]> {
    this.maybeFail('getFailedJobs');
    return this.repo(owner, name).failedJobs.map((job) => ({ ...job }));
  }

  async mergePullRequest(owner: string, name: string, number: number, method: MergeMethod): Promise<void> {
    this.maybeFail('mergePullRequest');
    const pr = this.openPull(owner, name, number);
    if (pr.draft) throw new Error(`PR #${number} is still a draft`);
    Object.assign(pr, { state: 'closed', merged: true, mergeMethod: method });
    const repo = this.repo(owner, name);
    // Like GitHub: a merged PR closes the issues its body names with "Closes #n".
    for (const match of pr.body.matchAll(/\bCloses #(\d+)\b/gi)) {
      const issue = repo.issues.get(Number(match[1]));
      if (issue) {
        issue.state = 'closed';
        repo.closedByMerge.add(issue.number);
      }
    }
  }

  private maybeFail(method: keyof GitHub): void {
    if (this.failing.delete(method)) throw new Error(`GitHub ${method} failed: 502 Bad Gateway`);
  }

  private openPull(owner: string, name: string, number: number): FakePullRequest {
    const pr = this.pull(owner, name, number);
    if (pr.state !== 'open') throw new Error(`PR #${number} is not open`);
    return pr;
  }

  private pull(owner: string, name: string, number: number): FakePullRequest {
    const pr = this.repo(owner, name).pulls.find((p) => p.number === number);
    if (!pr) throw new Error(`no PR #${number} on ${owner}/${name}`);
    return pr;
  }

  private repo(owner: string, name: string): FakeRepo {
    // Like GitHub, owner and repo names match whatever their case.
    const repo = this.repos.get(`${owner}/${name}`.toLowerCase());
    if (!repo) throw new Error(`no repo ${owner}/${name}`);
    return repo;
  }
}
