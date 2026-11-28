// The Planner: a headless, resumable session at the one fixed Planner Model Tier,
// read-only on a fresh checkout of the Target Repo's default branch. It interviews
// the user in numbered rounds and keeps a structured Plan draft, all held locally
// until the Plan is approved (#38) or discarded.
import { z } from 'zod';
import {
  modelTierSchema,
  planDraftSchema,
  planQuestionSchema,
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

const JUST_DRAFT = 'The user says: just draft it. Ask no more questions: return no questions and the complete Plan draft now.';

export class Planner {
  private listeners = new Set<(event: PlanEvent) => void>();
  private inFlight = new Set<Promise<void>>();
  private aborts = new Map<number, AbortController>();
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
    const plan = store.addPlan(repo.id, clock.now());
    try {
      await this.workspace(repo).preparePlannerCheckout(plan.id, repo.defaultBranch);
    } catch (error) {
      store.deletePlan(plan.id);
      throw error;
    }
    store.addPlanMessage(plan.id, { from: 'user', text: req.idea, justDraft: false, at: clock.now().toISOString() });
    this.emit(plan.id);
    this.track(this.turn(plan.id));
    return this.plan(plan.id);
  }

  async reply(id: number, req: ReplyToPlanRequest): Promise<Plan> {
    const { store, clock } = this.deps;
    const plan = store.getPlan(id);
    if (!plan) throw new PlanNotFound(`no Plan ${id}`);
    if (plan.status === 'thinking') throw new PlanBusy(`Plan ${id} is waiting on the Planner`);
    const justDraft = req.justDraft === true;
    store.addPlanMessage(id, { from: 'user', text: req.text ?? 'Just draft it.', justDraft, at: clock.now().toISOString() });
    store.updatePlan(id, { status: 'thinking' });
    this.emit(id);
    this.track(this.turn(id));
    return this.plan(id);
  }

  // Drops the draft and its chat. Nothing was ever written to GitHub, so nothing is undone there.
  async discard(id: number): Promise<void> {
    const { store } = this.deps;
    const plan = store.getPlan(id);
    if (!plan) throw new PlanNotFound(`no Plan ${id}`);
    this.aborts.get(id)?.abort();
    store.deletePlan(id);
    for (const listener of this.listeners) listener({ type: 'plan-discarded', planId: id });
    await this.workspace(store.getTargetRepo(plan.repoId)!).removePlannerCheckout(id);
  }

  // After a restart: redo every turn the last server stop cut short.
  resume(): void {
    for (const plan of this.deps.store.listPlans()) {
      if (plan.status === 'thinking') this.track(this.turn(plan.id));
    }
  }

  async stop(): Promise<void> {
    this.stopping.abort();
    while (this.inFlight.size > 0) await Promise.allSettled([...this.inFlight]);
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
    const { sessionId: _sessionId, ...rest } = plan;
    return { ...rest, messages: this.deps.store.listPlanMessages(plan.id) };
  }

  private emit(id: number): void {
    const plan = this.deps.store.getPlan(id);
    if (!plan) return;
    const event: PlanEvent = { type: 'plan', plan: this.publicPlan(plan) };
    for (const listener of this.listeners) listener(event);
  }

  private async turn(id: number): Promise<void> {
    const { store, clock } = this.deps;
    const abort = new AbortController();
    this.aborts.set(id, abort);
    try {
      const result = await this.ask(id, abort.signal);
      if (!store.getPlan(id)) return; // discarded meanwhile
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
      const reason = error instanceof Error ? error.message : String(error);
      store.addPlanMessage(id, { from: 'planner', text: `The Planner stopped: ${reason}`, round: null, at: clock.now().toISOString() });
      store.updatePlan(id, { status: 'failed' });
      this.emit(id);
    } finally {
      if (this.aborts.get(id) === abort) this.aborts.delete(id);
    }
  }

  private async ask(id: number, signal: AbortSignal): Promise<PlanOutcome> {
    const { store } = this.deps;
    const plan = store.getPlan(id)!;
    const repo = store.getTargetRepo(plan.repoId)!;
    const messages = store.listPlanMessages(id);
    const last = messages.at(-1);
    if (last?.from !== 'user') throw new Error('nothing for the Planner to answer');
    const schema = last.justDraft ? justDraftSchema : turnSchema;
    const reply = last.justDraft ? `${JUST_DRAFT}\n\n${last.text}` : last.text;
    const instructions = plan.sessionId
      ? reply
      : `${INTERVIEW_RULES}\n\nTarget Repo: ${repo.owner}/${repo.name} (default branch ${repo.defaultBranch}).\n\nThe idea:\n\n${reply}`;
    const folders = this.workspace(repo).plannerFolders(id);

    const events = this.deps.agentRunner.start({
      tier: this.plannerTier(),
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
