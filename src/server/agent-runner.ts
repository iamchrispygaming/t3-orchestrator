// The Run port (ADR 0002): one narrow interface for starting an Agent run at a
// Model Tier in a worktree. Runs, Reviews and the Planner all use it.
import { z } from 'zod';
import { planDraftSchema, planQuestionSchema, type ModelTier } from '../shared/api.ts';

export type JsonSchema = Record<string, unknown>;

export const usageSchema = z.object({
  inputTokens: z.number().nonnegative(),
  outputTokens: z.number().nonnegative(),
  costUsd: z.number().nonnegative().optional(),
});
export type Usage = z.infer<typeof usageSchema>;

const callSchema = z.enum(['one-way', 'two-way', 'unclear']);

export const runOutcomeSchema = z.object({
  kind: z.literal('run'),
  status: z.enum(['done', 'failed', 'cannot', 'needs-permission']),
  reason: z.string(),
  prBody: z.string(),
  door: callSchema,
  blastRadius: z.string(),
  usage: usageSchema,
});

export const reviewOutcomeSchema = z.object({
  kind: z.literal('review'),
  verdict: z.enum(['approve', 'changes-needed', 'unclear']),
  findings: z.string(),
  door: callSchema,
  usage: usageSchema,
});

// One Planner turn: its chat message, the next round of questions (none once it
// drafts) and the whole current draft. `sessionId` resumes the session next turn.
export const planOutcomeSchema = z.object({
  kind: z.literal('plan'),
  sessionId: z.string().min(1),
  message: z.string(),
  questions: z.array(planQuestionSchema),
  draft: planDraftSchema.nullable(),
  usage: usageSchema,
});

export const runResultSchema = z.discriminatedUnion('kind', [runOutcomeSchema, reviewOutcomeSchema, planOutcomeSchema]);
export type RunResult = z.infer<typeof runResultSchema>;
export type RunOutcome = z.infer<typeof runOutcomeSchema>;
export type ReviewOutcome = z.infer<typeof reviewOutcomeSchema>;
export type PlanOutcome = z.infer<typeof planOutcomeSchema>;

export type RunEvent =
  | { type: 'text'; text: string }
  | { type: 'tool'; name: string; detail: string }
  // A quota reading seen mid-Run, for the quota port. `near-limit` means slow down;
  // `rejected` means no more quota until `resetsAt`: a quota hit, which is not a
  // failure and uses up no Model Tier.
  | {
      type: 'rate-limit';
      agent: ModelTier['agent'];
      status: 'allowed' | 'near-limit' | 'rejected';
      resetsAt?: string;
      utilization?: number;
    }
  | { type: 'result'; result: RunResult };

export type RunMode = 'run' | 'review' | 'plan';

export type RunRequest = {
  tier: ModelTier;
  cwd: string; // Ticket worktree (or read-only checkout for Planner/Review)
  scratchDir: string;
  mode: RunMode;
  instructions: string; // Ticket body + failure note / feedback + skill copies
  resumeSessionId?: string; // continue an earlier session (the Planner's)
  resultSchema: JsonSchema;
  timeoutMs: number;
  signal: AbortSignal;
};

// A Run that crashes or exits non-zero throws from the iterable, or ends without a
// 'result' event. Aborting `signal` (the Run time limit, a server stop) must end it.
export interface AgentRunner {
  start(req: RunRequest): AsyncIterable<RunEvent>;
}
