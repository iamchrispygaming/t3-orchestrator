// The engine: the Ticket state machine. It talks to the outside only through
// the AgentRunner and GitHub ports, the store and the repo workspace.
//
// This is the tracer-bullet path only: Ready -> Running -> Reviewing -> Merged.
// Every other branch of the state machine stops with NotYetHandled until the
// ticket that builds it lands (Escalation #26, Review #27, doors #28, ...).
import { z } from 'zod';
import type { Door, ModelTier, RegisterTicketRequest, TargetRepo, Ticket, TicketState } from '../shared/api.ts';
import { reviewOutcomeSchema, runOutcomeSchema, type AgentRunner, type RunMode } from './agent-runner.ts';
import type { Clock } from './clock.ts';
import type { GitHub } from './github.ts';
import type { Store, StoredTicket } from './store.ts';
import { RepoWorkspace } from './workspace.ts';

export const RUN_TIME_LIMIT_MS = 60 * 60_000;

export class NotYetHandled extends Error {}

export type EngineDeps = {
  store: Store;
  github: GitHub;
  agentRunner: AgentRunner;
  clock: Clock;
  dataFolder: string;
  log: (message: string, error?: unknown) => void;
};

type Call = 'one-way' | 'two-way' | 'unclear';

// Any one-way call wins; an unclear call counts as one-way.
function mostCautious(...calls: Call[]): Door {
  return calls.every((c) => c === 'two-way') ? 'two-way' : 'one-way';
}

export function branchName(issueNumber: number, title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
  return `t3o/${issueNumber}${slug ? `-${slug}` : ''}`;
}

function publicTicket({ body: _body, ...ticket }: StoredTicket): Ticket {
  return ticket;
}

export class Engine {
  private listeners = new Set<(ticket: Ticket) => void>();
  private inFlight = new Set<Promise<void>>();
  private stopping = new AbortController();
  private deps: EngineDeps;

  constructor(deps: EngineDeps) {
    this.deps = deps;
  }

  subscribe(listener: (ticket: Ticket) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  tickets(): Ticket[] {
    return this.deps.store.listTickets().map(publicTicket);
  }

  async addTargetRepo(owner: string, name: string): Promise<TargetRepo> {
    const info = await this.deps.github.getRepo(owner, name);
    await new RepoWorkspace(this.deps.dataFolder, owner, name).clone(info.cloneUrl);
    return this.deps.store.addTargetRepo({ owner, name, defaultBranch: info.defaultBranch });
  }

  async registerTicket(req: RegisterTicketRequest): Promise<Ticket> {
    const repo = this.deps.store.getTargetRepo(req.repoId);
    if (!repo) throw new Error(`no Target Repo ${req.repoId}`);
    const issue = await this.deps.github.getIssue(repo.owner, repo.name, req.issueNumber);
    const ticket = this.deps.store.addTicket({
      repoId: repo.id,
      issueNumber: issue.number,
      title: issue.title,
      body: issue.body,
      branch: branchName(issue.number, issue.title),
      tier: req.tier,
      door: req.door,
      state: 'ready',
    });
    this.emit(ticket.id);
    this.track(this.work(ticket.id));
    return publicTicket(ticket);
  }

  // Stops in-flight Runs and waits for them to wind down.
  async stop(): Promise<void> {
    this.stopping.abort();
    while (this.inFlight.size > 0) await Promise.allSettled([...this.inFlight]);
  }

  private track(work: Promise<void>): void {
    const tracked = work.catch((error) => this.deps.log('Ticket work stopped', error));
    this.inFlight.add(tracked);
    void tracked.finally(() => this.inFlight.delete(tracked));
  }

  private setState(id: number, state: TicketState): void {
    this.deps.store.updateTicket(id, { state });
    this.emit(id);
  }

  private emit(id: number): void {
    const ticket = publicTicket(this.deps.store.getTicket(id)!);
    for (const listener of this.listeners) listener(ticket);
  }

  private async work(id: number): Promise<void> {
    const { store, github, clock } = this.deps;
    const ticket = store.getTicket(id)!;
    const repo = store.getTargetRepo(ticket.repoId)!;
    const workspace = new RepoWorkspace(this.deps.dataFolder, repo.owner, repo.name);

    this.setState(id, 'running');
    const folders = await workspace.prepareTicket(ticket.issueNumber, ticket.branch, repo.defaultBranch);
    const runId = store.startRun(id, ticket.tier, clock.now());
    const run = await this.runAgent('run', ticket.tier, folders.worktree, folders.scratch, runOutcomeSchema, ticket);
    store.endRun(runId, clock.now(), run.status, run.reason);
    if (run.status !== 'done') throw new NotYetHandled(`Run ended ${run.status}: ${run.reason}`);
    if ((await workspace.commitsAhead(ticket.branch, repo.defaultBranch)) === 0) {
      throw new NotYetHandled('Run made no commits');
    }

    await workspace.push(ticket.branch);
    const pr = await github.createPullRequest(repo.owner, repo.name, {
      head: ticket.branch,
      base: repo.defaultBranch,
      title: ticket.title,
      body: `${run.prBody}\n\nCloses #${ticket.issueNumber}`,
    });
    store.updateTicket(id, { prNumber: pr.number });
    const checks = await github.getChecks(repo.owner, repo.name, ticket.branch);
    if (checks !== 'success') throw new NotYetHandled(`CI is ${checks}`);

    this.setState(id, 'reviewing');
    // Simplest reviewer rule for now: the Run's own Model Tier (#27 picks the other Agent).
    const reviewTier = ticket.tier;
    const reviewId = store.startReview(id, reviewTier, clock.now());
    const review = await this.runAgent('review', reviewTier, folders.worktree, folders.scratch, reviewOutcomeSchema, ticket);
    store.endReview(reviewId, clock.now(), review.verdict, review.findings);
    if (review.verdict !== 'approve') throw new NotYetHandled(`Review verdict ${review.verdict}`);

    if (mostCautious(ticket.door, run.door, review.door) !== 'two-way') throw new NotYetHandled('One-way Ticket');
    await github.mergePullRequest(repo.owner, repo.name, pr.number, 'squash');
    this.setState(id, 'merged');
  }

  private async runAgent<S extends z.ZodType>(
    mode: RunMode,
    tier: ModelTier,
    cwd: string,
    scratchDir: string,
    schema: S,
    ticket: StoredTicket,
  ): Promise<z.infer<S>> {
    const events = this.deps.agentRunner.start({
      tier,
      cwd,
      scratchDir,
      mode,
      instructions: `# ${ticket.title}\n\n${ticket.body}`,
      resultSchema: z.toJSONSchema(schema) as Record<string, unknown>,
      timeoutMs: RUN_TIME_LIMIT_MS,
      signal: AbortSignal.any([this.stopping.signal, AbortSignal.timeout(RUN_TIME_LIMIT_MS)]),
    });
    for await (const event of events) {
      if (event.type === 'result') return schema.parse(event.result);
    }
    throw new NotYetHandled(`${mode} ended without a result`);
  }
}
