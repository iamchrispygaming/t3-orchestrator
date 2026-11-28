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

export const ticketStateSchema = z.enum(['ready', 'running', 'reviewing', 'merged']);
export type TicketState = z.infer<typeof ticketStateSchema>;

export const addTargetRepoRequestSchema = z.object({
  owner: z.string().min(1),
  name: z.string().min(1),
});
export type AddTargetRepoRequest = z.infer<typeof addTargetRepoRequestSchema>;

export const targetRepoSchema = z.object({
  id: z.number().int(),
  owner: z.string(),
  name: z.string(),
  defaultBranch: z.string(),
});
export type TargetRepo = z.infer<typeof targetRepoSchema>;

export const registerTicketRequestSchema = z.object({
  repoId: z.number().int(),
  issueNumber: z.number().int().positive(),
  tier: modelTierSchema,
  door: doorSchema,
});
export type RegisterTicketRequest = z.infer<typeof registerTicketRequestSchema>;

export const ticketSchema = z.object({
  id: z.number().int(),
  repoId: z.number().int(),
  issueNumber: z.number().int(),
  title: z.string(),
  branch: z.string(),
  tier: modelTierSchema,
  door: doorSchema,
  state: ticketStateSchema,
  prNumber: z.number().int().nullable(),
});
export type Ticket = z.infer<typeof ticketSchema>;

export const runRecordSchema = z.object({
  tier: modelTierSchema,
  startedAt: z.iso.datetime(),
  endedAt: z.iso.datetime().nullable(),
  outcome: z.enum(['done', 'failed', 'cannot', 'needs-permission']).nullable(),
});
export type RunRecord = z.infer<typeof runRecordSchema>;

export const reviewRecordSchema = z.object({
  tier: modelTierSchema,
  startedAt: z.iso.datetime(),
  endedAt: z.iso.datetime().nullable(),
  verdict: z.enum(['approve', 'changes-needed', 'unclear']).nullable(),
});
export type ReviewRecord = z.infer<typeof reviewRecordSchema>;

export const ticketDetailSchema = ticketSchema.extend({
  runs: z.array(runRecordSchema),
  reviews: z.array(reviewRecordSchema),
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
]);
export type ServerEvent = z.infer<typeof serverEventSchema>;

export const errorResponseSchema = z.object({ error: z.string() });
