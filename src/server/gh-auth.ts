// The gh login port: the Orchestrator uses the user's existing `gh` login and
// never stores a GitHub token of its own. The token is read once at startup and
// kept in memory only; it is never written to the data folder or the database.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export interface GhAuth {
  // The token `gh auth token` prints, or null when gh is not logged in.
  token(): Promise<string | null>;
}

export class GhNotLoggedIn extends Error {
  constructor() {
    super('GitHub CLI (gh) is not logged in. Run `gh auth login`, then start the Orchestrator again.');
    this.name = 'GhNotLoggedIn';
  }
}

const run = promisify(execFile);

// The real adapter: asks the `gh` CLI. Covered by the manual smoke test only.
export const ghCliAuth: GhAuth = {
  async token() {
    try {
      const { stdout } = await run('gh', ['auth', 'token'], { windowsHide: true });
      return stdout.trim() || null;
    } catch {
      return null; // gh missing, or logged out (it exits non-zero)
    }
  },
};
