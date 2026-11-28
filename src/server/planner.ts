// The Planner: a headless, resumable session at the one fixed Planner Model Tier,
// read-only on a fresh checkout of the Target Repo's default branch. It interviews
// the user in numbered rounds and keeps a structured Plan draft, all held locally
// until the Plan is approved or discarded.
import { existsSync } from 'node:fs';
import { z } from 'zod';
import {
  modelTierSchema,
  planDraftSchema,
  planQuestionSchema,
  type ApprovedPlan,
  type EditPlanDraftRequest,
  type PlanDraft,
  type ModelTier,
  type Plan,
  type ReplyToPlanRequest,
  type StartPlanRequest,
  type TargetRepo,
} from '../shared/api.ts';
import { planOutcomeSchema, type AgentRunner, type PlanOutcome } from './agent-runner.ts';
import type { Clock } from './clock.ts';
import type { Store, StoredPlan } from './store.ts';
import { RepoWorkspace } from './workspace.ts';

export const PLANNER_TURN_LIMIT_MS = 60 * 60_000;

// The most capable Claude tier on the default Ladder. A setting, never chosen by Cost.
export const DEFAULT_PLANNER_TIER: ModelTier = { agent: 'claude', model: 'opus', effort: 'high' };
const PLANNER_TIER_SETTING = 'plannerTier';

export class PlanNotFound extends Error {}
export class PlanBusy extends Error {}

export type PlanEvent = { type: 'plan'; plan: Plan } | { type: 'plan-discarded'; planId: number };

export type PlannerDeps = {
  store: Store;
  approveDraft: (id: number, repoId: number, draft: PlanDraft) => Promise<ApprovedPlan>;
  agentRunner: AgentRunner;
  clock: Clock;
  dataFolder: string;
  log: (message: string, error?: unknown) => void;
};

// A turn asks questions, returns a draft, or both; never neither.
const turnSchema = planOutcomeSchema.refine((r) => r.questions.length > 0 || r.draft !== null, {
  message: 'a Planner turn must ask a question or return a draft',
});
// After "just draft it": no more questions, and the draft is required.
const justDraftSchema = planOutcomeSchema.extend({
  questions: z.array(planQuestionSchema).max(0),
  draft: planDraftSchema,
});

const INTERVIEW_RULES = `You are the Planner. Read the Target Repo in your working folder (read-only) before you ask anything, so your questions are grounded in the real code.
Interview the user in rounds: each round is a short list of questions, each with your recommended answer, so the user can reply "yes" or in their own words. Keep going until you share an understanding, then stop asking.
With every reply, return the whole current Plan draft as far as you can write it: a Spec, its Tickets, the blocking edges between them (blockedBy, by Ticket key), each Ticket's Model Tier with a one-line reason, and whether each Ticket is expected to be one-way or two-way. Return no draft only while you know too little to write one.`;

// "just draft it" typed as a plain reply counts as the command.
function isJustDraft(text: string | undefined): boolean {
  return /^just draft it[.!]*$/i.test((text ?? '').trim());
}

const JUST_DRAFT = 'The user says: just draft it. Ask no more questions: return no questions and the complete Plan draft now.';

function canPublish(draft: PlanDraft): boolean {
  const tickets = new Map(draft.tickets.map((ticket) => [ticket.key, ticket]));
  if (tickets.size === 0 || tickets.size !== draft.tickets.length) return false;
  const visiting = new Set<string>();
  const visited = new Set<string>();
  function visit(key: string): boolean {
    if (visited.has(key)) return true;
    const ticket = tickets.get(key);
    if (!ticket || visiting.has(key)) return false;
    visiting.add(key);
    if (!ticket.blockedBy.every(visit)) return false;
    visiting.delete(key);
    visited.add(key);
    return true;
  }
  return draft.tickets.every((ticket) => visit(ticket.key));
}

export class Planner {
  private listeners = new Set<(event: PlanEvent) => void>();
  private inFlight = new Set<Promise<void>>();
  private approvals = new Map<number, Promise<ApprovedPlan>>();
  private aborts = new Map<number, AbortController>();
  private turns = new Map<number, Promise<void>>(); // each Plan's turn in progress
  private stopping = new AbortController();
  private deps: PlannerDeps;

