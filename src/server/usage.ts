// Usage and Cost: what a Run or Review would have cost at API list prices. Claude
// Code reports dollars itself; Codex reports tokens, priced with the table below.
// Cost informs Routing and the Planner only; it never reaches the UI.
import type { ModelTier } from '../shared/api.ts';
import type { Usage } from './agent-runner.ts';
import { tierLabel } from './ladder.ts';
import type { CostHistoryRow, UsageRecord } from './store.ts';

// OpenAI API list prices, USD per million tokens (input / output), standard tier,
// prompts up to 272K tokens. Retrieved 2026-11-25 from
// https://developers.openai.com/api/docs/pricing (research/cost-and-quota.md).
export const CODEX_PRICES: Record<string, { input: number; output: number }> = {
  'gpt-6.2-astra': { input: 8, output: 40 },
  'gpt-6.2-sol': { input: 2, output: 10 },
  'gpt-6-astra': { input: 10, output: 50 },
  'gpt-6.1-sol': { input: 2, output: 10 },
  'gpt-6.1-terra': { input: 1, output: 5 },
  'gpt-6-sol': { input: 2, output: 10 },
  'gpt-6-luna': { input: 0.1, output: 0.5 },
  'gpt-5.6-sol': { input: 4, output: 20 },
  'gpt-5.6-terra': { input: 2, output: 12 },
  'gpt-5.6-luna': { input: 0.2, output: 1.2 },
  'gpt-5.5': { input: 5, output: 30 },
  'gpt-5.4': { input: 2.5, output: 15 },
  'gpt-5.4-mini': { input: 0.75, output: 4.5 },
  'gpt-5.3-codex': { input: 1.75, output: 14 },
};

// A Run's or Review's usage with its Cost; Cost is null when it cannot be priced.
export function priced(tier: ModelTier, usage: Usage): UsageRecord {
  const { inputTokens, outputTokens } = usage;
  if (tier.agent === 'claude') return { inputTokens, outputTokens, costUsd: usage.costUsd ?? null };
  const price = CODEX_PRICES[tier.model];
  const costUsd = price ? (inputTokens * price.input + outputTokens * price.output) / 1_000_000 : null;
  return { inputTokens, outputTokens, costUsd };
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

export type CostEstimate = { tier: ModelTier; run?: { usd: number; count: number }; review?: { usd: number; count: number } };

// The pre-run Cost estimate per Model Tier: the median of that tier's past Runs
// (and, separately, Reviews), in order of first appearance.
export function costEstimates(history: CostHistoryRow[]): CostEstimate[] {
  const byTier = new Map<string, { tier: ModelTier; run: number[]; review: number[] }>();
  for (const row of history) {
    const key = tierLabel(row.tier);
    const entry = byTier.get(key) ?? { tier: row.tier, run: [], review: [] };
    entry[row.kind].push(row.costUsd);
    byTier.set(key, entry);
  }
  return [...byTier.values()].map(({ tier, run, review }) => ({
    tier,
    ...(run.length ? { run: { usd: median(run), count: run.length } } : {}),
    ...(review.length ? { review: { usd: median(review), count: review.length } } : {}),
  }));
}

// A multiple of the base, to two significant figures: 1, 2, 0.15, 12.
const multiple = (usd: number, base: number) => `${Number((usd / base).toPrecision(2))}×`;

// The estimate as the Planner reads it when choosing each Ticket's Model Tier: relative
// Cost only, as multiples of the cheapest Run on record. Never dollars or token counts,
// so nothing the Planner writes back into a Plan can show the user a Cost.
export function costEstimateNote(history: CostHistoryRow[]): string | undefined {
  const estimates = costEstimates(history);
  const runCosts = estimates.flatMap((e) => (e.run && e.run.usd > 0 ? [e.run.usd] : []));
  if (runCosts.length === 0) return undefined;
  const base = Math.min(...runCosts);
  const lines = estimates.map(({ tier, run, review }) => {
    const parts = [run && `Run ${multiple(run.usd, base)}`, review && `Review ${multiple(review.usd, base)}`].filter(Boolean);
    return `- ${tierLabel(tier)}: ${parts.join(', ')}`;
  });
  return [
    'Relative Cost per Model Tier so far, as multiples of the cheapest Run on record. Use it to pick the cheapest capable tier; never repeat these figures to the user.',
    ...lines,
  ].join('\n');
}
