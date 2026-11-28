// Request and response schemas for the Orchestrator's HTTP + SSE API.
// Shared by the server and the web UI so both agree on every shape.
import { z } from 'zod';

export const modelTierSchema = z.object({
  agent: z.enum(['claude', 'codex']),
  model: z.string().min(1),
  effort: z.string().min(1),
});
export type ModelTier = z.infer<typeof modelTierSchema>;

export const doorSchema = z.enum(['one-way', 'two-way']);
export type Door = z.infer<typeof doorSchema>;

export const agentSchema = modelTierSchema.shape.agent;
export type Agent = z.infer<typeof agentSchema>;

export const ticketStateSchema = z.enum(['waiting', 'ready', 'running', 'reviewing', 'merged']);
export type TicketState = z.infer<typeof ticketStateSchema>;

// A GitHub `owner/repo`. Anything GitHub itself would not allow (`..`, slashes) is
// refused. Owners may hold `_`: Enterprise Managed User names end in `_<shortcode>`.
export const addTargetRepoRequestSchema = z.object({
  owner: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/, 'not a GitHub owner'),
  name: z
    .string()
    .regex(/^[A-Za-z0-9._-]{1,100}$/, 'not a GitHub repository name')
    .refine((name) => name !== '.' && name !== '..', 'not a GitHub repository name'),
});
export type AddTargetRepoRequest = z.infer<typeof addTargetRepoRequestSchema>;

export const targetRepoSchema = z.object({
  id: z.number().int(),
  owner: z.string(),
  name: z.string(),
  defaultBranch: z.string(),
});
export type TargetRepo = z.infer<typeof targetRepoSchema>;

const ticketEntrySchema = z.object({
  issueNumber: z.number().int().positive(),
  tier: modelTierSchema,
  door: doorSchema,
});

// One hand-made Ticket: a one-Ticket Plan, approved on registration.
export const registerTicketRequestSchema = ticketEntrySchema.extend({ repoId: z.number().int() });
export type RegisterTicketRequest = z.infer<typeof registerTicketRequestSchema>;

// A hand-made Plan of existing issues, approved on registration (until Plan
// approval publishes drafts, #38). Its Tickets queue in the order given; their
// blockers come from GitHub's native dependencies.
export const registerApprovedPlanRequestSchema = z.object({
  repoId: z.number().int(),
  tickets: z.array(ticketEntrySchema).min(1),
});
export type RegisterApprovedPlanRequest = z.infer<typeof registerApprovedPlanRequestSchema>;

export const ticketSchema = z.object({
  id: z.number().int(),
  repoId: z.number().int(),
  repo: z.string(), // the Target Repo's `owner/name`
  issueNumber: z.number().int(),
  title: z.string(),
  branch: z.string(),
  tier: modelTierSchema,
  door: doorSchema,
  state: ticketStateSchema,
  prNumber: z.number().int().nullable(),
});
export type Ticket = z.infer<typeof ticketSchema>;

export const approvedPlanSchema = z.object({
  id: z.number().int(),
  repoId: z.number().int(),
  approvedAt: z.iso.datetime(),
  tickets: z.array(ticketSchema),
});
export type ApprovedPlan = z.infer<typeof approvedPlanSchema>;

const parallelLimitSchema = z.number().int().min(1);

// Runs per Agent at once, counted across all Plans and Target Repos.
export const parallelLimitsSchema = z.object({ claude: parallelLimitSchema, codex: parallelLimitSchema });
export type ParallelLimits = z.infer<typeof parallelLimitsSchema>;

export const updateParallelLimitsRequestSchema = parallelLimitsSchema.partial();
export type UpdateParallelLimitsRequest = z.infer<typeof updateParallelLimitsRequestSchema>;

export const runRecordSchema = z.object({
  tier: modelTierSchema,
  startedAt: z.iso.datetime(),
  endedAt: z.iso.datetime().nullable(),
  outcome: z.enum(['done', 'failed', 'cannot', 'needs-permission']).nullable(),
  reason: z.string().nullable(), // why it failed; null while running or when it succeeded
});
export type RunRecord = z.infer<typeof runRecordSchema>;

