// The GitHub port. The Orchestrator, never an Agent, talks to GitHub.
// Pushing goes over git to `cloneUrl`; everything else goes through this port.

export type RepoInfo = { defaultBranch: string; cloneUrl: string };
export type Issue = { number: number; title: string; body: string; state: 'open' | 'closed' };
// A blocking issue. `merged`: a merged pull request closed it. An issue closed
// by hand does not count: a blocker is done only once its work is merged.
export type Blocker = { number: number; merged: boolean };
export type NewPullRequest = { head: string; base: string; title: string; body: string };
export type ChecksState = 'pending' | 'success' | 'failure';
export type MergeMethod = 'squash';

export interface GitHub {
  getRepo(owner: string, name: string): Promise<RepoInfo>;
  getIssue(owner: string, name: string, number: number): Promise<Issue>;
  // The issues blocking this one (native GitHub issue dependencies, same repo).
  getBlockers(owner: string, name: string, number: number): Promise<Blocker[]>;
  createPullRequest(owner: string, name: string, pr: NewPullRequest): Promise<{ number: number }>;
  getChecks(owner: string, name: string, ref: string): Promise<ChecksState>;
  mergePullRequest(owner: string, name: string, number: number, method: MergeMethod): Promise<void>;
}
