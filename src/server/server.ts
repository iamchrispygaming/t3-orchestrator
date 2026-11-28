// The Orchestrator's HTTP + SSE API (Hono). Tests drive it in-process through
// `app.request`; the real process will serve the same app on 127.0.0.1.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { z } from 'zod';
import {
  addTargetRepoRequestSchema,
  registerApprovedPlanRequestSchema,
  registerTicketRequestSchema,
  replyToPlanRequestSchema,
  settingsSchema,
  startPlanRequestSchema,
  updateParallelLimitsRequestSchema,
  type ServerEvent,
  type TicketDetail,
} from '../shared/api.ts';
import type { AgentRunner } from './agent-runner.ts';
import { systemClock, type Clock } from './clock.ts';
import { resolveDataFolder } from './data-folder.ts';
import { Engine, NotFound, Refused } from './engine.ts';
import { GhNotLoggedIn, type GhAuth } from './gh-auth.ts';
import type { GitHub } from './github.ts';
import { silentNotifier, type Notifier } from './notifier.ts';
import { PlanBusy, Planner, PlanNotFound } from './planner.ts';
import { Store } from './store.ts';
import { readWebFile } from './web-files.ts';

export type ServerDeps = {
  env: Record<string, string | undefined>;
  github: GitHub;
  agentRunner: AgentRunner;
  clock?: Clock;
  notifier?: Notifier;
  log?: (message: string, error?: unknown) => void;
  webRoot?: string; // the built web UI, served at /; none in API-only tests
};

export type Server = {
  app: Hono;
  close(): Promise<void>;
};

export type StartDeps = Omit<ServerDeps, 'github'> & {
  ghAuth: GhAuth;
  // Builds the GitHub client from the gh token, which stays in its memory only.
  github: (token: string) => GitHub;
};

// Startup: reads the gh login first and refuses without one.
export async function startServer(deps: StartDeps): Promise<Server> {
  const token = await deps.ghAuth.token();
  if (!token) throw new GhNotLoggedIn();
  return createServer({ ...deps, github: deps.github(token) });
}

