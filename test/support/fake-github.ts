import type {
  Blocker,
  ChangeProbe,
  ChecksState,
  FailedJob,
  GitHub,
  Issue,
  IssueRef,
  MergeMethod,
  NewIssue,
  NewPullRequest,
  RepoInfo,
  RepoSnapshot,
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

type FakeIssue = Issue & { parent: IssueRef | null };

type FakeRepo = {
  owner: string;
  name: string;
  info: RepoInfo;
  issues: Map<number, FakeIssue>;
  children: Map<number, number[]>;
  nextIssueNumber: number;
  blockedBy: Map<number, BlockerSpec[]>; // native issue dependencies, maybe in another repo
  closedByMerge: Set<number>; // issues a merged PR closed

  pulls: FakePullRequest[];
  checks: ChecksState;
  failedJobs: FailedJob[];
  // Bumped on every change to the repo's issues or PRs; the change probe's ETag.
  version: number;
};

type Hold = { arrived: () => void; released: Promise<void> };

// Holds issues (labels, parent, blockers), PRs and CI status, and can be changed
// "from GitHub" mid-test. Branches live in the local bare repo that stands in for
// the remote, and are read from it. Every port call is recorded in `calls`.
export class FakeGitHub implements GitHub {
  readonly calls: { method: keyof GitHub; repo: string }[] = [];
  private repos = new Map<string, FakeRepo>();
  private nextNumber = 1000;
  private subIssueUnavailable = false;
  private checksHeld: PromiseWithResolvers<void> | undefined;
  private issueGate: Promise<void> | null = null;
  private issueLookupStarted: (() => void) | null = null;
  private issueHolds: (Hold & { key: string; skip: number })[] = [];
  private createHold: (Hold & { number?: number }) | undefined;
  private readRepoHold: Hold | undefined;

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
      owner,
      name,
      info: { defaultBranch, cloneUrl: remotePath },
      issues: new Map(),
      children: new Map(),
      nextIssueNumber: 1000,
      blockedBy: new Map(),
      closedByMerge: new Set(),
      pulls: [],
      checks: 'success',
      failedJobs: [],
      version: 1,
    });
  }

  addIssue(
    owner: string,
    name: string,
    {
      blockedBy = [],
      labels = [],
      parent = null,
      ...issue
    }: { number: number; title: string; body: string; blockedBy?: BlockerSpec[]; labels?: string[]; parent?: IssueRef | null },
  ): void {
    const repo = this.repo(owner, name);
    repo.issues.set(issue.number, { ...issue, labels: [...labels], parent, state: 'open' });
    repo.blockedBy.set(issue.number, blockedBy);
    repo.version++;
  }

  // Closes an issue by hand, or as a merged PR naming it would.
  closeIssue(owner: string, name: string, number: number, { byMergedPullRequest = false } = {}): void {
    const repo = this.repo(owner, name);
    const issue = repo.issues.get(number);
    if (!issue) throw new Error(`no issue #${number} on ${owner}/${name}`);
    issue.state = 'closed';
    if (byMergedPullRequest) repo.closedByMerge.add(number);
    repo.version++;
  }

  // The user edits an issue's labels on GitHub.
  setLabels(owner: string, name: string, number: number, labels: string[]): void {
    const repo = this.repo(owner, name);
    const issue = repo.issues.get(number);
    if (!issue) throw new Error(`no issue #${number} on ${owner}/${name}`);
    issue.labels = [...labels];
    repo.version++;
  }

  // The user merges a PR on GitHub.
  mergeOnGitHub(owner: string, name: string, number: number): void {
    this.merge(owner, name, this.openPull(owner, name, number), 'squash');
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

  // Delays the answer to a coming getIssue for this issue until `release()`, as a
  // slow network would: the answer is what GitHub held when the call arrived.
  // `skip` lets that many calls through first. `arrived` resolves once the call is in.
  holdGetIssue(owner: string, name: string, number: number, { skip = 0 } = {}) {
    const arrival = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    this.issueHolds.push({ key: this.issueKey(owner, name, number), skip, arrived: arrival.resolve, released: release.promise });
    return { arrived: arrival.promise, release: () => release.resolve() };
  }

  // Delays the answer to the next createPullRequest until `release()`. The PR is
  // open on GitHub as soon as the call arrives; `arrived` gives its number.
  holdCreatePullRequest() {
    const arrival = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const hold: Hold & { number?: number } = { arrived: arrival.resolve, released: release.promise };
    this.createHold = hold;
    return { arrived: arrival.promise.then(() => hold.number!), release: () => release.resolve() };
  }

  // Delays the answer to the next readRepo until `release()`: the snapshot is what
  // GitHub held when the call arrived, so it goes stale while held.
  holdReadRepo() {
    const arrival = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    this.readRepoHold = { arrived: arrival.resolve, released: release.promise };
    return { arrived: arrival.promise, release: () => release.resolve() };
  }

  // Someone opens a PR on GitHub (not the Orchestrator). Returns its number.
  openPullRequestOnGitHub(owner: string, name: string, pr: Omit<NewPullRequest, 'draft'>): number {
    const repo = this.repo(owner, name);
    const number = this.nextNumber++;
    repo.pulls.push({ ...pr, draft: false, number, state: 'open', merged: false, mergeMethod: null });
    repo.version++;
    return number;
  }

  issue(owner: string, name: string, number: number): FakeIssue | undefined {
    const issue = this.repo(owner, name).issues.get(number);
    return issue && { ...issue, labels: [...issue.labels] };
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
    this.record('getRepo', owner, name);
    return { ...this.repo(owner, name).info };
  }

  async getIssue(owner: string, name: string, number: number): Promise<Issue> {
    this.record('getIssue', owner, name);
    if (this.issueGate) {
      this.issueLookupStarted?.();
      await this.issueGate;
    }
    const issue = this.repo(owner, name).issues.get(number);
    if (!issue) throw new Error(`no issue #${number} on ${owner}/${name}`);
    const answer = { number: issue.number, title: issue.title, body: issue.body, state: issue.state, labels: [...issue.labels] };
    const hold = this.issueHolds.find((h) => h.key === this.issueKey(owner, name, number));
    if (hold && hold.skip-- === 0) {
      this.issueHolds.splice(this.issueHolds.indexOf(hold), 1);
      hold.arrived();
      await hold.released;
    }
    return answer;
  }

  subIssues(owner: string, name: string, number: number): number[] {
    return [...(this.repo(owner, name).children.get(number) ?? [])];
  }

  async createIssue({ owner, name }: Omit<IssueRef, 'number'>, issue: NewIssue): Promise<IssueRef> {
    const repo = this.repo(owner, name);
    while (repo.issues.has(repo.nextIssueNumber)) repo.nextIssueNumber++;
    const number = repo.nextIssueNumber++;
    repo.issues.set(number, { ...issue, labels: [...(issue.labels ?? [])], parent: null, number, state: 'open' });
    repo.version++;
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
    const childIssue = this.repo(child.owner, child.name).issues.get(child.number)!;
    childIssue.parent = { ...parent };
    repo.version++;
    this.repo(child.owner, child.name).version++;
  }

  async addBlocker(blocked: IssueRef, blocker: IssueRef): Promise<void> {
    await this.getIssue(blocked.owner, blocked.name, blocked.number);
    await this.getIssue(blocker.owner, blocker.name, blocker.number);
    const repo = this.repo(blocked.owner, blocked.name);
    const blockers = await this.getBlockers(blocked.owner, blocked.name, blocked.number);
    if (blockers.some((ref) => ref.owner === blocker.owner && ref.name === blocker.name && ref.number === blocker.number)) return;
    repo.blockedBy.set(blocked.number, [...blockers, blocker]);
    repo.version++;
  }

  async getBlockers(owner: string, name: string, number: number): Promise<Blocker[]> {
    this.record('getBlockers', owner, name);
    return this.blockerRefs(owner, name, number).map((ref) => {
      const blockerRepo = this.repo(ref.owner, ref.name);
      if (!blockerRepo.issues.has(ref.number)) throw new Error(`no issue #${ref.number} on ${ref.owner}/${ref.name}`);
      return { ...ref, merged: blockerRepo.closedByMerge.has(ref.number) };
    });
  }

  async createPullRequest(owner: string, name: string, pr: NewPullRequest): Promise<{ number: number }> {
    this.record('createPullRequest', owner, name);
    this.maybeFail('createPullRequest');
    const repo = this.repo(owner, name);
    if (!this.branches(owner, name).includes(pr.head)) throw new Error(`branch ${pr.head} was never pushed`);
    const number = this.nextNumber++;
    repo.pulls.push({ ...pr, number, state: 'open', merged: false, mergeMethod: null });
    repo.version++;
    const hold = this.createHold;
    if (hold) {
      this.createHold = undefined;
      hold.number = number;
      hold.arrived();
      await hold.released;
    }
    return { number };
  }

  async updatePullRequest(owner: string, name: string, number: number, change: { body: string }): Promise<void> {
    this.record('updatePullRequest', owner, name);
    this.maybeFail('updatePullRequest');
    Object.assign(this.openPull(owner, name, number), change);
    this.repo(owner, name).version++;
  }

  async markPullRequestReady(owner: string, name: string, number: number): Promise<void> {
    this.record('markPullRequestReady', owner, name);
    this.maybeFail('markPullRequestReady');
    this.openPull(owner, name, number).draft = false;
    this.repo(owner, name).version++;
  }

  async getChecks(owner: string, name: string, _ref: string): Promise<ChecksState> {
    this.record('getChecks', owner, name);
    this.maybeFail('getChecks');
    while (this.checksHeld) await this.checksHeld.promise;
    return this.repo(owner, name).checks;
  }

  async getFailedJobs(owner: string, name: string, _ref: string): Promise<FailedJob[]> {
    this.record('getFailedJobs', owner, name);
    this.maybeFail('getFailedJobs');
    return this.repo(owner, name).failedJobs.map((job) => ({ ...job }));
  }

  async mergePullRequest(owner: string, name: string, number: number, method: MergeMethod): Promise<void> {
    this.record('mergePullRequest', owner, name);
    this.maybeFail('mergePullRequest');
    const pr = this.openPull(owner, name, number);
    if (pr.draft) throw new Error(`PR #${number} is still a draft`);
    this.merge(owner, name, pr, method);
  }

  async detectChanges(owner: string, name: string, etag: string | null): Promise<ChangeProbe> {
    this.record('detectChanges', owner, name);
    const current = `"v${this.repo(owner, name).version}"`;
    return { changed: etag !== current, etag: current };
  }

  async readRepo(owner: string, name: string): Promise<RepoSnapshot> {
    this.record('readRepo', owner, name);
    const repo = this.repo(owner, name);
    const snapshot = this.snapshot(repo);
    const hold = this.readRepoHold;
    if (hold) {
      this.readRepoHold = undefined;
      hold.arrived();
      await hold.released;
    }
    return snapshot;
  }

  private snapshot(repo: FakeRepo): RepoSnapshot {
    const { owner, name } = repo;
    return {
      issues: [...repo.issues.values()].map((i) => ({
        number: i.number,
        state: i.state,
        labels: [...i.labels],
        parent: i.parent && { ...i.parent },
        subIssues: this.subIssuesOf({ owner, name, number: i.number }),
        blockedBy: this.blockerRefs(owner, name, i.number),
      })),
      // Newest first, as the GraphQL query asks for.
      pullRequests: [...repo.pulls].reverse().map((p) => ({
        number: p.number,
        head: p.head,
        state: p.merged ? 'merged' : p.state,
        closingIssues: closingIssues(owner, name, p.body),
      })),
    };
  }

  private blockerRefs(owner: string, name: string, number: number): IssueRef[] {
    return (this.repo(owner, name).blockedBy.get(number) ?? []).map((spec) =>
      typeof spec === 'number' ? { owner, name, number: spec } : { ...spec },
    );
  }

  // Sub-issues can sit in any repo; each names its parent.
  private subIssuesOf(parent: IssueRef): IssueRef[] {
    const same = (a: IssueRef, b: IssueRef) =>
      this.issueKey(a.owner, a.name, a.number) === this.issueKey(b.owner, b.name, b.number);
    return [...this.repos.values()].flatMap((repo) =>
      [...repo.issues.values()]
        .filter((i) => i.parent && same(i.parent, parent))
        .map((i) => ({ owner: repo.owner, name: repo.name, number: i.number })),
    );
  }

  // Like GitHub: a merged PR closes the issues its body names with "Closes #n".
  private merge(owner: string, name: string, pr: FakePullRequest, method: MergeMethod): void {
    Object.assign(pr, { state: 'closed', merged: true, mergeMethod: method });
    for (const ref of closingIssues(owner, name, pr.body)) {
      const target = this.repos.get(`${ref.owner}/${ref.name}`.toLowerCase());
      const issue = target?.issues.get(ref.number);
      if (target && issue) {
        issue.state = 'closed';
        target.closedByMerge.add(issue.number);
        target.version++;
      }
    }
    this.repo(owner, name).version++;
  }

  private issueKey(owner: string, name: string, number: number): string {
    return `${owner}/${name}#${number}`.toLowerCase();
  }

  private record(method: keyof GitHub, owner: string, name: string): void {
    this.calls.push({ method, repo: `${owner}/${name}` });
  }

  private maybeFail(method: keyof GitHub): void {
    if (this.failing.delete(method)) throw new Error(`GitHub ${method} failed: 502 Bad Gateway`);
  }

  private openPull(owner: string, name: string, number: number): FakePullRequest {
    const pr = this.repo(owner, name).pulls.find((p) => p.number === number);
    if (!pr || pr.state !== 'open') throw new Error(`PR #${number} is not open`);
    return pr;
  }

  private repo(owner: string, name: string): FakeRepo {
    // Like GitHub, owner and repo names match whatever their case.
    const repo = this.repos.get(`${owner}/${name}`.toLowerCase());
    if (!repo) throw new Error(`no repo ${owner}/${name}`);
    return repo;
  }
}

// The issues a PR body links with "Closes #n" or "Closes owner/name#n".
function closingIssues(owner: string, name: string, body: string): IssueRef[] {
  return [...body.matchAll(/\bCloses (?:([\w.-]+)\/([\w.-]+))?#(\d+)\b/gi)].map((m) => ({
    owner: m[1] ?? owner,
    name: m[2] ?? name,
    number: Number(m[3]),
  }));
}
