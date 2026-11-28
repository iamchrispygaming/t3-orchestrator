// The engine: the Ticket state machine. It talks to the outside only through
// the AgentRunner and GitHub ports, the store and the repo workspace.
//
// Waiting -> Ready when every blocker is Merged; Ready -> Running when the
// Ticket's Agent has a free slot, in queue order; then the tracer-bullet path
// Running -> Reviewing -> Merged. Every other branch of the state machine stops
// with NotYetHandled until the ticket that builds it lands (Escalation #26, Review #27, doors #28, ...).
import { z } from 'zod';
import type {
  Door,
  ModelTier,
  ApprovedPlan,
  ParallelLimits,
  RegisterApprovedPlanRequest,
  RegisterTicketRequest,
  TargetRepo,
  Ticket,
  TicketState,
  UpdateParallelLimitsRequest,
} from '../shared/api.ts';
import { reviewOutcomeSchema, runOutcomeSchema, type AgentRunner, type RunMode } from './agent-runner.ts';
import type { Clock } from './clock.ts';
import type { GitHub } from './github.ts';
import type { Notifier } from './notifier.ts';
import type { Store, StoredTicket } from './store.ts';
import { RepoWorkspace } from './workspace.ts';

export const RUN_TIME_LIMIT_MS = 60 * 60_000;

export class NotYetHandled extends Error {}

export type EngineDeps = {
  store: Store;
  github: GitHub;
  agentRunner: AgentRunner;
  clock: Clock;
  notifier: Notifier; // nothing notifies yet: an auto-merge never does
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
  // A title with no ASCII letters or digits still gets a slug.
  return `t3o/${issueNumber}-${slug || 'issue'}`;
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

  async registerTicket({ repoId, ...ticket }: RegisterTicketRequest): Promise<Ticket> {
    const plan = await this.registerApprovedPlan({ repoId, tickets: [ticket] });
    return plan.tickets[0]!;
  }

  // Registers an approved Plan: each Ticket waits on its open blockers, and the
  // Tickets queue in the order given.
  async registerApprovedPlan(req: RegisterApprovedPlanRequest): Promise<ApprovedPlan> {
    const { store, github, clock } = this.deps;
    const repo = store.getTargetRepo(req.repoId);
    if (!repo) throw new Error(`no Target Repo ${req.repoId}`);
    const entries = await Promise.all(
      req.tickets.map(async (entry) => ({
        entry,
        issue: await github.getIssue(repo.owner, repo.name, entry.issueNumber),
        // A blocker already closed on GitHub is done; it never holds the Ticket back.
        blockers: (await github.getBlockers(repo.owner, repo.name, entry.issueNumber))
          .filter((blocker) => blocker.state === 'open')
          .map((blocker) => blocker.number),
      })),
    );

    const { plan, ids } = store.transaction(() => {
      const plan = store.addApprovedPlan(repo.id, clock.now());
      const ids = entries.map(({ entry, issue, blockers }, position) =>
        store.addTicket({
          repoId: repo.id,
          issueNumber: issue.number,
          title: issue.title,
          body: issue.body,
          branch: branchName(issue.number, issue.title),
          tier: entry.tier,
          door: entry.door,
          state: 'waiting',
          planId: plan.id,
          planPosition: position,
          blockers,
        }).id,
      );
      // Only once every Ticket of the Plan exists can blockers inside it be resolved.
      for (const id of ids) if (store.unmetBlockers(id) === 0) store.updateTicket(id, { state: 'ready' });
      return { plan, ids };
    });

    const tickets = ids.map((id) => publicTicket(store.getTicket(id)!));
    for (const id of ids) this.emit(id);
    this.schedule();
    return { ...plan, tickets };
  }

  parallelLimits(): ParallelLimits {
    return this.deps.store.parallelLimits();
  }

  updateParallelLimits(change: UpdateParallelLimitsRequest): ParallelLimits {
    const limits = this.deps.store.updateParallelLimits(change);
    this.schedule(); // a raised limit frees slots
    return limits;
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

  // Starts Ready Tickets in queue order while their Agent has a free slot.
  // Synchronous, so two calls can never hand out the same slot.
  private schedule(): void {
    if (this.stopping.signal.aborted) return;
    const { store } = this.deps;
    const limits = store.parallelLimits();
    const running = store.runningPerAgent();
    for (const ticket of store.readyQueue()) {
      const agent = ticket.tier.agent;
      if (running[agent] >= limits[agent]) continue;
      running[agent]++;
      this.setState(ticket.id, 'running');
      this.track(this.work(ticket.id));
    }
  }

  // A merge may unblock Waiting dependents; they join the queue straight away.
  private merged(ticket: StoredTicket): void {
    this.setState(ticket.id, 'merged');
    for (const dependent of this.deps.store.waitingDependents(ticket.repoId, ticket.issueNumber)) {
      if (this.deps.store.unmetBlockers(dependent.id) === 0) this.setState(dependent.id, 'ready');
    }
    this.schedule();
  }

  private async work(id: number): Promise<void> {
    const { store, github, clock } = this.deps;
    const ticket = store.getTicket(id)!;
    const repo = store.getTargetRepo(ticket.repoId)!;
    const workspace = new RepoWorkspace(this.deps.dataFolder, repo.owner, repo.name);

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
    this.schedule(); // the Run is over, so its slot is free
    // Simplest reviewer rule for now: the Run's own Model Tier (#27 picks the other Agent).
    const reviewTier = ticket.tier;
    const reviewId = store.startReview(id, reviewTier, clock.now());
    const review = await this.runAgent('review', reviewTier, folders.worktree, folders.scratch, reviewOutcomeSchema, ticket);
    store.endReview(reviewId, clock.now(), review.verdict, review.findings);
    if (review.verdict !== 'approve') throw new NotYetHandled(`Review verdict ${review.verdict}`);

    if (mostCautious(ticket.door, run.door, review.door) !== 'two-way') throw new NotYetHandled('One-way Ticket');
    await github.mergePullRequest(repo.owner, repo.name, pr.number, 'squash');
    this.merged(ticket);
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