  constructor(deps: PlannerDeps) {
    this.deps = deps;
  }

  subscribe(listener: (event: PlanEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  plans(): Plan[] {
    return this.deps.store.listPlans().map((p) => this.publicPlan(p));
  }

  plan(id: number): Plan {
    const plan = this.deps.store.getPlan(id);
    if (!plan) throw new PlanNotFound(`no Plan ${id}`);
    return this.publicPlan(plan);
  }

  plannerTier(): ModelTier {
    const stored = modelTierSchema.safeParse(this.deps.store.getSetting(PLANNER_TIER_SETTING));
    return stored.success ? stored.data : DEFAULT_PLANNER_TIER;
  }

  setPlannerTier(tier: ModelTier): void {
    this.deps.store.setSetting(PLANNER_TIER_SETTING, tier);
  }

  async start(req: StartPlanRequest): Promise<Plan> {
    const { store, clock } = this.deps;
    const repo = store.getTargetRepo(req.repoId);
    if (!repo) throw new PlanNotFound(`no Target Repo ${req.repoId}`);
    if (store.isTargetRepoRemoving(repo.id)) throw new PlanBusy(`${repo.owner}/${repo.name} is being removed`);
    // The tier is fixed per Plan: a resumed session never moves to another Agent or model.
    const plan = store.addPlan({ repoId: repo.id, tier: this.plannerTier(), idea: req.idea, createdAt: clock.now() });
    this.emit(plan.id);
    this.startTurn(plan.id);
    return this.plan(plan.id);
  }

  editDraft(id: number, req: EditPlanDraftRequest): Plan {
    const plan = this.plan(id);
    this.requireEditable(plan);
    if (plan.status === 'thinking' || !plan.draft) throw new PlanBusy(`Plan ${id} has no editable draft`);
    const draft = plan.draft;

    if (req.spec) draft.spec = { ...draft.spec, ...req.spec };
    if (req.ticket) {
      const { key, tier, ...textAndDoor } = req.ticket;
      const ticket = draft.tickets.find((entry) => entry.key === key);
      if (!ticket) throw new PlanNotFound(`no Ticket ${key} on Plan ${id}`);
      Object.assign(ticket, textAndDoor);
      if (tier && (tier.agent !== ticket.tier.agent || tier.model !== ticket.tier.model || tier.effort !== ticket.tier.effort)) {
        ticket.tier = tier;
        ticket.tierReason = '';
      }
    }
    this.deps.store.updatePlan(id, { draft });
    this.emit(id);
    return this.plan(id);
  }

  async approve(id: number): Promise<ApprovedPlan> {
    const plan = this.plan(id);
    if (this.stopping.signal.aborted || this.approvals.has(id)) throw new PlanBusy(`Plan ${id} cannot start approval now`);
    if ((plan.status !== 'drafted' && plan.status !== 'publishing') || !plan.draft) throw new PlanBusy(`Plan ${id} is not ready for approval`);
    const draft = plan.draft;
    if (!canPublish(draft)) throw new PlanBusy(`Plan ${id} needs Tickets with unique keys and valid, acyclic blockers`);

    this.deps.store.updatePlan(id, { status: 'publishing' });
    const approval = this.deps.approveDraft(id, plan.repoId, draft);
    this.approvals.set(id, approval);
    this.emit(id);
    try {
      const approved = await approval;
      this.emit(id);
      return approved;
    } finally {
      this.approvals.delete(id);
    }
  }

  private requireEditable(plan: Pick<Plan, 'id' | 'status'>): void {
    if (plan.status === 'approved' || plan.status === 'publishing') {
      throw new PlanBusy(`Plan ${plan.id} is being approved or is already approved`);
    }
  }

  async reply(id: number, req: ReplyToPlanRequest): Promise<Plan> {
    const { store, clock } = this.deps;
    const plan = store.getPlan(id);
    if (!plan) throw new PlanNotFound(`no Plan ${id}`);
    this.requireEditable(plan);
    if (plan.status === 'thinking') throw new PlanBusy(`Plan ${id} is waiting on the Planner`);
    const repo = store.getTargetRepo(plan.repoId);
    if (repo && store.isTargetRepoRemoving(repo.id)) throw new PlanBusy(`${repo.owner}/${repo.name} is being removed`);
    const justDraft = req.justDraft === true || isJustDraft(req.text);
    store.addPlanMessage(id, { from: 'user', text: req.text ?? 'Just draft it.', justDraft, at: clock.now().toISOString() });
    store.updatePlan(id, { status: 'thinking' });
    this.emit(id);
    this.startTurn(id);
    return this.plan(id);
  }

  // Drops the draft and its chat. Nothing was ever written to GitHub, so nothing is undone there.
  async discard(id: number): Promise<void> {
    const { store } = this.deps;
    const plan = store.getPlan(id);
    if (!plan) throw new PlanNotFound(`no Plan ${id}`);
    this.requireEditable(plan);
    this.aborts.get(id)?.abort();
    store.deletePlan(id);
    for (const listener of this.listeners) listener({ type: 'plan-discarded', planId: id });
    await this.workspace(store.getTargetRepo(plan.repoId)!).removePlannerCheckout(id);
  }

  // After a restart: redo every turn the last server stop cut short.
  resume(): void {
    for (const plan of this.deps.store.listPlans()) {
      if (plan.status === 'thinking') this.startTurn(plan.id);
    }
  }

  // Before a Target Repo's folder is deleted: stops its Plans' turns and waits until
  // they have let go of the folder. Turns cut short end as failed.
  async stopTurnsOn(repoId: number): Promise<void> {
    const plans = this.deps.store.listPlans().filter((p) => p.repoId === repoId);
    for (const plan of plans) this.aborts.get(plan.id)?.abort();
    await Promise.allSettled(plans.map((p) => this.turns.get(p.id)));
    for (const plan of plans) {
      if (this.deps.store.getPlan(plan.id)?.status === 'thinking') this.fail(plan.id, 'the Target Repo is being removed');
    }
  }

  async stop(): Promise<void> {
    this.stopping.abort();
    await Promise.allSettled(this.approvals.values());
    while (this.inFlight.size > 0) await Promise.allSettled([...this.inFlight]);
  }

  private startTurn(id: number): void {
    const turn = this.turn(id);
    this.turns.set(id, turn);
    this.track(turn);
    void turn.catch(() => undefined).finally(() => {
      if (this.turns.get(id) === turn) this.turns.delete(id);
    });
  }

  private fail(id: number, reason: string): void {
    const { store, clock } = this.deps;
    store.addPlanMessage(id, { from: 'planner', text: `The Planner stopped: ${reason}`, round: null, at: clock.now().toISOString() });
    store.updatePlan(id, { status: 'failed' });
    this.emit(id);
  }

  private track(work: Promise<void>): void {
    const tracked = work.catch((error) => this.deps.log('Planner turn stopped', error));
    this.inFlight.add(tracked);
    void tracked.finally(() => this.inFlight.delete(tracked));
  }

  private workspace(repo: TargetRepo): RepoWorkspace {
    return new RepoWorkspace(this.deps.dataFolder, repo.owner, repo.name);
  }

  private publicPlan(plan: StoredPlan): Plan {
    const { sessionId: _sessionId, publishedIssues, ...rest } = plan;
    return {
      ...rest,
      ...(plan.status === 'approved' ? { specIssue: publishedIssues[0] } : {}),
      messages: this.deps.store.listPlanMessages(plan.id),
    };
  }

  private emit(id: number): void {
    const plan = this.deps.store.getPlan(id);
    if (!plan) return;
    const event: PlanEvent = { type: 'plan', plan: this.publicPlan(plan) };
    for (const listener of this.listeners) listener(event);
  }

  private async turn(id: number): Promise<void> {
    const { store, clock } = this.deps;
    const repoId = store.getPlan(id)?.repoId;
    // A repo being removed (or gone) takes no Planner work: its folder is about to go.
    if (repoId !== undefined && (!store.getTargetRepo(repoId) || store.isTargetRepoRemoving(repoId))) {
      this.fail(id, 'the Target Repo is being removed');
      return;
    }
    const abort = new AbortController();
    this.aborts.set(id, abort);
    // A discard aborts the turn; ids are never reused, so this also guards a later Plan.
    const cancelled = () => abort.signal.aborted || this.stopping.signal.aborted || !store.getPlan(id);
    try {
      await this.prepareCheckout(id);
      if (cancelled()) return;
      const result = await this.ask(id, abort.signal);
      if (cancelled()) return; // drop a late result: nothing is saved for a cancelled turn
      const roundsSoFar = store.listPlanMessages(id).filter((m) => m.from === 'planner' && m.round).length;
      const round = result.questions.length > 0 ? { number: roundsSoFar + 1, questions: result.questions } : null;
      store.addPlanMessage(id, { from: 'planner', text: result.message, round, at: clock.now().toISOString() });
      store.updatePlan(id, {
        sessionId: result.sessionId,
        status: round ? 'asking' : 'drafted',
        ...(result.draft ? { draft: result.draft } : {}),
      });
      this.emit(id);
    } catch (error) {
      // A server stop leaves the turn 'thinking' so the restart redoes it.
      if (this.stopping.signal.aborted || abort.signal.aborted || !store.getPlan(id)) return;
      this.deps.log(`Planner turn on Plan ${id} failed`, error);
      this.fail(id, error instanceof Error ? error.message : String(error));
    } finally {
      if (this.aborts.get(id) === abort) this.aborts.delete(id);
      // A discard during setup can race the checkout into existence again; clear it here.
      if (!store.getPlan(id)) await this.removeCheckout(repoId, id).catch((error) => this.deps.log('Planner checkout cleanup failed', error));
    }
  }

  // The first turn reads a fresh checkout (redone if a stop cut setup short); later turns reuse it.
  private async prepareCheckout(id: number): Promise<void> {
    const plan = this.deps.store.getPlan(id);
    if (!plan) return;
    const repo = this.deps.store.getTargetRepo(plan.repoId)!;
    const workspace = this.workspace(repo);
    if (plan.sessionId && existsSync(workspace.plannerFolders(id).worktree)) return;
    await workspace.removePlannerCheckout(id);
    await workspace.preparePlannerCheckout(id, repo.defaultBranch);
  }

  private async removeCheckout(repoId: number | undefined, id: number): Promise<void> {
    if (repoId === undefined) return;
    const repo = this.deps.store.getTargetRepo(repoId);
    if (repo) await this.workspace(repo).removePlannerCheckout(id);
  }

  private async ask(id: number, signal: AbortSignal): Promise<PlanOutcome> {
    const { store } = this.deps;
    const plan = store.getPlan(id)!;
    const repo = store.getTargetRepo(plan.repoId)!;
    const messages = store.listPlanMessages(id);
    const last = messages.at(-1);
    if (last?.from !== 'user') throw new Error('nothing for the Planner to answer');
    const schema = last.justDraft ? justDraftSchema : turnSchema;
    const request = last.justDraft ? `${JUST_DRAFT}\n\n${last.text}` : last.text;
    const reply = plan.draft
      ? [request, "Use the current Plan draft below as the basis for your reply, including the user's direct edits. Return the full updated draft when you redraw it.", JSON.stringify(plan.draft, null, 2)].join('\n\n')
      : request;
    const instructions = plan.sessionId
      ? reply
      : `${INTERVIEW_RULES}\n\nTarget Repo: ${repo.owner}/${repo.name} (default branch ${repo.defaultBranch}).\n\nThe idea:\n\n${reply}`;
    const folders = this.workspace(repo).plannerFolders(id);

    const events = this.deps.agentRunner.start({
      tier: plan.tier,
      cwd: folders.worktree,
      scratchDir: folders.scratch,
      mode: 'plan',
      instructions,
      ...(plan.sessionId ? { resumeSessionId: plan.sessionId } : {}),
      resultSchema: z.toJSONSchema(schema) as Record<string, unknown>,
      timeoutMs: PLANNER_TURN_LIMIT_MS,
      signal: AbortSignal.any([this.stopping.signal, signal, AbortSignal.timeout(PLANNER_TURN_LIMIT_MS)]),
    });
    for await (const event of events) {
      if (event.type === 'result') return schema.parse(event.result);
    }
    throw new Error('the Planner ended without a result');
  }
}
