// The engine: the Ticket state machine. It talks to the outside only through
// the AgentRunner and GitHub ports, the store and the repo workspace.
//
// Waiting -> Ready when every blocker is Merged; Ready -> Running when the
// Ticket's Agent has a free slot, in queue order; then Running -> Reviewing ->
// Merged, and Escalation (a failed Run goes back to Ready one Model Tier up;
// failing at the top is a Handback). Every other branch of the state machine
// stops with NotYetHandled until the ticket that builds it lands (Review #27,
// doors #28, Handback actions #30, ...).
import { z } from 'zod';
import {
  escalationSettingsSchema,
  type Agent,
  type ApprovedPlan,
  type Door,
  type EscalationSettings,
  type ModelTier,
  type ParallelLimits,
  type RegisterApprovedPlanRequest,
  type RegisterTicketRequest,
  type RunOutcomeKind,
  type TargetRepo,
  type Ticket,
  type TicketState,
  type UpdateParallelLimitsRequest,
} from '../shared/api.ts';
import {
  reviewOutcomeSchema,
  runOutcomeSchema,
  type AgentRunner,
  type RunEvent,
  type RunMode,
  type RunOutcome,
  type Usage,
} from './agent-runner.ts';
import type { Clock } from './clock.ts';
import { deleteRunLogs } from './data-folder.ts';
import type { FailedJob, GitHub } from './github.ts';
import { DEFAULT_ESCALATION_SETTINGS, nextTier, nextTierOf, otherAgent, tierLabel } from './ladder.ts';
import type { Notifier } from './notifier.ts';
import { Quota } from './quota.ts';
import type { Store, StoredTicket } from './store.ts';
import { priced } from './usage.ts';
import { BranchMoved, RepoWorkspace, type TicketFolders } from './workspace.ts';

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

// How the Agent's side of a Run ended, with the usage it reported, if any.
type AgentEnd<T> = (
  | { kind: 'result'; result: T }
  | { kind: 'crashed'; message: string }
  | { kind: 'timed-out' }
  | { kind: 'quota-hit' }
  | { kind: 'stopped' } // the server is stopping
) & { usage?: Usage };

// How a whole Run ended, once commits and CI are checked.
type RunEnd =
  | { kind: 'succeeded'; run: RunOutcome; prNumber: number }
  | { kind: 'failed'; outcome: RunOutcomeKind; reason: string }
  | { kind: 'not-a-failure' } // quota hit, Orchestrator or GitHub error: no Model Tier used up
  | { kind: 'handback'; reason: string } // stopped for the user, no Model Tier used up
  | { kind: 'requeue' } // quota changed before the Agent started: Routing decides again
  | { kind: 'stopped' };

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

