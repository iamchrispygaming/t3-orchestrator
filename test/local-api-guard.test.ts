// The API listens on 127.0.0.1, so any web page the user visits can aim
// requests at it. Only the dashboard itself (and the `npm run dev` Vite proxy)
// may use it: no foreign Host (DNS rebinding), no foreign Origin, JSON bodies only.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from '../src/server/server.ts';
import { createApiClient } from '../src/web/api.ts';
import { FakeAgentRunner } from './support/fake-agent-runner.ts';
import { FakeClock } from './support/fake-clock.ts';
import { FakeGitHub } from './support/fake-github.ts';
import { createBareRemote } from './support/git.ts';

const PORT = 4317;
const SELF = `http://127.0.0.1:${PORT}`;
const VITE = 'http://127.0.0.1:5173';

describe('the local API guard', () => {
  let root: string;
  let github: FakeGitHub;
  let server: Server;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 't3o-test-'));
    github = new FakeGitHub();
    github.addRepo('acme', 'widgets', createBareRemote(root));
    server = createServer({
      env: { T3O_DATA_DIR: join(root, 'data') },
      github,
      agentRunner: new FakeAgentRunner(),
      clock: new FakeClock(),
      log: () => {},
      port: PORT,
      devOrigins: [VITE],
    });
  });

  afterEach(async () => {
    await server.close();
    rmSync(root, { recursive: true, force: true });
  });

  const request = (url: string, init?: RequestInit) => Promise.resolve(server.app.request(url, init));
  const addRepo = (url: string, headers: Record<string, string>) =>
    request(url, { method: 'POST', headers, body: JSON.stringify({ owner: 'acme', name: 'widgets' }) });
  const repos = async () => (await request(`${SELF}/api/repos`)).json();

  it('refuses a request whose Host names another domain, the event stream included', async () => {
    const list = await request(`http://rebound.example:${PORT}/api/repos`);
    const events = await request(`http://rebound.example:${PORT}/api/events`);
    const added = await addRepo(`http://rebound.example:${PORT}/api/repos`, { 'content-type': 'application/json' });

    expect(list.status).toBe(403);
    expect(events.status).toBe(403);
    expect(added.status).toBe(403);
    expect(await repos()).toEqual([]);
  });

  it('refuses a POST or PUT sent from another website, and changes nothing', async () => {
    const json = { 'content-type': 'application/json', origin: 'https://evil.example' };
    const added = await addRepo(`${SELF}/api/repos`, json);
    const before = await (await request(`${SELF}/api/settings`)).json();
    const changed = await request(`${SELF}/api/settings`, {
      method: 'PUT',
      headers: json,
      body: JSON.stringify({ plannerTier: { agent: 'codex', model: 'gpt-5.5', effort: 'high' } }),
    });

    expect(added.status).toBe(403);
    expect(changed.status).toBe(403);
    expect(await repos()).toEqual([]);
    expect(await (await request(`${SELF}/api/settings`)).json()).toEqual(before);
  });

  it('refuses a body that is not sent as JSON, and creates nothing', async () => {
    const plain = await addRepo(`${SELF}/api/repos`, { 'content-type': 'text/plain' });
    const untyped = await request(`${SELF}/api/repos`, {
      method: 'POST',
      body: new Blob([JSON.stringify({ owner: 'acme', name: 'widgets' })]),
    });

    expect(plain.status).toBe(415);
    expect(untyped.status).toBe(415);
    expect(await repos()).toEqual([]);
  });

  // The Vite proxy rewrites Host to the server's own; the browser's Origin stays Vite's.
  it.each([
    ['the dashboard itself', SELF, SELF],
    ['the dashboard at localhost', `http://localhost:${PORT}`, `http://localhost:${PORT}`],
    ['the npm run dev Vite proxy', SELF, VITE],
  ])('serves %s, the event stream included', async (_, base, origin) => {
    const api = createApiClient((path, init) => {
      const headers = new Headers(init?.headers);
      if (init?.method && init.method !== 'GET') headers.set('origin', origin);
      return request(base + path, { ...init, headers });
    });

    const repo = await api.addTargetRepo({ owner: 'acme', name: 'widgets' });
    const settings = await api.updateSettings({ runTimeLimitMinutes: 45 });
    const events = await api.events();
    const snapshot = await events.next();
    await events.close();

    expect(await api.listTargetRepos()).toEqual([repo]);
    expect(settings.runTimeLimitMinutes).toBe(45);
    expect(snapshot.type).toBe('snapshot');
  });
});
