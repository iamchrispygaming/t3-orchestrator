// Stand-ins for the real GitHub client (#43) and Agent adapters (#41, #42) until
// those land. `npm start` serves the dashboard with them: every call fails with a
// clear message, so no real `gh`, `claude` or `codex` ever runs from here.
import type { AgentRunner, RunEvent } from './agent-runner.ts';
import type { GitHub } from './github.ts';

class NotWiredYet extends Error {}

const refuse = (what: string) => async (): Promise<never> => {
  throw new NotWiredYet(`${what} isn't connected yet`);
};

export const unwiredGitHub: GitHub = {
  getRepo: refuse('GitHub'),
  getIssue: refuse('GitHub'),
  getBlockers: refuse('GitHub'),
  getBlockers: refuse('GitHub'),
  createPullRequest: refuse('GitHub'),
  getChecks: refuse('GitHub'),
  mergePullRequest: refuse('GitHub'),
  getBlockers: refuse('GitHub'),
};

export const unwiredAgentRunner: AgentRunner = {
  async *start(): AsyncIterable<RunEvent> {
    throw new NotWiredYet('No Agent (Claude Code, Codex) is connected yet');
  },
};