function publicTicket({
  body: _body,
  publishedHead: _head,
  pausedFrom: _pausedFrom,
  quotaHold: _quotaHold,
  ...ticket
}: StoredTicket): Ticket {
  return ticket;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type Diagnostics = { agentReason?: string; failedJobs?: FailedJob[] };

// What the next Run is told about a failed one: why it failed, the Agent's own
// stated reason, and each failing CI job's name and log tail, whichever exist.
function failureNote(tier: ModelTier, outcome: RunOutcomeKind, reason: string, diagnostics: Diagnostics): string {
  const agentReason = diagnostics.agentReason?.trim();
  const jobs = (diagnostics.failedJobs ?? []).map((job) => `### ${job.name}\n\n\`\`\`\n${job.logTail}\n\`\`\``);
  return [
    `The previous Run, at ${tierLabel(tier)}, ended ${outcome}: ${reason}`,
    ...(agentReason && agentReason !== reason ? [`The Agent said: ${agentReason}`] : []),
    ...(jobs.length > 0 ? ['Failing CI jobs:', ...jobs] : []),
  ].join('\n\n');
}

function runInstructions(ticket: StoredTicket, note: string | null): string {
  const task = `# ${ticket.title}\n\n${ticket.body}`;
  if (note === null) return task;
  return `${task}\n\n## Why the previous Run failed\n\n${note}\n\nYou start fresh from the latest default branch. Don't repeat that failure.`;
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

  // The Ladder and the Run time limit, each stored under its own settings key.
  settings(): EscalationSettings {
    const { store } = this.deps;
    const keys = Object.keys(DEFAULT_ESCALATION_SETTINGS) as (keyof EscalationSettings)[];
    const stored = Object.fromEntries(keys.flatMap((key) => {
      const value = store.getSetting(key);
      return value === undefined ? [] : [[key, value]];
    }));
    return escalationSettingsSchema.parse({ ...DEFAULT_ESCALATION_SETTINGS, ...stored });
  }

  updateSettings(change: Partial<EscalationSettings>): EscalationSettings {
    for (const [key, value] of Object.entries(change)) {
      if (value !== undefined) this.deps.store.setSetting(key, value);
    }
    return this.settings();
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
      if (tierLabel(tier) !== tierLabel(ticket.tier)) store.updateTicket(ticket.id, { tier });
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
    const other = nextTierOf(this.settings().ladder, ticket.tier, otherAgent(ticket.tier.agent));
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

  // Runs a Ticket that schedule() started: it holds a slot of its Agent.
  private async work(id: number): Promise<void> {
    const { store } = this.deps;
    const ticket = store.getTicket(id)!;
    const repo = store.getTargetRepo(ticket.repoId);
    // A Ticket never starts on a Target Repo that is gone or being removed (the ready
    // queue already leaves those out): hand the slot back and leave the Ticket Ready.
    if (!repo || store.isTargetRepoRemoving(repo.id)) {
      this.setState(id, 'ready');
      this.freeSlot(ticket.tier.agent);
      return;
    }
    const end = await this.run(id, repo);
    switch (end.kind) {
      case 'stopped':
        return; // the Run record stays open; restart recovery (#34) redoes it at the same tier
      case 'not-a-failure':
        // Back in the queue at the same Model Tier: the next schedule() picks it up.
        // Not started again from here, so a lasting GitHub error can't spin.
        this.setState(id, 'ready');
        // A quota hit waits for that Agent: Routing pauses it now, not on the next schedule.
        if (this.deps.store.getTicket(id)!.quotaHold === 'same-tier') this.schedule();
        return;
      case 'requeue':
        // Nothing ran: Routing moves or pauses it with the quota as it is now.
        this.setState(id, 'ready');
        this.schedule();
        return;
      case 'failed':
        this.escalate(id, end.outcome, end.reason);
        return;
      case 'handback':
        this.deps.store.updateTicket(id, { state: 'handback', handbackReason: end.reason });
        this.emit(id);
        return;
      case 'succeeded':
        await this.review(id, end.run, end.prNumber);
    }
  }

  // Exactly one Model Tier up per failure. At the top of the Ladder: Handback.
  private escalate(id: number, outcome: RunOutcomeKind, reason: string): void {
    const ticket = this.deps.store.getTicket(id)!;
    const next = nextTier(this.settings().ladder, ticket.tier);
    if (!next) {
      const handbackReason = `Failed at ${tierLabel(ticket.tier)}, the most capable Model Tier on the Ladder (${outcome}): ${reason}`;
      this.deps.store.updateTicket(id, { state: 'handback', handbackReason });
      this.emit(id);
      return;
    }
    this.deps.store.updateTicket(id, { state: 'ready', tier: next });
    this.emit(id);
    this.schedule(); // the next tier may be another Agent's: it queues for that Agent's slot
  }

  // One Run: a fresh worktree, the Agent, then commits, push, draft PR and CI.
  // The Agent's slot is held until the Agent has wound down, not while the
  // Orchestrator pushes, opens the PR and waits on CI.
  private async run(id: number, repo: TargetRepo): Promise<RunEnd> {
    const { store, github, clock, log } = this.deps;
    const ticket = store.getTicket(id)!;
    const workspace = new RepoWorkspace(this.deps.dataFolder, repo.owner, repo.name);
    const { runTimeLimitMinutes } = this.settings();

    let folders: TicketFolders;
    let runId: number;
    let agentEnd: AgentEnd<RunOutcome>;
    try {
      try {
        folders = await workspace.prepareTicket(ticket.issueNumber, ticket.branch, repo.defaultBranch);
      } catch (error) {
        log('Could not prepare the worktree', error);
        return { kind: 'not-a-failure' };
      }
      // Quota may have changed while the worktree was prepared: decide again before the
      // Agent starts. The worktree stays as it is; nothing has run in it.
      const route = this.route(store.getTicket(id)!);
      if (!route || tierLabel(route) !== tierLabel(ticket.tier)) return { kind: 'requeue' };
      const instructions = runInstructions(ticket, store.lastFailureNote(id));
      store.updateTicket(id, { quotaHold: null }); // the override and the hold cover one start only
      runId = store.startRun(id, ticket.tier, clock.now());
      this.emit(id);
      agentEnd = await this.runAgent('run', id, ticket.tier, folders, runOutcomeSchema, instructions, runTimeLimitMinutes);
    } finally {
      this.freeSlot(ticket.tier.agent);
    }
    const endedAt = clock.now();
    // Usage is kept whatever the outcome, a quota hit's and a crash's included.
    if (agentEnd.usage) store.recordRunUsage(runId, priced(ticket.tier, agentEnd.usage));
    if (agentEnd.kind === 'stopped') return { kind: 'stopped' };
    // The Run record shows the Agent's own report as soon as the Agent is done;
    // it gets its final outcome (no commits, red CI, ...) once that is known.
    if (agentEnd.kind === 'result') {
      const { status, reason } = agentEnd.result;
      store.endRun(runId, endedAt, status, status === 'done' ? null : reason);
      this.emit(id);
    }

    const fail = (outcome: RunOutcomeKind, reason: string, diagnostics: Diagnostics = {}): RunEnd => {
      store.endRun(runId, endedAt, outcome, reason, failureNote(ticket.tier, outcome, reason, diagnostics));
      this.emit(id);
      return { kind: 'failed', outcome, reason };
    };
    // CI results that are already in, for the note only: never waits on CI, and a
    // GitHub error here doesn't change the Run's outcome.
    const redJobsSoFar = async (): Promise<FailedJob[]> => {
      try {
        if ((await github.getChecks(repo.owner, repo.name, ticket.branch)) !== 'failure') return [];
        return await github.getFailedJobs(repo.owner, repo.name, ticket.branch);
      } catch (error) {
        log('Could not read CI results for the failure note', error);
        return [];
      }
    };

    try {
      // Whatever the Run's outcome, its commits go up: the PR opens as a draft
      // after the first Run with commits, and later Runs force-push the branch.
      const commits = await workspace.commitsAhead(ticket.branch, repo.defaultBranch);
      let prNumber = ticket.prNumber;
      if (commits > 0) {
        const head = await workspace.push(ticket.branch, ticket.publishedHead);
        store.updateTicket(id, { publishedHead: head });
        if (prNumber === null) {
          const run = agentEnd.kind === 'result' ? agentEnd.result : undefined;
          prNumber = await this.openDraftPullRequest(ticket, repo, run);
        }
      }

      const jobsIfCommitted = () => (commits > 0 ? redJobsSoFar() : Promise.resolve([]));
      switch (agentEnd.kind) {
        case 'quota-hit':
          // Not a failure: it reruns at the same Model Tier once this Agent's quota frees.
          store.updateTicket(id, { quotaHold: 'same-tier' });
          store.endRun(runId, endedAt, 'quota-hit', "the Agent's quota ran out mid-Run");
          this.emit(id);
          return { kind: 'not-a-failure' };
        case 'crashed':
          return fail('crashed', `the Agent crashed: ${agentEnd.message}`, { failedJobs: await jobsIfCommitted() });
        case 'timed-out':
          return fail('timed-out', `the Run time limit (${runTimeLimitMinutes} min) passed`, {
            failedJobs: await jobsIfCommitted(),
          });
      }
      const run = agentEnd.result;
      if (run.status === 'failed' || run.status === 'cannot') {
        return fail(run.status, run.reason, { failedJobs: await jobsIfCommitted() });
      }
      if (run.status === 'needs-permission') {
        store.endRun(runId, endedAt, run.status, run.reason);
        this.emit(id);
        throw new NotYetHandled(`Run ended needs-permission: ${run.reason}`);
      }
      if (commits === 0 || prNumber === null) {
        return fail('no-commits', 'the Run made no commits', { agentReason: run.reason });
      }

      const checks = await github.getChecks(repo.owner, repo.name, ticket.branch);
      if (checks === 'failure') {
        // Red CI is the failure; the job names and log tails are best effort.
        let failedJobs: FailedJob[] = [];
        try {
          failedJobs = await github.getFailedJobs(repo.owner, repo.name, ticket.branch);
        } catch (error) {
          log('Could not read the failing CI jobs', error);
        }
        const reason = `CI failed: ${failedJobs.map((j) => j.name).join(', ') || 'job logs unavailable'}`;
        return fail('ci-failed', reason, { agentReason: run.reason, failedJobs });
      }
      if (checks !== 'success') throw new NotYetHandled(`CI is ${checks}`); // CI wait comes with #30

      await github.updatePullRequest(repo.owner, repo.name, prNumber, { body: this.pullRequestBody(ticket, run) });
      await github.markPullRequestReady(repo.owner, repo.name, prNumber);
      store.endRun(runId, endedAt, 'done', null);
      this.emit(id);
      return { kind: 'succeeded', run, prNumber };
    } catch (error) {
      if (error instanceof NotYetHandled) throw error;
      if (error instanceof BranchMoved) {
        // Someone pushed to the Ticket's branch: never overwrite their work. Not the
        // Agent's failure, so no Model Tier is used up; the user decides (#30).
        const reason = `Not pushing: ${error.message}. Someone else's commits are on it; the Orchestrator won't overwrite them.`;
        store.endRun(runId, endedAt, 'interrupted', reason);
        this.emit(id);
        return { kind: 'handback', reason };
      }
      // An Orchestrator or GitHub error is not the Agent's failure.
      log('Run cut short by an Orchestrator or GitHub error', error);
      store.endRun(runId, endedAt, 'interrupted', `Orchestrator or GitHub error: ${errorMessage(error)}`);
      this.emit(id);
      return { kind: 'not-a-failure' };
    }
  }

  private pullRequestBody(ticket: StoredTicket, run: RunOutcome | undefined): string {
    const body = run?.prBody.trim() ? run.prBody : 'Work in progress: no Run has succeeded yet.';
    return `${body}\n\nCloses #${ticket.issueNumber}`;
  }

  private async openDraftPullRequest(ticket: StoredTicket, repo: TargetRepo, run: RunOutcome | undefined) {
    const pr = await this.deps.github.createPullRequest(repo.owner, repo.name, {
      head: ticket.branch,
      base: repo.defaultBranch,
      title: ticket.title,
      body: this.pullRequestBody(ticket, run),
      draft: true,
    });
    this.deps.store.updateTicket(ticket.id, { prNumber: pr.number });
    this.emit(ticket.id);
    return pr.number;
  }

  private async review(id: number, run: RunOutcome, prNumber: number): Promise<void> {
    const { store, github, clock } = this.deps;
    const ticket = store.getTicket(id)!;
    const repo = store.getTargetRepo(ticket.repoId)!;
    const workspace = new RepoWorkspace(this.deps.dataFolder, repo.owner, repo.name);
    const folders = workspace.ticketFolders(ticket.issueNumber);

    this.setState(id, 'reviewing');
    // Simplest reviewer rule for now: the Run's own Model Tier (#27 picks the other Agent).
    const reviewTier = ticket.tier;
    const reviewId = store.startReview(id, reviewTier, clock.now());
    this.emit(id);
    const end = await this.runAgent(
      'review',
      id,
      reviewTier,
      folders,
      reviewOutcomeSchema,
      `# ${ticket.title}\n\n${ticket.body}`,
      this.settings().runTimeLimitMinutes,
    );
    if (end.usage) store.recordReviewUsage(reviewId, priced(reviewTier, end.usage));
    if (end.kind !== 'result') throw new NotYetHandled(`Review ended ${end.kind}`);
    const review = end.result;
    store.endReview(reviewId, clock.now(), review.verdict, review.findings);
    this.emit(id);
    if (review.verdict !== 'approve') throw new NotYetHandled(`Review verdict ${review.verdict}`);

    if (mostCautious(ticket.door, run.door, review.door) !== 'two-way') throw new NotYetHandled('One-way Ticket');
    await github.mergePullRequest(repo.owner, repo.name, prNumber, 'squash');
    await this.merged(ticket);
  }

  // Runs the Agent until its result, a crash, a quota hit, the time limit on the
  // engine's clock, or a server stop, whichever comes first.
  private async runAgent<S extends z.ZodType>(
    mode: RunMode,
    ticketId: number,
    tier: ModelTier,
    folders: TicketFolders,
    schema: S,
    instructions: string,
    timeLimitMinutes: number,
  ): Promise<AgentEnd<z.infer<S>>> {
    const timeoutMs = timeLimitMinutes * 60_000;
    const timeLimit = new AbortController();
    const cancelTimer = this.deps.clock.setTimer(timeoutMs, () => timeLimit.abort());
    const signal = AbortSignal.any([this.stopping.signal, timeLimit.signal]);
    const aborted = new Promise<'aborted'>((resolve) => {
      if (signal.aborted) resolve('aborted');
      signal.addEventListener('abort', () => resolve('aborted'), { once: true });
    });
    let quotaHit = false;
    let result: z.infer<S> | undefined;
    let crash: string | undefined;
    let iterator: AsyncIterator<RunEvent> | undefined;
    try {
      iterator = this.deps.agentRunner
        .start({
          tier,
          cwd: folders.worktree,
          scratchDir: folders.scratch,
          mode,
          instructions,
          resultSchema: z.toJSONSchema(schema) as Record<string, unknown>,
          timeoutMs,
          signal,
        })
        [Symbol.asyncIterator]();
      // Read to the end of the stream, past the result: the Agent has only finished
      // once it has exited, and a bad exit after a result still fails the Run.
      for (;;) {
        const step = await Promise.race([iterator.next(), aborted]);
        if (step === 'aborted' || step.done) break;
        const event = step.value;
        if (event.type === 'text') this.emitOutput(ticketId, event.text);
        if (event.type === 'rate-limit') {
          this.quota.record(event);
          if (event.status === 'rejected' && event.agent === tier.agent) quotaHit = true;
        }
        if (event.type === 'result' && result === undefined) result = schema.parse(event.result);
      }
    } catch (error) {
      crash = errorMessage(error);
    }
    // Always close the stream and wait for the Agent to wind down, so nothing
    // counts commits, pushes or resets the worktree while it is still exiting.
    // The time limit stays armed meanwhile, so an Agent stuck exiting is aborted.
    await iterator?.return?.().catch(() => undefined);
    cancelTimer();

    // A quota hit, once seen, is the outcome: a slow exit that crosses the time
    // limit afterwards must not turn it into a failure. Otherwise the time limit
    // or a bad exit fails the Run even after it reported a result.
    const usage: { usage?: Usage } = result === undefined ? {} : { usage: (result as { usage: Usage }).usage };
    if (this.stopping.signal.aborted) return { kind: 'stopped', ...usage };
    if (quotaHit) return { kind: 'quota-hit', ...usage };
    if (timeLimit.signal.aborted) return { kind: 'timed-out', ...usage };
    if (crash !== undefined) return { kind: 'crashed', message: crash, ...usage };
    if (result !== undefined) return { kind: 'result', result, ...usage };
    return { kind: 'crashed', message: `${mode} ended without a result` };
  }
}
