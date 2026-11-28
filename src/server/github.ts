// The GitHub port. The Orchestrator, never an Agent, talks to GitHub.
// Pushing goes over git to `cloneUrl`; everything else goes through this port.
// It writes labels only when publishing a Plan (`model:*`, `door:*`): never status labels.

export type RepoInfo = { defaultBranch: string; cloneUrl: string };
export type Issue = { number: number; title: string; body: string; state: 'open' | 'closed'; labels: string[] };
// An issue on GitHub, by repository plus number: Target Repos share issue numbers,
// and native dependencies and sub-issues can cross repositories.
export type IssueRef = { owner: string; name: string; number: number };
// A blocking issue. `merged`: a merged pull request closed it. An issue closed
// by hand does not count: a blocker is done only once its work is merged.
export type Blocker = IssueRef & { merged: boolean };
export type NewIssue = { title: string; body: string; labels?: string[] };
export type NewPullRequest = { head: string; base: string; title: string; body: string; draft: boolean };
export type ChecksState = 'pending' | 'success' | 'failure';
export type FailedJob = { name: string; logTail: string };
export type MergeMethod = 'squash';

// One structured read of a Target Repo (one GraphQL query on real GitHub).
export type RepoSnapshot = {
  issues: {
    number: number;
    state: 'open' | 'closed';
    labels: string[];
    parent: IssueRef | null;
    subIssues: IssueRef[];
    blockedBy: IssueRef[];
  }[];
  pullRequests: {
    number: number;
    head: string; // its branch, so a PR is matched to its Ticket even before the Orchestrator records its number
    state: 'open' | 'closed' | 'merged';
    // The issues it closes when merged (`closingIssuesReferences`).
    closingIssues: IssueRef[];
  }[];
};

// The answer to a cheap "did anything change?" probe: a REST conditional request
// on real GitHub, where an unchanged answer is a 304 that costs no rate limit.
export type ChangeProbe = { changed: boolean; etag: string };

export interface GitHub {
  getRepo(owner: string, name: string): Promise<RepoInfo>;
  getIssue(owner: string, name: string, number: number): Promise<Issue>;
  createIssue(repo: Omit<IssueRef, 'number'>, issue: NewIssue): Promise<IssueRef>;
  // Relationship writes are idempotent so a partially published Plan can be retried.
  addSubIssue(parent: IssueRef, child: IssueRef): Promise<void>;
  addBlocker(blocked: IssueRef, blocker: IssueRef): Promise<void>;
  // The issues blocking this one (native GitHub issue dependencies, same repo).
  getBlockers(owner: string, name: string, number: number): Promise<Blocker[]>;
  createPullRequest(owner: string, name: string, pr: NewPullRequest): Promise<{ number: number }>;
  updatePullRequest(owner: string, name: string, number: number, change: { body: string }): Promise<void>;
  markPullRequestReady(owner: string, name: string, number: number): Promise<void>;
  getChecks(owner: string, name: string, ref: string): Promise<ChecksState>;
  // The failed CI jobs on `ref`, each with the tail of its log.
  getFailedJobs(owner: string, name: string, ref: string): Promise<FailedJob[]>;
  mergePullRequest(owner: string, name: string, number: number, method: MergeMethod): Promise<void>;
  // Pass the previous probe's `etag`, or null on a repo's first probe (always a change).
  detectChanges(owner: string, name: string, etag: string | null): Promise<ChangeProbe>;
  readRepo(owner: string, name: string): Promise<RepoSnapshot>;
}
