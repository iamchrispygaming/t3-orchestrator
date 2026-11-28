// The engine: the Ticket state machine. It talks to the outside only through
// the AgentRunner and GitHub ports, the store and the repo workspace.
//
// Waiting -> Ready when every blocker is Merged; Ready -> Running when the
// Ticket's Agent has a free slot, in queue order; then the tracer-bullet path
// Running -> Reviewing -> Merged. Every other branch of the state machine stops
// with NotYetHandled until the ticket that builds it lands (Escalation #26, Review #27, doors #28, ...).
import { z } from 'zod';
import type {
  Agent,
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
import {
  reviewOutcomeSchema,
  runOutcomeSchema,
  type AgentRunner,
  type RunMode,
  type RunOutcome,
} from './agent-runner.ts';
import type { Clock } from './clock.ts';
import { deleteRunLogs } from './data-folder.ts';
import type { GitHub } from './github.ts';
import type { Notifier } from './notifier.ts';
import type { Store, StoredTicket } from './store.ts';
import { DEFAULT_LADDER, nextTierOf, otherAgent } from './ladder.ts';
import { Quota } from './quota.ts';
import { priced } from './usage.ts';
import { RepoWorkspace, type TicketFolders } from './workspace.ts';

export const RUN_TIME_LIMIT_MS = 60 * 60_000;
// Live output kept in memory per Ticket; older lines drop off.
export const OUTPUT_LINES_KEPT = 2000;

export class NotYetHandled extends Error {}

// A command the Orchestrator turns down as things stand (HTTP 409).
export class Refused extends Error {}

export class NotFound extends Error {}

export type EngineDeps = {
  store: Store;
  github: GitHub;
  agentRunner: AgentRunner;
  clock: Clock;
  notifier: Notifier; // nothing notifies yet: an auto-merge never does
  dataFolder: string;
  log: (message: string, error?: unknown) => void;
  // Stops the Target Repo's Planner work and waits until it has let go of the repo's folder.
  stopPlannerWork: (repoId: number) => Promise<void>;
};

type Call = 'one-way' | 'two-way' | 'unclear';

// How the Agent's side of a Run or Review ended.
type AgentEnd<T> = { kind: 'result'; result: T } | { kind: 'quota-hit' };

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

function publicTicket({ body: _body, pausedFrom: _pausedFrom, quotaHold: _quotaHold, ...ticket }: StoredTicket): Ticket {
  return ticket;
}

export class Engine {
  private listeners = new Set<(ticket: Ticket) => void>();
  private outputListeners = new Set<(ticketId: number, text: string) => void>();
  private outputs = new Map<number, string[]>();
  private inFlight = new Set<Promise<void>>();
  private stopping = new AbortController();
  // Agent executions in progress: a slot is held from the Run's start until the
  // Agent returns, not while the Orchestrator pushes, opens the PR and waits on CI.
  private slotsInUse: Record<Agent, number> = { claude: 0, codex: 0 };
  private repoLocks = new Map<string, Promise<void>>();
  private deps: EngineDeps;
  private quota: Quota;

  constructor(deps: EngineDeps) {
    this.deps = deps;
    this.quota = new Quota(deps.store, deps.clock, () => this.quotaFreed());
  }

  subscribe(listener: (ticket: Ticket) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // Live Agent output of every Run and Review, line by line.
  subscribeOutput(listener: (ticketId: number, text: string) => void): () => void {
    this.outputListeners.add(listener);
    return () => this.outputListeners.delete(listener);
  }

  output(ticketId: number): string[] {
    return [...(this.outputs.get(ticketId) ?? [])];
  }

  tickets(): Ticket[] {
    return this.deps.store.listTickets().map(publicTicket);
  }

  targetRepos(): TargetRepo[] {
    return this.deps.store.listTargetRepos();
  }

  // Adding and removing one repo never overlap: each takes that repo's lock and
  // checks again inside it, before it touches the repo's folder.
  async addTargetRepo(owner: string, name: string): Promise<TargetRepo> {
    return this.withRepoLock(owner, name, async () => {
      const { store, github, dataFolder } = this.deps;
      const live = store.findTargetRepo(owner, name);
      if (live) throw new Refused(`${live.owner}/${live.name} is already a Target Repo`);
      const info = await github.getRepo(owner, name);
      // No live Target Repo owns this folder (checked above, under the lock), so the
      // clone may clear out whatever a failed clone or removal left there.
      await new RepoWorkspace(dataFolder, owner, name).clone(info.cloneUrl);
      return store.addTargetRepo({ owner, name, defaultBranch: info.defaultBranch });
    });
  }

  // Deletes the Target Repo's clone, worktrees, scratch folders and Run logs. Its
  // Tickets' Runs and Reviews stay on record, so Cost estimates keep their history.
  // The repo stays listed until cleanup has finished, so a failed cleanup can be retried;
  // from the moment cleanup starts it takes no new work, across restarts too.
  async removeTargetRepo(id: number): Promise<void> {
    const found = this.deps.store.getTargetRepo(id);
    if (!found) throw new NotFound(`no Target Repo ${id}`);
    await this.withRepoLock(found.owner, found.name, async () => {
      const { store, clock, dataFolder } = this.deps;
      const repo = store.getTargetRepo(id);
      if (!repo) throw new NotFound(`no Target Repo ${id}`);
      // A Review works in the Ticket's worktree too, so it blocks removal like a Run.
      const busy = store.listTicketsOfRepo(id).find((t) => t.state === 'running' || t.state === 'reviewing');
      if (busy) {
        const now = busy.state === 'running' ? 'Running' : 'Reviewing';
        throw new Refused(
          `${repo.owner}/${repo.name} can't be removed while its Tickets are Running: #${busy.issueNumber} is ${now}`,
        );
      }
      store.markTargetRepoRemoving(id, clock.now()); // no new Ticket or Plan from here
      await this.deps.stopPlannerWork(id);
      await new RepoWorkspace(dataFolder, repo.owner, repo.name).remove();
      await deleteRunLogs(dataFolder, store.listRunIds(id));
      store.markTargetRepoRemoved(id, clock.now());
    });
  }

  // The user's override: a Paused Ticket returns to its previous state and its next
  // Run starts at its own Model Tier whatever the quota readings say.
  resumeTicket(id: number): Ticket {
    const { store } = this.deps;
    const ticket = store.getTicket(id);
    if (!ticket) throw new NotFound(`no Ticket ${id}`);
    if (ticket.state !== 'paused') throw new Refused(`Ticket ${id} is not Paused`);
    store.updateTicket(id, { state: ticket.pausedFrom ?? 'ready', pausedFrom: null, quotaHold: 'override' });
    this.emit(id);
    this.schedule();
    return publicTicket(store.getTicket(id)!);
  }

  ticket(id: number): Ticket | undefined {
    const ticket = this.deps.store.getTicket(id);
    return ticket && publicTicket(ticket);
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
    if (!repo) throw new NotFound(`no Target Repo ${req.repoId}`);
    if (store.isTargetRepoRemoving(repo.id)) throw new Refused(`${repo.owner}/${repo.name} is being removed`);
    const entries = await Promise.all(
      req.tickets.map(async (entry) => ({
        entry,
        issue: await github.getIssue(repo.owner, repo.name, entry.issueNumber),
        // A blocker a merged PR already closed is done. Any other blocker holds the
        // Ticket until a merge closes it or the Orchestrator's own Ticket for it is Merged.
        blockers: await github.getBlockers(repo.owner, repo.name, entry.issueNumber),
      })),
    );

    // The repo may have been removed while GitHub answered (a re-add gets a new id, so
    // this registration stays removed). From this check until the Tickets exist nothing
    // awaits, and the scheduler never starts a Ticket on a repo being removed.
    if (!store.getTargetRepo(repo.id) || store.isTargetRepoRemoving(repo.id)) {
      throw new Refused(`${repo.owner}/${repo.name} was removed while the Ticket was being registered`);
    }

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

  // At startup: arms the quota timers and resumes Tickets whose quota freed while the server was down.
  start(): void {
    this.quota.start();
    this.quotaFreed();
  }

  // Stops in-flight Runs and waits for them to wind down.
  async stop(): Promise<void> {
    this.stopping.abort();
    this.quota.stop();
    while (this.inFlight.size > 0) await Promise.allSettled([...this.inFlight]);
  }

  private async withRepoLock<T>(owner: string, name: string, task: () => Promise<T>): Promise<T> {
    const key = `${owner}/${name}`.toLowerCase(); // GitHub ignores case in owner/repo
    const previous = this.repoLocks.get(key) ?? Promise.resolve();
    const result = previous.then(task);
    const settled = result.then(
      () => undefined,
      () => undefined,
    );
    this.repoLocks.set(key, settled);
    void settled.then(() => {
      if (this.repoLocks.get(key) === settled) this.repoLocks.delete(key);
    });
    return result;
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

  // Sent after every write a Ticket's drawer shows: state, PR, Run and Review records.
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
    for (const ticket of store.readyQueue()) {
      const tier = this.route(ticket);
      if (!tier) {
        store.updateTicket(ticket.id, { pausedFrom: 'ready' });
        this.setState(ticket.id, 'paused');
        continue;
      }
      const agent = tier.agent;
      if (this.slotsInUse[agent] >= limits[agent]) continue;
      this.slotsInUse[agent]++;
      // The override and the hold cover one start only.
      store.updateTicket(ticket.id, { tier, quotaHold: null });
      this.setState(ticket.id, 'running');
      this.track(this.work(ticket.id));
    }
  }

  // Routing at run time: the Ticket's own Model Tier, unless its Agent is near its
  // quota limit; then the other Agent's next more capable tier on the Ladder. None
  // that can start (that Agent is near its limit too, or there is no tier above): Paused.
  // A Run its quota cut short waits for that Agent and reruns at the same tier.
  private route(ticket: StoredTicket): ModelTier | undefined {
    if (ticket.quotaHold === 'override' || !this.quota.nearLimit(ticket.tier.agent)) return ticket.tier;
    if (ticket.quotaHold === 'same-tier') return undefined;
    const other = nextTierOf(DEFAULT_LADDER, ticket.tier, otherAgent(ticket.tier.agent));
    return other && !this.quota.nearLimit(other.agent) ? other : undefined;
  }

  // Quota freed: every Paused Ticket that could start now returns to its previous state.
  private quotaFreed(): void {
    if (this.stopping.signal.aborted) return;
    const { store } = this.deps;
    for (const ticket of store.pausedTickets()) {
      if (!this.route(ticket)) continue;
      store.updateTicket(ticket.id, { state: ticket.pausedFrom ?? 'ready', pausedFrom: null });
      this.emit(ticket.id);
    }
    this.schedule();
  }

  private freeSlot(agent: Agent): void {
    this.slotsInUse[agent]--;
    this.schedule();
  }

  // A merge may unblock Waiting Tickets, in any Target Repo, through the Ticket
  // itself or through every other issue its PR closed. Re-read each Waiting
  // Ticket's blockers from GitHub, the same evidence registration uses.
  private async merged(ticket: StoredTicket): Promise<void> {
    const { store, github } = this.deps;
    this.setState(ticket.id, 'merged');
    for (const waiting of store.waitingTickets()) {
      try {
        const repo = store.getTargetRepo(waiting.repoId)!;
        store.recordBlockers(waiting.id, await github.getBlockers(repo.owner, repo.name, waiting.issueNumber));
      } catch (error) {
        this.deps.log(`Could not re-read the blockers of Ticket ${waiting.id}`, error);
      }
      if (store.getTicket(waiting.id)!.state === 'waiting' && store.unmetBlockers(waiting.id) === 0) {
        this.setState(waiting.id, 'ready');
      }
    }
    this.schedule();
  }

  private emitOutput(id: number, text: string): void {
    const lines = this.outputs.get(id) ?? [];
    lines.push(text);
    if (lines.length > OUTPUT_LINES_KEPT) lines.splice(0, lines.length - OUTPUT_LINES_KEPT);
    this.outputs.set(id, lines);
    for (const listener of this.outputListeners) listener(id, text);
  }

  private async work(id: number): Promise<void> {
    const { store, github, clock } = this.deps;
    const ticket = store.getTicket(id)!;
    const repo = store.getTargetRepo(ticket.repoId);
    // A Ticket never starts on a Target Repo that is gone or being removed (the ready
    // queue already leaves those out): hand the slot back and leave the Ticket Ready.
    if (!repo || store.isTargetRepoRemoving(repo.id)) {
      this.setState(id, 'ready');
      this.freeSlot(ticket.tier.agent);
      return;
    }
    const workspace = new RepoWorkspace(this.deps.dataFolder, repo.owner, repo.name);

    let folders: TicketFolders;
    let end: AgentEnd<RunOutcome>;
    try {
      folders = await workspace.prepareTicket(ticket.issueNumber, ticket.branch, repo.defaultBranch);
      const runId = store.startRun(id, ticket.tier, clock.now());
      this.emit(id);
      end = await this.runAgent('run', ticket.tier, folders.worktree, folders.scratch, runOutcomeSchema, ticket);
      if (end.kind === 'quota-hit') store.endRun(runId, clock.now(), 'quota-hit', "the Agent's quota ran out mid-Run");
      else store.endRun(runId, clock.now(), end.result.status, end.result.reason, priced(ticket.tier, end.result.usage));
      this.emit(id);
    } finally {
      this.freeSlot(ticket.tier.agent);
    }
    if (end.kind === 'quota-hit') {
      // Not a failure: back in the queue to rerun at the same Model Tier once this Agent's quota frees.
      store.updateTicket(id, { quotaHold: 'same-tier' });
      this.setState(id, 'ready');
      this.schedule();
      return;
    }
    const run = end.result;
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
    this.emit(id);
    const checks = await github.getChecks(repo.owner, repo.name, ticket.branch);
    if (checks !== 'success') throw new NotYetHandled(`CI is ${checks}`);

    this.setState(id, 'reviewing');
    // Simplest reviewer rule for now: the Run's own Model Tier (#27 picks the other Agent).
    const reviewTier = ticket.tier;
    const reviewId = store.startReview(id, reviewTier, clock.now());
    this.emit(id);
    const reviewEnd = await this.runAgent('review', reviewTier, folders.worktree, folders.scratch, reviewOutcomeSchema, ticket);
    if (reviewEnd.kind === 'quota-hit') throw new NotYetHandled("the reviewer's quota ran out mid-Review");
    const review = reviewEnd.result;
    store.endReview(reviewId, clock.now(), review.verdict, review.findings, priced(reviewTier, review.usage));
    this.emit(id);
    if (review.verdict !== 'approve') throw new NotYetHandled(`Review verdict ${review.verdict}`);

    if (mostCautious(ticket.door, run.door, review.door) !== 'two-way') throw new NotYetHandled('One-way Ticket');
    await github.mergePullRequest(repo.owner, repo.name, pr.number, 'squash');
    await this.merged(ticket);
  }

  private async runAgent<S extends z.ZodType>(
    mode: RunMode,
    tier: ModelTier,
    cwd: string,
    scratchDir: string,
    schema: S,
    ticket: StoredTicket,
  ): Promise<AgentEnd<z.infer<S>>> {
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
    // A `rejected` reading, once seen, is the outcome: the quota ran out, whatever the Agent reports after.
    let quotaHit = false;
    let result: z.infer<S> | undefined;
    for await (const event of events) {
      if (event.type === 'text') this.emitOutput(ticket.id, event.text);
      if (event.type === 'rate-limit') {
        this.quota.record(event);
        if (event.status === 'rejected' && event.agent === tier.agent) quotaHit = true;
      }
      if (event.type === 'result') {
        result = schema.parse(event.result);
        break;
      }
    }
    if (quotaHit) return { kind: 'quota-hit' };
    if (result !== undefined) return { kind: 'result', result };
    throw new NotYetHandled(`${mode} ended without a result`);
  }
}
