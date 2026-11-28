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

// Server-Sent Events on GET /api/events. The first event is always a snapshot.
export const serverEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('snapshot'), tickets: z.array(ticketSchema) }),
  z.object({ type: z.literal('ticket'), ticket: ticketSchema }),
]);
export type ServerEvent = z.infer<typeof serverEventSchema>;

export const errorResponseSchema = z.object({ error: z.string() });