export const reviewRecordSchema = z.object({
  tier: modelTierSchema,
  startedAt: z.iso.datetime(),
  endedAt: z.iso.datetime().nullable(),
  verdict: z.enum(['approve', 'changes-needed', 'unclear']).nullable(),
  findings: z.string().nullable(), // null while the Review runs
});
export type ReviewRecord = z.infer<typeof reviewRecordSchema>;

export const ticketDetailSchema = ticketSchema.extend({
  runs: z.array(runRecordSchema),
  reviews: z.array(reviewRecordSchema),
  // Live Agent output of its Runs and Reviews since the server started, oldest first.
  output: z.array(z.string()),
});
export type TicketDetail = z.infer<typeof ticketDetailSchema>;

// A Plan draft as the Planner writes it. Ticket keys are local to the draft;
// `blockedBy` names the keys of the Tickets that must merge first.
export const planDraftSchema = z.object({
  spec: z.object({ title: z.string().min(1), body: z.string() }),
  tickets: z.array(
    z.object({
      key: z.string().min(1),
      title: z.string().min(1),
      body: z.string(),
      tier: modelTierSchema,
      tierReason: z.string(),
      door: doorSchema,
      blockedBy: z.array(z.string()),
    }),
  ),
});
export type PlanDraft = z.infer<typeof planDraftSchema>;

export const planQuestionSchema = z.object({ question: z.string().min(1), recommended: z.string() });
export type PlanQuestion = z.infer<typeof planQuestionSchema>;

export const planRoundSchema = z.object({
  number: z.number().int().positive(),
  questions: z.array(planQuestionSchema).min(1),
});
export type PlanRound = z.infer<typeof planRoundSchema>;

// The Planner chat. A user message is the idea, an answer, or "just draft it";
// a Planner message carries the round it asks, if any.
export const planMessageSchema = z.discriminatedUnion('from', [
  z.object({ from: z.literal('user'), text: z.string(), justDraft: z.boolean(), at: z.iso.datetime() }),
  z.object({ from: z.literal('planner'), text: z.string(), round: planRoundSchema.nullable(), at: z.iso.datetime() }),
]);
export type PlanMessage = z.infer<typeof planMessageSchema>;

// thinking: the Planner's turn. asking: a round waits for answers.
// drafted: a draft and no open questions. failed: the last turn broke; replying retries.
export const planStatusSchema = z.enum(['thinking', 'asking', 'drafted', 'failed']);
export type PlanStatus = z.infer<typeof planStatusSchema>;

export const planSchema = z.object({
  id: z.number().int(),
  repoId: z.number().int(),
  tier: modelTierSchema, // the Planner tier this Plan started at; its session stays on it
  status: planStatusSchema,
  createdAt: z.iso.datetime(),
  draft: planDraftSchema.nullable(),
  messages: z.array(planMessageSchema),
});
export type Plan = z.infer<typeof planSchema>;

export const startPlanRequestSchema = z.object({
  repoId: z.number().int(),
  idea: z.string().min(1),
});
export type StartPlanRequest = z.infer<typeof startPlanRequestSchema>;

// An answer to the open round, or "just draft it" (with optional words of its own).
export const replyToPlanRequestSchema = z.union([
  z.object({ text: z.string().min(1), justDraft: z.literal(false).optional() }),
  z.object({ text: z.string().optional(), justDraft: z.literal(true) }),
]);
export type ReplyToPlanRequest = z.infer<typeof replyToPlanRequestSchema>;

export const settingsSchema = z.object({ plannerTier: modelTierSchema });
export type Settings = z.infer<typeof settingsSchema>;

// Server-Sent Events on GET /api/events. The first event is always a snapshot.
export const serverEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('snapshot'), tickets: z.array(ticketSchema), plans: z.array(planSchema) }),
  z.object({ type: z.literal('ticket'), ticket: ticketSchema }),
  z.object({ type: z.literal('plan'), plan: planSchema }),
  z.object({ type: z.literal('plan-discarded'), planId: z.number().int() }),
  // One line of a Run's or Review's live Agent output.
  z.object({ type: z.literal('output'), ticketId: z.number().int(), text: z.string() }),
]);
export type ServerEvent = z.infer<typeof serverEventSchema>;

export const errorResponseSchema = z.object({ error: z.string() });
