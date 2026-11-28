// The GitHub port. The Orchestrator, never an Agent, talks to GitHub.
// Pushing goes over git to `cloneUrl`; everything else goes through this port.

export type RepoInfo = { defaultBranch: string; cloneUrl: string };
export type Issue = { number: number; title: string; body: string; state: 'open' | 'closed' };
export type NewPullRequest = { head: string; base: string; title: string; body: string };
export type ChecksState = 'pending' | 'success' | 'failure';
export type MergeMethod = 'squash';

export interface GitHub {
  getRepo(owner: string, name: string): Promise<RepoInfo>;
  getIssue(owner: string, name: string, number: number): Promise<Issue>;
  createPullRequest(owner: string, name: string, pr: NewPullRequest): Promise<{ number: number }>;
  getChecks(owner: string, name: string, ref: string): Promise<ChecksState>;
  mergePullRequest(owner: string, name: string, number: number, method: MergeMethod): Promise<void>;
}
