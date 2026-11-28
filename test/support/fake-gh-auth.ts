import type { GhAuth } from '../../src/server/gh-auth.ts';

// Stands in for `gh auth token`: logged in with a token, or logged out.
export class FakeGhAuth implements GhAuth {
  private current: string | null;

  constructor(token: string) {
    this.current = token;
  }

  logOut(): void {
    this.current = null;
  }

  async token(): Promise<string | null> {
    return this.current;
  }
}
