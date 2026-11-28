// The Run port (ADR 0002): one narrow interface for starting an Agent run at a
// Model Tier in a worktree. Runs, Reviews and the Planner all use it.
import { z } from 'zod';
import type { ModelTier } from '../shared/api.ts';

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

export const runResultSchema = z.discriminatedUnion('kind', [runOutcomeSchema, reviewOutcomeSchema]);
export type RunResult = z.infer<typeof runResultSchema>;
export type RunOutcome = z.infer<typeof runOutcomeSchema>;
export type ReviewOutcome = z.infer<typeof reviewOutcomeSchema>;

export type RunEvent =
  | { type: 'text'; text: string }
  | { type: 'result'; result: RunResult };

export type RunMode = 'run' | 'review' | 'plan';

export type RunRequest = {
  tier: ModelTier;
  cwd: string; // Ticket worktree (or read-only checkout for Planner/Review)
  scratchDir: string;
  mode: RunMode;
  instructions: string; // Ticket body + failure note / feedback + skill copies
  resultSchema: JsonSchema;
  timeoutMs: number;
  signal: AbortSignal;
};

export interface AgentRunner {
  start(req: RunRequest): AsyncIterable<RunEvent>;
}
