// The GitHub port. The Orchestrator, never an Agent, talks to GitHub.
// Pushing goes over git to `cloneUrl`; everything else goes through this port.

export type RepoInfo = { defaultBranch: string; cloneUrl: string };
export type Issue = { number: number; title: string; body: string; state: 'open' | 'closed' };
// An issue on GitHub, by repository: native dependencies can cross repositories.
export type IssueRef = { owner: string; name: string; number: number };
// A blocking issue. `merged`: a merged pull request closed it. An issue closed
// by hand does not count: a blocker is done only once its work is merged.
export type Blocker = IssueRef & { merged: boolean };
export type NewPullRequest = { head: string; base: string; title: string; body: string; draft: boolean };
export type ChecksState = 'pending' | 'success' | 'failure';
export type FailedJob = { name: string; logTail: string };
export type MergeMethod = 'squash';

export interface GitHub {
  getRepo(owner: string, name: string): Promise<RepoInfo>;
  getIssue(owner: string, name: string, number: number): Promise<Issue>;
  // The issues blocking this one (native GitHub issue dependencies, same repo).
  getBlockers(owner: string, name: string, number: number): Promise<Blocker[]>;
  createPullRequest(owner: string, name: string, pr: NewPullRequest): Promise<{ number: number }>;
  updatePullRequest(owner: string, name: string, number: number, change: { body: string }): Promise<void>;
  markPullRequestReady(owner: string, name: string, number: number): Promise<void>;
  getChecks(owner: string, name: string, ref: string): Promise<ChecksState>;
  // The failed CI jobs on `ref`, each with the tail of its log.
  getFailedJobs(owner: string, name: string, ref: string): Promise<FailedJob[]>;
  mergePullRequest(owner: string, name: string, number: number, method: MergeMethod): Promise<void>;
}