export function createServer(deps: ServerDeps): Server {
  const dataFolder = resolveDataFolder(deps.env);
  mkdirSync(dataFolder, { recursive: true });
  const store = new Store(join(dataFolder, 't3o.db'));
  const engine = new Engine({
    store,
    github: deps.github,
    agentRunner: deps.agentRunner,
    clock: deps.clock ?? systemClock,
    notifier: deps.notifier ?? silentNotifier,
    dataFolder,
    log: deps.log ?? ((message, error) => console.error(message, error)),
    stopPlannerWork: (repoId) => planner.stopTurnsOn(repoId),
  });
  const planner = new Planner({
    store,
    agentRunner: deps.agentRunner,
    clock: deps.clock ?? systemClock,
    dataFolder,
    log: deps.log ?? ((message, error) => console.error(message, error)),
  });
  planner.resume();
  const openStreams = new Set<() => void>();

  const app = new Hono();

  async function parseBody<S extends z.ZodType>(body: Promise<unknown>, schema: S) {
    return schema.safeParse(await body.catch(() => undefined));
  }

  app.onError((error, c) => {
    if (error instanceof PlanNotFound || error instanceof NotFound) return c.json({ error: error.message }, 404);
    if (error instanceof PlanBusy || error instanceof Refused) return c.json({ error: error.message }, 409);
    return c.json({ error: error.message }, 500);
  });

  app.get('/api/repos', (c) => c.json(engine.targetRepos()));

  app.post('/api/repos', async (c) => {
    const req = await parseBody(c.req.json(), addTargetRepoRequestSchema);
    if (!req.success) return c.json({ error: req.error.message }, 400);
    return c.json(await engine.addTargetRepo(req.data.owner, req.data.name), 201);
  });

  app.delete('/api/repos/:id', async (c) => {
    await engine.removeTargetRepo(Number(c.req.param('id')));
    return c.json({});
  });

  app.post('/api/tickets', async (c) => {
    const req = await parseBody(c.req.json(), registerTicketRequestSchema);
    if (!req.success) return c.json({ error: req.error.message }, 400);
    return c.json(await engine.registerTicket(req.data), 201);
  });

  app.post('/api/approved-plans', async (c) => {
    const req = await parseBody(c.req.json(), registerApprovedPlanRequestSchema);
    if (!req.success) return c.json({ error: req.error.message }, 400);
    return c.json(await engine.registerApprovedPlan(req.data), 201);
  });

  app.get('/api/settings/parallel-limits', (c) => c.json(engine.parallelLimits()));

  app.patch('/api/settings/parallel-limits', async (c) => {
    const req = await parseBody(c.req.json(), updateParallelLimitsRequestSchema);
    if (!req.success) return c.json({ error: req.error.message }, 400);
    return c.json(engine.updateParallelLimits(req.data));
  });

  app.get('/api/tickets/:id', (c) => {
    const id = Number(c.req.param('id'));
    const ticket = engine.ticket(id); // a removed Target Repo's Tickets stay readable as history
    if (!ticket) return c.json({ error: `no Ticket ${id}` }, 404);
    const detail: TicketDetail = {
      ...ticket,
      runs: store.listRuns(id),
      reviews: store.listReviews(id),
      output: engine.output(id),
    };
    return c.json(detail);
  });

  app.get('/api/settings', (c) => c.json(settingsSchema.parse({ plannerTier: planner.plannerTier() })));

  app.put('/api/settings', async (c) => {
    const req = await parseBody(c.req.json(), settingsSchema);
    if (!req.success) return c.json({ error: req.error.message }, 400);
    planner.setPlannerTier(req.data.plannerTier);
    return c.json({ plannerTier: planner.plannerTier() });
  });

  app.post('/api/plans', async (c) => {
    const req = await parseBody(c.req.json(), startPlanRequestSchema);
    if (!req.success) return c.json({ error: req.error.message }, 400);
    return c.json(await planner.start(req.data), 201);
  });

  app.get('/api/plans', (c) => c.json(planner.plans()));

  app.get('/api/plans/:id', (c) => c.json(planner.plan(Number(c.req.param('id')))));

  app.post('/api/plans/:id/messages', async (c) => {
    const req = await parseBody(c.req.json(), replyToPlanRequestSchema);
    if (!req.success) return c.json({ error: req.error.message }, 400);
    return c.json(await planner.reply(Number(c.req.param('id')), req.data));
  });

  app.delete('/api/plans/:id', async (c) => {
    await planner.discard(Number(c.req.param('id')));
    return c.json({ discarded: true });
  });

  app.get('/api/events', (c) =>
    streamSSE(c, async (stream) => {
      let queue = Promise.resolve();
      const send = (event: ServerEvent) => {
        queue = queue.then(() => stream.writeSSE({ event: event.type, data: JSON.stringify(event) }));
      };
      const unsubscribeTickets = engine.subscribe((ticket) => send({ type: 'ticket', ticket }));
      const unsubscribeOutput = engine.subscribeOutput((ticketId, text) => send({ type: 'output', ticketId, text }));
      const unsubscribePlans = planner.subscribe(send);
      send({ type: 'snapshot', tickets: engine.tickets(), plans: planner.plans() });
      await new Promise<void>((resolve) => {
        openStreams.add(resolve);
        stream.onAbort(resolve);
      });
      unsubscribeTickets();
      unsubscribeOutput();
      unsubscribePlans();
      await queue.catch(() => undefined);
    }),
  );

  app.all('/api/*', (c) => c.json({ error: `no route ${c.req.method} ${c.req.path}` }, 404));

  const webRoot = deps.webRoot;
  if (webRoot) {
    app.get('*', async (c) => {
      const file = await readWebFile(webRoot, c.req.path);
      if (!file) return c.text('Not found', 404);
      return c.body(new Uint8Array(file.body), 200, { 'content-type': file.type });
    });
  }

  return {
    app,
    async close() {
      await Promise.all([engine.stop(), planner.stop()]);
      for (const end of openStreams) end();
      store.close();
    },
  };
}
